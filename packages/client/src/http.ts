// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { ReiseNetworkError, credentialsIn, redactCredentials, redactUrl, typedUrlCredentials } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Timeout for the whole request, response body included, in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline either way,
   * and enforces `maxResponseBytes` on the body it gets back, so neither limit depends on it.
   */
  signal?: AbortSignal;
  /**
   * Always `"manual"`: a transport must not follow redirects itself (`fetch(url, { redirect:
   * request.redirect })`). The engine follows them, with its own rules for which hop gets the
   * base URL's credentials. A transport that reports a final `url` on another origin anyway
   * makes the call fail.
   */
  redirect?: "manual";
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL the response came from, if the transport knows it (fetch's `response.url`).
   * When it is on another origin than the request's, the transport followed a redirect
   * itself and the engine rejects the response.
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) or with a mistyped one (`http//user:pw@host`) is read as a URL all the same
 * (`typedUrlCredentials`), since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, typedUrlCredentials(url));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs). The body is read up to `maxResponseBytes`;
 * small chunks are joined as they arrive, so the memory an answer holds follows its bytes, not
 * the number of chunks a server sends it in.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new ReiseNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${url.protocol}"` : "";
      reject(new ReiseNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // The timeout covers the whole exchange — connecting, waiting and reading the body.
    // A socket idle timeout alone would let a server that trickles a byte now and then
    // hold the request open indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject);

    // Node validates header names and values synchronously and throws a raw
    // TypeError (ERR_INVALID_CHAR) for an unsendable one; turn it into a typed
    // rejection. (The engine already refuses a bad userAgent when it is built.)
    let req: http.ClientRequest;
    try {
      req = driver.request(
        url,
        {
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them
          // or COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks
          // a server chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
          const chunks: Buffer[] = [];
          let pending: Buffer[] = [];
          let pendingBytes = 0;
          let received = 0;
          let aborted = false;

          res.on("data", (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (maxBytes !== undefined && received > maxBytes) {
              aborted = true;
              res.destroy();
              fail(new ReiseNetworkError(sizeLimitMessage(maxBytes)));
              return;
            }
            pending.push(chunk);
            pendingBytes += chunk.length;
            if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
              chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
              pending = [];
              pendingBytes = 0;
            }
          });
          res.on("end", () => {
            if (aborted) return;
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat([...chunks, ...pending]),
            });
          });
          res.on("error", (err) => {
            if (aborted) return; // we already rejected with the size-cap error
            fail(new ReiseNetworkError(`Response stream error: ${err.message}`, { cause: err }));
          });
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      reject(new ReiseNetworkError(`Invalid request: ${reason}`, { cause: err }));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const timeoutMs = request.timeoutMs;
      timer = setTimeout(() => {
        const err = new ReiseNetworkError(`Request timed out after ${timeoutMs}ms`);
        fail(err);
        req.destroy(err);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }

    if (request.signal !== undefined) {
      const signal = request.signal;
      const abort = (): void => {
        req.destroy(new ReiseNetworkError(`Request exceeded overall deadline of ${request.timeoutMs ?? 0}ms`));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an ReiseNetworkError; don't double-wrap.
      fail(err instanceof ReiseNetworkError ? err : new ReiseNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
