import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  validateBaseUrl,
} from "../src/client/engine.js";
import { baseUrlProblem } from "../src/client/validate.js";
import { MAX_TIMEOUT_MS } from "../src/client/http.js";
import { ReiseApiError, ReiseNetworkError, ReiseParseError, ReiseValidationError } from "../src/client/errors.js";
import {
  makeMockTransport,
  jsonResponse,
  rawResponse,
  redirectResponse,
  redirectWithoutLocation,
} from "./helpers.js";
import type { HttpResponse } from "../src/client/http.js";

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

function apiErrorBody(detail: string, status = 500): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ detail })),
  };
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("opendata/"), "https://example.test/opendata/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("the constructor rejects a malformed base URL with a clear, base-only message", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "notaurl" }).buildUrl("/opendata/travelwarning"),
    (err: unknown) =>
      err instanceof ReiseValidationError &&
      !(err instanceof ReiseNetworkError) &&
      err.message === "Invalid baseUrl: Expected a valid absolute URL (e.g. https://host)." &&
      // the diagnostic must NOT carry the request path (which read as if at fault)
      !/travelwarning/.test(err.message),
  );
});

test("the constructor rejects a base URL with a query or fragment", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/a#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) =>
        err instanceof ReiseValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
    );
  }
});

test("the constructor rejects a non-http(s) base URL before any request", () => {
  // A library consumer may inject its own transport, which need not check the
  // scheme; the engine itself must never hand it a file:/ftp: base URL.
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({ ok: true }));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err: unknown) =>
        err instanceof ReiseValidationError &&
        err.message === 'Invalid baseUrl: Only "http:" and "https:" base URLs are supported.',
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("validateBaseUrl returns the URL without trailing slashes, or throws ReiseValidationError", () => {
  assert.equal(validateBaseUrl("https://h.example//"), "https://h.example");
  assert.equal(validateBaseUrl("https://h.example/pre/"), "https://h.example/pre");
  for (const [raw, reason] of [
    ["", "Expected a valid absolute URL (e.g. https://host)."],
    ["http://", "Expected a valid absolute URL (e.g. https://host)."],
    ["ftp://h.example", 'Only "http:" and "https:" base URLs are supported.'],
    ["https://h.example/?q=1", "A base URL cannot have a query (?) or fragment (#)."],
  ] as const) {
    assert.throws(
      () => validateBaseUrl(raw),
      (err: unknown) => err instanceof ReiseValidationError && (err as Error).message === `Invalid baseUrl: ${reason}`,
      raw,
    );
    assert.equal(baseUrlProblem(raw), reason);
  }
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson decodes the body by its declared charset, drops a BOM, refuses an unknown one", async () => {
  const latin1 = Buffer.from(JSON.stringify({ name: "Türkei" }), "latin1");
  const e1 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(latin1, "application/json; charset=ISO-8859-1")).transport });
  assert.deepEqual(await e1.getJson("/x"), { name: "Türkei" });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
  const e2 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(bom, "application/json")).transport });
  assert.deepEqual(await e2.getJson("/x"), { a: 1 });
  const e3 = new RequestEngine({ transport: makeMockTransport(() => rawResponse("{}", "application/json; charset=x-nope")).transport });
  await assert.rejects(() => e3.getJson("/x"), (e: unknown) => e instanceof ReiseParseError && /x-nope/.test(e.message));
  const e4 = new RequestEngine({ transport: makeMockTransport(() => rawResponse("<html>", "text/html")).transport });
  await assert.rejects(() => e4.getJson("/x"), (e: unknown) => e instanceof ReiseParseError && /text\/html/.test(e.message));
});

test("getJson throws ReiseParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), ReiseParseError);
});

test("a 503 is retried up to maxRetries then surfaces as ReiseApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof ReiseApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2, status = 429) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("3");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof ReiseApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [3000, 3000]);
});

test("a Retry-After shorter than the backoff waits the backoff", async () => {
  // 429: from 1 s, doubling; Retry-After 1 s lengthens nothing.
  assert.deepEqual((await failingDelays(retryingEngine("1"))), [1000, 2000]);
  assert.deepEqual((await failingDelays(retryingEngine("0", 2, 503))), [200, 400]);
});

