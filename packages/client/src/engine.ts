// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
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
  ReiseValidationError,
  MAX_QUOTED_LENGTH,
  credentialsIn,
  cutForMessage,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";
import { assertKnownKeys, assertValid, baseUrlProblem, headerValueProblem, intInRangeProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.auswaertiges-amt.de";

/** Most retries `maxRetries` may ask for (each may wait up to MAX_RETRY_AFTER_MS). */
export const MAX_RETRIES = 10;
const DEFAULT_USER_AGENT = "reisewarnungen-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  /** The Content-Encoding header ("" when absent). */
  contentEncoding: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.auswaertiges-amt.de */
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header: non-blank Latin-1 without control characters
   * (tab allowed). Defaults to "reisewarnungen-cli".
   */
  userAgent?: string | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms, the largest timer
   * Node supports); 0 disables. Defaults to 30 s.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections, an integer 0..`MAX_RETRIES` (10); defaults to 2. Each waits the
   * backoff — `retryDelayMs * attempt`, or for a 429 at least 1 s, doubling per
   * attempt (at most 30 s) — or longer when the response's `Retry-After` asks for
   * it, never shorter. A `Retry-After` above `MAX_RETRY_AFTER_MS` is not retried.
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly; a 429 waits at
   * least 1 s, doubling), an integer 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200.
   */
  retryDelayMs?: number | undefined;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, a non-negative
   * integer (0 follows none). Defaults to 5. Any other 3xx, one with a missing or
   * malformed Location, and one past this limit surface as a ReiseApiError naming
   * the target.
   */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `reisewarnungen.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a Solr `_version_`, a 64-bit id). The value
   * of a declared member is delivered as its exact literal, as written, as a JSON string (`"5"`),
   * so its type never depends on its size. A declared member whose value is not a number (a
   * string, `null`, an object) is left as it is. Every undeclared number keeps the rule: exact,
   * or a ReiseParseError. Matched by name anywhere in a JSON answer, an escaped name
   * (`"\u005fversion_"`) included. Defaults to none (the travel-warning API's numbers are
   * Unix-second timestamps, far below 2^53); anything but a set or list of non-empty strings makes
   * the constructor throw a ReiseValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Every EngineOptions key; any other key makes the constructor throw. */
const ENGINE_OPTION_NAMES = [
  "baseUrl",
  "transport",
  "userAgent",
  "timeoutMs",
  "maxRetries",
  "retryDelayMs",
  "maxRedirects",
  "maxResponseBytes",
  "sleep",
  "onRetry",
  "onWarning",
  "bigIntegerKeys",
] as const satisfies ReadonlyArray<keyof EngineOptions>;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Shortest wait before retrying a 429. */
const MIN_RATE_LIMIT_DELAY_MS = 1_000;

/**
 * The backoff before retry `attempt` of a 429: from 1 s (or retryDelayMs, if larger),
 * doubling per attempt, at most MAX_RETRY_AFTER_MS. The linear 200/400 ms of a 503 barely
 * backs off from a rate limit, and only adds load to a public service that has just asked
 * for less.
 */
function rateLimitDelay(retryDelayMs: number, attempt: number): number {
  return Math.min(Math.max(retryDelayMs, MIN_RATE_LIMIT_DELAY_MS) * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS);
}

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
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Retry-After").
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
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

/** True for U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069: the bidi controls. */
export function isBidiControl(n: number): boolean {
  return n === 0x061c || n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
}

/**
 * Server text that one of the client's own messages quotes — the text of an error
 * envelope sent with a 2xx status, a country name, a malformed flag value, the ids a
 * `contentList` names without an entry — made safe and short: whitespace (line breaks,
 * U+2028/U+2029 included) folded to one space, so it stays on one line; control
 * characters (`sanitizeServerText`: C0, DEL, C1) and the bidi controls dropped, so no
 * escape sequence reaches a terminal; trimmed and cut at `max` characters (`MAX_QUOTED_LENGTH`, 200), ending
 * in "…" when cut, never inside a surrogate pair (`cutForMessage`).
 */
export function serverTextForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  let clean = "";
  for (const ch of sanitizeServerText(text.replace(/\s+/g, " "))) {
    if (!isBidiControl(ch.codePointAt(0) ?? 0)) clean += ch;
  }
  return cutForMessage(clean.trim(), max);
}

/** Longest server text (in characters) an error message keeps; `ReiseApiError.body` keeps all. */
const MAX_DETAIL_LENGTH = 500;

/** `text` cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair), ending in "…" when cut. */
function cutServerText(text: string): string {
  return cutForMessage(text, MAX_DETAIL_LENGTH);
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

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a
 * warning (the message of the CLI's WARN record), or `undefined` when they would not: for
 * `https:`, for a URL that does not parse, and for a loopback host (`localhost`,
 * 127.0.0.0/8, `::1`), where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries
 * userinfo, and every phrase in `secrets` (noun phrases such as "the API key"; the
 * travel-warning API takes none, so the CLI passes none). It never contains a
 * password. The CLI logs it once per run as a WARN record of `reisewarnungen.http` on stderr.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
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

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function is a ReiseValidationError. A string `transport` used to fail at the first request
 * as a raw TypeError, and a bad `sleep` on the first retry.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new ReiseValidationError(`Invalid ${name}: Expected a function, got ${value === null ? "null" : typeof value}.`);
  }
  return value;
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a ReiseValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new ReiseValidationError("Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
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
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
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
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    assertKnownKeys("client options", options, ENGINE_OPTION_NAMES);
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
    this.#echoed = credentialsIn(baseUrl)
      .flatMap(echoedCredentialForms)
      .sort((a, b) => b.length - a.length);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only undefined selects the default; a blank or unsendable value is refused
    // here rather than sent blank or failing late with Node's raw TypeError.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    // Range-check the numeric options before any request (see intOption).
    const anyInt = Number.MAX_SAFE_INTEGER;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, 30_000);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, MAX_RETRY_AFTER_MS, 200);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, anyInt, 5);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      anyInt,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry = options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning = options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport
   * text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
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
    if (message === cause.message && inner === cause.cause && this.scrub(cause.stack ?? "") === (cause.stack ?? "")) {
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
    return cutServerText(redactUrl(url));
  }

  /**
   * The URL of a request for `path` (and `query`) as error messages show it: absolute, userinfo
   * redacted, cut at 500 characters. The client's own errors about an answer start with
   * `GET <this>: `, like the engine's, so a message names the host that gave a bad answer.
   */
  describeUrl(path: string, query?: QueryParams): string {
    return this.describe(this.buildUrl(path, query));
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
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        // The default transport rejects with ReiseNetworkError only; an injected one may
        // throw anything. Keep the library's contract — every failure is a ReiseError: a
        // network failure is re-raised naming the request, with the original as `cause`;
        // any other ReiseError passes through.
        if (cause instanceof ReiseError && !(cause instanceof ReiseNetworkError)) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new ReiseNetworkError(
          `${method} ${this.describe(url)} failed: ${cutServerText(sanitizeServerText(this.scrub(reason)))}`,
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
      let retryHint: string | undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off: doubling from 1 s for a 429, linear from retryDelayMs for a 503. A
        // Retry-After can ask for longer, never for less: `Retry-After: 0` or a date in the
        // past turned the retries into a zero-delay burst against a server that had just
        // asked for less load. One beyond MAX_RETRY_AFTER_MS is not retried: the error below
        // surfaces at once and names the wait.
        const backoff = status === 429 ? rateLimitDelay(this.retryDelayMs, attempt + 1) : this.retryDelayMs * (attempt + 1);
        const retryAfter = parseRetryAfter(headerValue(responseHeaders["retry-after"]));
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.backOff(attempt, Math.max(retryAfter ?? 0, backoff), url, status);
          continue;
        }
        retryHint =
          `the server asked to wait ${Math.ceil(retryAfter / 1000)} s (Retry-After), longer than the ` +
          `${MAX_RETRY_AFTER_MS / 1000} s the client waits, so it did not retry; retrying sooner won't help`;
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
        const hint =
          (status === 401 || status === 403) && credentialsDropped !== undefined ? credentialsDropped : retryHint;
        throw this.toApiError(method, url, status, body, location, undefined, hint);
      }

      const contentEncoding = String(headerValue(responseHeaders["content-encoding"]) ?? "");
      return { data: body, contentType, contentEncoding, status };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. The body is decoded by the charset
   * its Content-Type names (UTF-8 when it names none; see decodeBody). An empty (or
   * whitespace-only) body is a ReiseParseError: every endpoint answers with a JSON document.
   * Every error about the answer names the request (`GET <url>: …`, userinfo redacted).
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    // The client sends no Accept-Encoding and does not decompress; a compressed body can
    // only come from a misbehaving proxy. Name it rather than fail as "not JSON".
    // A list of codings is allowed (RFC 9110 §8.4); only `identity` ones mean "not encoded".
    const codings = res.contentEncoding.split(",").map((c) => c.trim()).filter((c) => c !== "");
    if (codings.some((c) => !/^identity$/i.test(c))) {
      throw new ReiseParseError(
        `${request}: unsupported Content-Encoding "${cutForMessage(sanitizeServerText(res.contentEncoding))}" (the client does not decompress responses).`,
      );
    }
    const decoded = decodeBody(res.data, res.contentType, request);
    if (decoded.text.trim() === "") {
      // A broken answer, not "no results": printed as nothing with exit 0, it would let a
      // script carry on as if the API had found nothing.
      throw new ReiseParseError(`${request}: empty response body.`);
    }
    const repaired = wellFormedEscapes(decoded.text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type, so it
      // reads as an upstream problem rather than a client bug.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cutForMessage(sanitizeServerText(type))}")` : "";
      throw new ReiseParseError(`${request}: the answer is not valid JSON${hint}.`, { cause });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    if (inexact !== undefined) {
      throw new ReiseParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
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
    if (detail !== undefined) detail = cutServerText(sanitizeServerText(detail));
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

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names none).
 * TextDecoder drops a leading byte order mark, which Buffer#toString keeps and JSON.parse
 * then rejects, so a BOM added by a proxy cannot turn a valid answer into a parse error. A
 * declared `charset=iso-8859-1` body used to come out as `T\uFFFDrkei`. An unknown charset
 * label is a ReiseParseError naming `request`. Bytes that are not valid in the charset become
 * U+FFFD, and `replaced` counts them: exactly for UTF-8 and the single-byte charsets; for UTF-16
 * a U+FFFD the server sent counts too.
 */
function decodeBody(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new ReiseParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch {
    // Not valid in the charset: decode with replacement, and count what was replaced.
    const text = new TextDecoder(decoder.encoding).decode(body);
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  let out = "";
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out += json.slice(copied, i) + "\\ufffd";
    copied = i + 6;
    replaced++;
    i += 5;
  }
  return replaced === 0 ? { json, replaced } : { json: out + json.slice(copied), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
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
  const clean = cutServerText(sanitizeServerText(redactUrl(resolved ? resolved.href : location)).trim());
  return clean === "" ? undefined : clean;
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
