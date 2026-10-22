import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import {
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  bigIntegerKeysOption,
  firstInexactNumber,
  parseRetryAfter,
  scanNumbers,
  validateBaseUrl,
} from "../src/engine.js";
import { baseUrlProblem } from "../src/validate.js";
import { MAX_TIMEOUT_MS } from "../src/http.js";
import { ReiseApiError, ReiseNetworkError, ReiseParseError, ReiseValidationError, cutText, toWellFormed } from "../src/errors.js";
import {
  makeMockTransport,
  jsonResponse,
  rawResponse,
  redirectResponse,
  redirectWithoutLocation,
} from "./helpers.js";
import type { HttpResponse } from "../src/http.js";

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

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: a double has fewer digits below 2.2250738585072014e-308 (D4): 3e-324 became 5e-324.
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/opendata/travelwarning/1"), (err: unknown) => {
      assert.ok(err instanceof ReiseParseError, n);
      assert.equal(err.message, `GET https://www.auswaertiges-amt.de/opendata/travelwarning/1: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
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

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  const detail = "a" + "\u{1f600}".repeat(400);
  const engine = new RequestEngine({ transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail })) }) });
  await assert.rejects(engine.getJson("/opendata/travelwarning"), (err: Error) => {
    assert.equal(toWellFormed(err.message), err.message);
    assert.match(err.message, /…$/);
    return true;
  });
});

test("own messages quote a server value at most 200 characters long (L3)", async () => {
  const long = "x".repeat(5000);
  const redirect = new RequestEngine({ maxRedirects: 0, transport: async () => ({ status: 302, headers: { location: `https://other.example/${long}` }, body: Buffer.alloc(0) }) });
  await assert.rejects(redirect.getJson("/opendata/travelwarning"), (err: Error) => err.message.length < 400 && /redirect to https:\/\/other\.example\/x+… not followed/.test(err.message));
});

test("the Content-Type and charset a parse error names are cut at 200 characters (B2)", async () => {
  const long = "X".repeat(14000);
  const html = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `text/html${long}` }, body: Buffer.from("<html>") }) });
  await assert.rejects(html.getJson("/opendata/travelwarning"), (err: Error) =>
    err instanceof ReiseParseError && err.message.length < 400 && /got Content-Type "text\/htmlX+…"/.test(err.message));
  const charset = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=x${long}` }, body: Buffer.from("{}") }) });
  await assert.rejects(charset.getJson("/opendata/travelwarning"), (err: Error) =>
    err instanceof ReiseParseError && err.message.length < 400 && /unsupported response charset "xX+…"/.test(err.message));
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // The engine sends the pair UTF-8 encoded, so that is the form a server echoes.
  const basic = Buffer.from("alice:pä ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ message: `no: Basic ${basic} / alice:pä ss-pw / pä ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:p%C3%A4%20ss-pw@127.0.0.1",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof ReiseApiError);
    for (const form of [basic, "alice:pä ss-pw", "pä ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.equal(events.length, 2);
  for (const [i, ev] of events.entries()) {
    const { url, ...rest } = ev as { url: string };
    assert.deepEqual(rest, i === 0 ? { retry: 1, maxRetries: 3, delayMs: 2000, status: 503 } : { retry: 2, maxRetries: 3, delayMs: 400, status: 503 });
    assert.ok(url.endsWith("example.test/x") && !url.includes("pw"), url);
  }
});

test("onRetry reports a 429 with its longer wait and a reset connection without a status", async () => {
  const events: { status?: number; delayMs: number; retry: number }[] = [];
  let n = 0;
  const mt = makeMockTransport(() => {
    if (n++ === 0) return { status: 429, headers: {}, body: Buffer.from("{}") };
    if (n === 2) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 2);
  assert.deepEqual({ status: events[0]?.status, delayMs: events[0]?.delayMs, retry: events[0]?.retry }, { status: 429, delayMs: 1000, retry: 1 });
  assert.equal(events[1]?.status, undefined);
  assert.equal(events[1]?.retry, 2);
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), ReiseApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), ReiseApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), ReiseApiError);
  assert.equal(events.length, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const e = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({}))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await e.getJson("/x");
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), ReiseValidationError);
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("<html>") }) });
  // With the prototype set, "text/html" was read as the Content-Type and named in the message.
  await assert.rejects(e.getJson("/x"), (err: Error) => err instanceof ReiseParseError && !err.message.includes("text/html"));
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
    ["unsupported Content-Encoding", () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "br" }, body: Buffer.from("{}") })],
  ];
  const base = new URL("https://www.auswaertiges-amt.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/opendata/travelwarning", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof ReiseParseError, what);
      // The engine sends the userinfo as a header, so the URL it names carries none at all.
      assert.ok(err.message.startsWith(`GET ${base.protocol}//${base.host}/`), err.message);
      assert.ok(err.message.includes("/opendata/travelwarning?q=x: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret") && !err.message.includes("alice"), err.message);
      return true;
    });
  }
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof ReiseValidationError && err.message === "Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/opendata/travelwarning", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.auswaertiges-amt.de/opendata/travelwarning?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), ReiseValidationError);
});

test("an answer longer than V8's longest string is a ReiseParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"response":{"1":{}}}   ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/opendata/travelwarning"), (err: unknown) => {
    assert.ok(err instanceof ReiseParseError, String(err));
    assert.equal(
      err.message,
      `GET https://www.auswaertiges-amt.de/opendata/travelwarning: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof ReiseApiError && err.status === 500 && err.body === "");
});