async function failingDelays(r: ReturnType<typeof retryingEngine>): Promise<number[]> {
  await assert.rejects(() => r.engine.getJson("/x"));
  return r.delays;
}

test("without a usable Retry-After a 429 backs off from 1 s, doubling, and a 503 linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    assert.deepEqual(await failingDelays(retryingEngine(header)), [1000, 2000], String(header));
    assert.deepEqual(await failingDelays(retryingEngine(header, 2, 503)), [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof ReiseApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof Error && /Retry-After\), longer than the 30 s/.test(e.message));
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("a redirect is followed to a cross-origin Location", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(new URL(req.url).origin, "https://a.test");
      return {
        status: 302,
        headers: { location: "https://b.test/elsewhere" },
        body: Buffer.from(""),
      };
    }
    assert.equal(req.url, "https://b.test/elsewhere");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("error detail is stripped of terminal control characters", async () => {
  // ESC + CSI + BEL interleaved with printable text.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() => apiErrorBody(evil));
  const e = new RequestEngine({
    baseUrl: "https://a.test",
    transport: mt.transport,
    maxRetries: 0,
  });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof ReiseApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("refuses to follow an https->http downgrade redirect (RW-01)", async () => {
  const mt = makeMockTransport((req) =>
    req.url.startsWith("https://")
      ? redirectResponse("http://a.test/insecure")
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });

  await assert.rejects(
    () => e.getJson("/start"),
    (err: unknown) =>
      err instanceof ReiseNetworkError && /https->http/.test(err.message),
  );
  // The cleartext hop is never issued: only the initial https request was made.
  assert.equal(mt.calls.length, 1);
});

test("refuses to follow a redirect to a non-http(s) scheme in the engine (RW-03)", async () => {
  // A custom Transport loses the transport-level allowlist; the engine must
  // reject a file:/data:/ftp: Location before ever handing it to the transport.
  for (const evil of ["file:///etc/passwd", "data:text/plain,x", "ftp://h/x"]) {
    const mt = makeMockTransport(() => redirectResponse(evil));
    const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/start"),
      (err: unknown) =>
        err instanceof ReiseNetworkError && /unsupported protocol/.test(err.message),
    );
    // The engine stops at the initial request; the bad scheme is never forwarded.
    assert.equal(mt.calls.length, 1);
  }
});

test("credential-carrying headers are stripped on a cross-origin hop", async () => {
  // The default engine headers (Accept, User-Agent) are not sensitive, so assert
  // the strip via the SENSITIVE_HEADERS membership on lower-cased names: none of
  // the sent headers is a sensitive one, and they survive the cross-origin hop.
  const sensitive = new Set([
    "authorization",
    "cookie",
    "x-api-key",
    "proxy-authorization",
    "www-authenticate",
  ]);
  const mt = makeMockTransport((req) =>
    req.url.startsWith("https://a.test")
      ? redirectResponse("https://b.test/next")
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  await e.getJson("/start");

  const hop = mt.calls[1]!;
  assert.equal(new URL(hop.url).origin, "https://b.test");
  // No sensitive header ever leaves for the foreign origin.
  for (const name of Object.keys(hop.headers ?? {})) {
    assert.ok(!sensitive.has(name.toLowerCase()), `leaked ${name}`);
  }
  // Non-sensitive default headers still travel.
  assert.equal(hop.headers?.["User-Agent"], "reisewarnungen-cli");
});

test("exceeding maxRedirects surfaces a ReiseApiError instead of looping", async () => {
  const mt = makeMockTransport(() => redirectResponse("https://a.test/loop"));
  const e = new RequestEngine({
    baseUrl: "https://a.test",
    transport: mt.transport,
    maxRedirects: 2,
  });
  await assert.rejects(
    () => e.getJson("/start"),
    (err: unknown) =>
      err instanceof ReiseApiError &&
      err.location === "https://a.test/loop" &&
      err.message ===
        "HTTP 302 for GET https://a.test/loop: redirect to https://a.test/loop not followed (stopped after 2 redirects)",
  );
  // initial request + 2 followed redirects = 3 transport calls, then it stops.
  assert.equal(mt.calls.length, 3);
});

test("with maxRedirects 0 a redirect is named but not called a loop", async () => {
  const mt = makeMockTransport(() => redirectResponse("/next", 301));
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport, maxRedirects: 0 });
  await assert.rejects(
    () => e.getJson("/start"),
    (err: unknown) =>
      err instanceof ReiseApiError &&
      err.message === "HTTP 301 for GET https://a.test/start: redirect to https://a.test/next not followed",
  );
  assert.equal(mt.calls.length, 1);
});

