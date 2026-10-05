// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  ReiseApiError,
  ReiseError,
  ReiseNetworkError,
  ReiseParseError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerValueProblem, intInRangeProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.auswaertiges-amt.de";

/** Most retries `maxRetries` may ask for (each may wait up to MAX_RETRY_AFTER_MS). */
export const MAX_RETRIES = 10;
const DEFAULT_USER_AGENT = "reisewarnungen-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.auswaertiges-amt.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header: non-blank Latin-1 without control characters
   * (tab allowed). Defaults to "reisewarnungen-cli".
   */
  userAgent?: string;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms, the largest timer
   * Node supports); 0 disables. Defaults to 30 s.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits the response's `Retry-After`
   * (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried), or else
   * `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), a non-negative
   * integer; used without a Retry-After. Defaults to 200.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, a non-negative
   * integer (0 follows none). Defaults to 5. Any other 3xx, one with a missing or
   * malformed Location, and one past this limit surface as a ReiseApiError naming
   * the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  // A numeric string ("200") is what some hand-written transports return; accept it.
  const status = typeof r.status === "string" && /^\d{3}$/.test(r.status) ? Number(r.status) : r.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties: the
 * engine then saw no Retry-After, Location or Content-Type at all. Such an object
 * (anything with `get` and `forEach`, a `Map` included) is copied into a record; a plain
 * record gets its names lower-cased, as the engine reads them.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Retry-After").
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** A single header value: the first of an array, undefined for anything but a string. */
function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a ReiseNetworkError caused by a reset or aborted connection, which the engine
 * retries — whichever transport raised it (a Node error, fetch's TypeError with an undici
 * cause). A refused connection, a DNS failure or a timeout is not transient in that sense
 * and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof ReiseNetworkError && hasTransientCode(err.cause);
}

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a ReiseApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Headers stripped on a cross-origin redirect (lower-cased for comparison). */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "proxy-authorization",
  "www-authenticate",
]);

/**
 * Strip control characters out of a string that originates in an
 * attacker-controlled response — the error `detail` and the echoed Content-Type.
 * `JSON.parse` decodes an escaped ESC in an error body into a real ESC byte, so
 * without this a hostile or MITM'd endpoint could drive ANSI/OSC escape sequences
 * into the user's terminal when the message is printed to stderr (display
 * spoofing, title changes). Drops all C0/C1 controls and DEL (0x7f-0x9f); tab and
 * newline are intentionally preserved. This only covers text flowing into an
 * error message; the CLI's JSON output is escaped separately (escapeControlChars
 * in cli/shared.ts), since `JSON.stringify` alone leaves DEL and the C1 range raw.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Check a base URL against the library's rules (baseUrlProblem: an absolute
 * http(s) URL, no query or fragment) and return it without trailing slashes.
 * Throws ReiseValidationError `Invalid baseUrl: …`: a configuration mistake, not
 * a ReiseNetworkError. The RequestEngine constructor calls it on the raw value, so
 * a custom transport never sees a bad base URL; the default transport still
 * re-checks the scheme on every hop.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Check a value bound for an HTTP header (headerValueProblem) and return it, or
 * throw a ReiseValidationError (`Invalid <name>: Value contains control characters.`).
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/**
 * A numeric engine option: `fallback` when undefined, else an integer in 0..max, or
 * a ReiseValidationError (`Invalid <name>: ...`). A negative, NaN or fractional
 * value would otherwise silently disable the timeout or the size cap, and NaN or
 * Infinity would leave retries or redirects unbounded.
 */
export function intOption(name: string, value: number | undefined, max: number, fallback: number): number {
  return value === undefined ? fallback : assertValid(name, value, intInRangeProblem(0, max));
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages use describe(), which redacts it.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The base URL's userinfo as a Basic `Authorization` value, or undefined. The engine attaches
   * it per hop, only to requests on the base URL's origin; the URL a transport sees carries no
   * userinfo.
   */
  readonly #authorization: string | undefined;
  /** The base URL's origin (scheme, host and port). */
  readonly #origin: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    const baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    const parsed = new URL(baseUrl);
    this.#origin = parsed.origin;
    this.#authorization =
      parsed.username === "" && parsed.password === ""
        ? undefined
        : `Basic ${Buffer.from(`${decodeUserinfo(parsed.username)}:${decodeUserinfo(parsed.password)}`).toString("base64")}`;
    this.#baseUrl = withoutUserinfo(baseUrl);
    this.#credentials = credentialsIn(baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only undefined selects the default; a blank or unsendable value is refused
    // here rather than sent blank or failing late with Node's raw TypeError.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    // Range-check the numeric options before any request (see intOption).
    const anyInt = Number.MAX_SAFE_INTEGER;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, 30_000);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, anyInt, 200);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, anyInt, 5);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      anyInt,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) {
      return cause;
    }
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host that
   * gave a bad answer), userinfo redacted.
   */
  private describe(url: string): string {
    return redactUrl(url);
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new ReiseNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    // Only an idempotent request is sent again after a reset: request() is public, and a
    // POST re-sent may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // Why a 401/403 after a redirect may not be the credentials' fault, if it isn't.
    let credentialsDropped: string | undefined;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      // The base URL's credentials go only to its own origin, on every hop: a same-origin
      // redirect (relative or absolute) keeps them, any other origin never sees them.
      const hopHeaders =
        this.#authorization !== undefined && new URL(url).origin === this.#origin
          ? { ...headers, Authorization: this.#authorization }
          : headers;
      let raw: HttpResponse;
      try {
        raw = await this.callTransport({
          method,
          url,
          headers: hopHeaders,
          redirect: "manual",
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset: retry the GET like a 503, whichever
        // transport reported it. Timeouts are not retried — --timeout bounds each attempt.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        // The default transport rejects with ReiseNetworkError only; an injected one may
        // throw anything. Keep the library's contract — every failure is a ReiseError: a
        // network failure is re-raised naming the request, with the original as `cause`;
        // any other ReiseError passes through.
        if (cause instanceof ReiseError && !(cause instanceof ReiseNetworkError)) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new ReiseNetworkError(
          `${method} ${this.describe(url)} failed: ${sanitizeServerText(this.scrub(reason))}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface as a raw TypeError, outside the ReiseError contract.
      const invalid = responseProblem(raw);
      if (invalid !== undefined) {
        throw new ReiseNetworkError(
          `${method} ${this.describe(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport must not follow redirects itself (fetch does by default): one that did
      // and reports a final URL on another origin has sent the request (and possibly the
      // credentials) where the engine's redirect rules would not have.
      const finalOrigin = originOf((raw as { url?: unknown }).url);
      if (finalOrigin !== undefined && finalOrigin !== new URL(url).origin) {
        throw new ReiseNetworkError(
          `${method} ${this.describe(url)} failed: the transport followed a redirect to another origin ` +
            `(${redactUrl(finalOrigin)}); transports must not follow redirects (HttpRequest.redirect is "manual").`,
        );
      }
      const status = Number(raw.status);
      const responseHeaders = plainHeaders(raw.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy). (HttpResponse types the
      // body as Buffer; a JavaScript transport may not.)
      const body = bodyBytes(raw.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new ReiseNetworkError(`${method} ${this.describe(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }

      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const location = headerValue(responseHeaders["location"]);
      const next = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      if (next !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, body, location, redirects || undefined);
      }
      if (next !== undefined) {
        const from = new URL(url);
        const to = next;
        // Enforce the http(s)-only allowlist for the redirect target in the
        // engine itself, not only in the default transport: a library consumer
        // supplying a custom transport must not be handed a file:/data:/ftp: URL
        // taken from an attacker-controllable Location header.
        if (to.protocol !== "https:" && to.protocol !== "http:") {
          throw new ReiseNetworkError(
            `Refusing to follow a redirect to an unsupported protocol "${to.protocol}": ${redirectTarget(url, to.href) ?? ""}`,
          );
        }
        // Refuse to follow a redirect that downgrades the connection security
        // from https to http: the rest of the exchange would proceed in cleartext,
        // letting an on-path attacker tamper the (safety-relevant) travel-warning data.
        if (from.protocol === "https:" && to.protocol === "http:") {
          throw new ReiseNetworkError(
            `Refusing to follow an insecure https->http redirect to ${redirectTarget(url, to.href) ?? ""}`,
          );
        }
        // Credential-strip guard: on a cross-origin redirect, drop any
        // sensitive headers so credentials are never leaked to another host.
        if (to.origin !== from.origin) {
          for (const name of Object.keys(headers)) {
            if (SENSITIVE_HEADERS.has(name.toLowerCase())) delete headers[name];
          }
        }
        // Credentials a server puts into its Location are never sent: only the base URL's
        // own, and only to its origin (attached per hop above).
        to.username = "";
        to.password = "";
        if (this.#authorization !== undefined && to.origin !== this.#origin) {
          credentialsDropped =
            from.protocol === "http:" && to.protocol === "https:" && from.host === to.host
              ? "the server redirected http→https, and the base URL's credentials are only sent to its own origin; use an https base URL"
              : `the redirect to ${to.origin} did not carry the base URL's credentials (they are only sent to ${redactUrl(this.#origin)})`;
        }
        url = to.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a ReiseApiError naming the target.

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        const hint = (status === 401 || status === 403) && credentialsDropped !== undefined ? credentialsDropped : undefined;
        throw this.toApiError(method, url, status, body, location, undefined, hint);
      }

      return { data: body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new ReiseParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    redirectsFollowed?: number,
    hint?: string,
  ): ReiseApiError {
    // The body may echo the request URL; keep the base URL's credentials out of it.
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new ReiseApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location !== undefined ? { location } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
      ...(hint !== undefined ? { hint } : {}),
    });
  }
}

/** A userinfo part percent-decoded as Node decodes it for Basic auth (baseUrlProblem rules out bad escapes). */
function decodeUserinfo(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** `url` with its userinfo (`user:pw@`) cut out, the rest exactly as written. */
function withoutUserinfo(url: string): string {
  const [userinfo] = credentialsIn(url);
  const start = url.indexOf("://") + 3;
  if (userinfo === undefined || !url.startsWith(`${userinfo}@`, start)) return url;
  return url.slice(0, start) + url.slice(start + userinfo.length + 1);
}

/** The origin of a URL a transport reported, or undefined when there is none or it doesn't parse. */
function originOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, control characters stripped (it is server text bound for stderr). An
 * unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  // A Location may carry credentials of its own (`https://bob:pw@other/`): never print them.
  const clean = sanitizeServerText(redactUrl(resolved ? resolved.href : location)).trim();
  return clean === "" ? undefined : clean;
}
