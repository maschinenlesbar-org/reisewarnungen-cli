// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { ReiseApiError, ReiseNetworkError, ReiseParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://www.auswaertiges-amt.de";
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
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

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

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    // Validate the base URL up front so a malformed `baseUrl` (e.g. a stray
    // `--base-url notaurl`) yields a clear message naming the offending value,
    // instead of an opaque "Invalid URL" that carries the full request path and
    // reads as if the path were at fault.
    try {
      new URL(this.baseUrl);
    } catch {
      throw new ReiseNetworkError(`Invalid base URL: ${JSON.stringify(this.baseUrl)}`);
    }
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && redirects < this.maxRedirects) {
        const location = response.headers["location"];
        if (typeof location === "string" && location.length > 0) {
          const from = new URL(url);
          const to = new URL(location, url);
          // Enforce the http(s)-only allowlist for the redirect target in the
          // engine itself, not only in the default transport. The CLI always uses
          // nodeHttpTransport (which also rejects non-http(s) schemes), but
          // Transport is a public injection seam: a library consumer supplying a
          // custom transport must not be handed a file:/data:/ftp: URL taken from
          // an attacker-controllable Location header.
          if (to.protocol !== "https:" && to.protocol !== "http:") {
            throw new ReiseNetworkError(
              `Refusing to follow a redirect to an unsupported protocol "${to.protocol}": ${to.toString()}`,
            );
          }
          // Refuse to follow a redirect that downgrades the connection security
          // from https to http. `new URL(location, url)` would happily accept an
          // absolute `http://...` Location, and the rest of the exchange would
          // then proceed in cleartext even though the user targeted an https URL
          // — letting an on-path attacker tamper the (safety-relevant)
          // travel-warning data. Fail closed with a typed error instead.
          if (from.protocol === "https:" && to.protocol === "http:") {
            throw new ReiseNetworkError(
              `Refusing to follow an insecure https->http redirect to ${to.toString()}`,
            );
          }
          // Credential-strip guard: on a cross-origin redirect, drop any
          // sensitive headers so credentials are never leaked to another host.
          // The default headers (Accept, User-Agent) carry nothing sensitive,
          // but this future-proofs against an Authorization/Cookie header being
          // added by a consumer or subclass.
          if (to.origin !== from.origin) {
            for (const name of Object.keys(headers)) {
              if (SENSITIVE_HEADERS.has(name.toLowerCase())) delete headers[name];
            }
          }
          url = to.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
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

  private toApiError(method: string, url: string, status: number, body: Buffer): ReiseApiError {
    const text = body.toString("utf8");
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
    return new ReiseApiError({ status, url, method, body: text, detail });
  }
}