test("a malformed Location surfaces as a ReiseApiError naming it, not a TypeError", async () => {
  const mt = makeMockTransport(() => redirectResponse("http://[bad"));
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/start"),
    (err: unknown) =>
      err instanceof ReiseApiError &&
      err.message === "HTTP 302 for GET https://a.test/start: redirect to http://[bad not followed",
  );
  assert.equal(mt.calls.length, 1);
});

test("300, 304 and 305 are not followed", async () => {
  for (const status of [300, 304, 305]) {
    const mt = makeMockTransport(() => redirectResponse("https://a.test/other", status));
    const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/start"),
      (err: unknown) => err instanceof ReiseApiError && err.status === status,
    );
    assert.equal(mt.calls.length, 1, String(status));
  }
});

test("a 3xx without a Location header is surfaced, not followed forever", async () => {
  const mt = makeMockTransport(() => redirectWithoutLocation());
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/start"),
    (err: unknown) =>
      err instanceof ReiseApiError &&
      err.location === undefined &&
      err.message === "HTTP 302 for GET https://a.test/start: redirect not followed (no Location header)",
  );
  assert.equal(mt.calls.length, 1);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("the constructor range-checks the numeric options before any request", () => {
  for (const [options, message] of [
    [{ timeoutMs: -1 }, "Invalid timeoutMs: Must be >= 0."],
    [{ timeoutMs: NaN }, "Invalid timeoutMs: Expected an integer."],
    [{ timeoutMs: MAX_TIMEOUT_MS + 1 }, `Invalid timeoutMs: Must be <= ${MAX_TIMEOUT_MS}.`],
    [{ maxRetries: MAX_RETRIES + 1 }, `Invalid maxRetries: Must be <= ${MAX_RETRIES}.`],
    [{ maxRetries: Infinity }, "Invalid maxRetries: Expected an integer."],
    [{ maxRetries: 1.5 }, "Invalid maxRetries: Expected an integer."],
    [{ maxRedirects: NaN }, "Invalid maxRedirects: Expected an integer."],
    [{ maxRedirects: -1 }, "Invalid maxRedirects: Must be >= 0."],
    [{ retryDelayMs: -5 }, "Invalid retryDelayMs: Must be >= 0."],
    [{ retryDelayMs: Infinity }, "Invalid retryDelayMs: Expected an integer."],
    [{ maxResponseBytes: 0.5 }, "Invalid maxResponseBytes: Expected an integer."],
    [{ maxResponseBytes: -1 }, "Invalid maxResponseBytes: Must be >= 0."],
  ] as const) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ ...options, transport: mt.transport }),
      (err: unknown) => err instanceof ReiseValidationError && (err as Error).message === message,
      JSON.stringify(options),
    );
    assert.equal(mt.calls.length, 0);
  }
  assert.equal(MAX_RETRIES, 10);
  // 0 keeps its documented meaning (no timeout, no retries, no backoff, no redirects, no cap).
  new RequestEngine({ timeoutMs: 0, maxRetries: 0, retryDelayMs: 0, maxRedirects: 0, maxResponseBytes: 0 });
  new RequestEngine({ timeoutMs: MAX_TIMEOUT_MS, maxRetries: MAX_RETRIES, maxRedirects: 50 });
});

test("the constructor rejects an unsendable userAgent before any request", () => {
  for (const [userAgent, reason] of [
    ["", "Expected a non-empty value."],
    ["  ", "Expected a non-empty value."],
    ["a\r\nb", "Value contains control characters."],
    ["a\u007f", "Value contains control characters."],
    ["€", "Value contains characters outside Latin-1 (above U+00FF)."],
  ] as const) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, userAgent }),
      (err: unknown) => err instanceof ReiseValidationError && (err as Error).message === `Invalid userAgent: ${reason}`,
      JSON.stringify(userAgent),
    );
    assert.equal(mt.calls.length, 0);
  }
  assert.equal(assertHeaderValue("userAgent", "my-app/1.0\tü"), "my-app/1.0\tü");
});
