import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { execFileSync } from "node:child_process";
import {
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  assertHeaderValue,
  bigIntegerKeysOption,
  firstInexactNumber,
  parseRetryAfter,
  sanitizeServerText,
  scanNumbers,
  validateBaseUrl,
} from "../src/engine.js";
import { baseUrlProblem } from "../src/validate.js";
import { MAX_TIMEOUT_MS } from "../src/http.js";
import {
  ReiseApiError,
  ReiseNetworkError,
  ReiseParseError,
  ReiseValidationError,
  TextBuilder,
  credentialsIn,
  cutText,
  echoedCredentialForms,
  redactUrlUserinfo,
  toWellFormed,
} from "../src/errors.js";
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
      // ...whole escape sequences with them (not their printable rest), while the text stays.
      assert.equal(err.detail, "boomred");
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

test("an error's message and detail are scrubbed of a credential the server echoed behind a JSON escape", async () => {
  const base = "https://dummyuser:dummypass-0001@mirror.example";
  const basic = Buffer.from("dummyuser:dummypass-0001").toString("base64");
  const bodies = [
    '{"message":"wrong password dummypass\\u002d0001"}',
    `{"detail":"got Basic ${basic.slice(0, 4)}\\u00${basic.charCodeAt(4).toString(16)}${basic.slice(5)}"}`,
    '{"message":"bad login dummyuser\\u003adummypass-0001"}',
  ];
  for (const [i, body] of bodies.entries()) {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 401) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof ReiseApiError, String(err));
    const seen = [err.message, err.detail ?? "", JSON.stringify(JSON.parse(err.body))].join("\n");
    for (const secret of ["dummypass-0001", basic]) assert.ok(!seen.includes(secret), `${i}: ${seen}`);
    assert.ok(err.detail?.includes("***"), `${i}: ${err.detail}`);
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof ReiseApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays", () => {
  const pw = "s3cret-Pw-long";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example` });
  for (const at of [0, 190, 195, 199]) {
    const quoted = e.quoteServerValue(`${"x".repeat(at)}${pw}${"y".repeat(600)}`);
    assert.ok(!quoted.includes("s3cret"), `${at}: ${quoted}`);
  }
  // Without credentials it is serverTextForMessage: one line, no controls, cut.
  assert.equal(new RequestEngine().quoteServerValue(`a\n${ESC}[1mb`), "a b");
});

test("an echo of the base URL as WHATWG spells it is scrubbed, a short password too", async () => {
  // Typed raw; WHATWG writes the userinfo `alice:p%22%C3%A4`, which a server or proxy echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async () =>
      rawResponse(JSON.stringify({ message: "no access: https://alice:p%22%C3%A4@mirror.example/x" }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof ReiseApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a password the server echoes percent-encoded is scrubbed", async () => {
  const e = new RequestEngine({
    baseUrl: 'https://alice:pw"ä-long@mirror.example',
    maxRetries: 0,
    transport: async () => rawResponse(JSON.stringify({ message: "log in at /login?pw=pw%22%C3%A4-long" }), "application/json", 401),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof ReiseApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) assert.ok(!text.includes("%C3%A4-long"), text);
});

test("a number literal with a long run of zeros is checked in linear time, with the same verdicts", () => {
  // `/0+$/` tried a match at every zero of a run that doesn't end the digits: quadratic, and a
  // 100 KB answer held the CLI for seconds past --timeout (the scan runs once the answer is in).
  const zeros = "0".repeat(100_000);
  for (const literal of [`1.${zeros}1e300`, `1${zeros}1`, `0.${zeros}1e-400`, `-1${zeros}1`]) {
    const start = performance.now();
    const inexact = firstInexactNumber(`{"n":${literal}}`);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${literal.slice(0, 12)}…: ${Math.round(ms)} ms`);
    assert.equal(inexact, literal, literal.slice(0, 12));
  }
  // Leading and trailing zeros still don't count: these are the doubles they print as.
  for (const exact of ["9007199254740992000e-3", "1e23", "100000000000000000000000", "0.0", "-0e5", "5e-324", "0.000e-400"]) {
    assert.equal(firstInexactNumber(`[${exact}]`), undefined, exact);
  }
  for (const inexact of ["12345678901234567890", "3e-324", "1e-400", "1.0000000000000000000000001e300"]) {
    assert.equal(firstInexactNumber(`[${inexact}]`), inexact, inexact);
  }
});

function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs", () => {
  // The URL regex this replaces (a scheme tried at every word start) takes seconds on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole; an unterminated run of introducers is linear.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
  for (const introducer of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", `${ESC}]`]) {
    assert.ok(elapsed(() => sanitizeServerText(introducer.repeat(100_000))) < 1000, JSON.stringify(introducer));
  }
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

const STARTS_A_PROCESS = { timeout: 30_000 };

/** Run `script` (an ES module importing the built engine as `engine`) under a 128 MB heap; its stdout. */
function underSmallHeap(script: string): string {
  const engine = new URL("../src/engine.js", import.meta.url).href;
  return execFileSync(
    process.execPath,
    ["--max-old-space-size=128", "--input-type=module", "-e", `const engine = await import(${JSON.stringify(engine)});${script}`],
    { encoding: "utf8" },
  );
}

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const n = 3_000_000;
  const out = underSmallHeap(
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
      `process.stdout.write(String(engine.scanNumbers(json, new Set(["k"])).json.length));`,
  );
  assert.equal(out, String(n * 10 + 1));
});

test("a 16 MB error detail and millions of lone surrogate escapes are handled within a small heap", STARTS_A_PROCESS, () => {
  // sanitizeServerText cleaned the whole detail one `+=` per character before the cut, and
  // wellFormedEscapes made one rope node per repair: either aborted a 128 MB heap.
  const out = underSmallHeap(
    `const answer = (status, body) => () => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(body) });` +
      `const big = new engine.RequestEngine({ maxRetries: 0, maxResponseBytes: 0, transport: answer(500, JSON.stringify({ detail: "x".repeat(16 * 1024 * 1024) })) });` +
      `const err = await big.getJson("/x").catch((e) => e);` +
      `const lone = new engine.RequestEngine({ maxResponseBytes: 0, transport: answer(200, '"' + "\\\\ud800".repeat(6_000_000) + '"') });` +
      `const text = await lone.getJson("/x");` +
      `process.stdout.write(err.status + " " + err.message.length + " " + text.length + " " + (text.charCodeAt(0) === 0xfffd));`,
  );
  const [status, length, repaired, fffd] = out.split(" ");
  assert.equal(status, "500");
  assert.ok(Number(length) < 1000, length);
  assert.equal(repaired, "6000000");
  assert.equal(fffd, "true");
});

test("a password with an inner space is scrubbed whole, never word by word", async () => {
  // jobsuche-cli scrubbed such a key only from its second word on; here the password is one
  // exact string in every form (the Basic value, `user:password`, the password alone).
  const e = new RequestEngine({
    baseUrl: "https://alice:my%20s3cret%20Pw@mirror.example",
    maxRetries: 0,
    transport: async () => rawResponse(JSON.stringify({ message: "denied: my s3cret Pw / alice:my s3cret Pw" }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof ReiseApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body, e.quoteServerValue("got my s3cret Pw")]) {
    assert.ok(!/my|s3cret|Pw/.test(text.replace(/mirror/g, "")), text);
  }
});

test("a credential echoed in a redirect's Location never names the request in a message (D2)", async () => {
  // The engine follows redirects: every message about the request after one named the followed
  // URL through redactUrl only, which drops the URL's own userinfo but not the base URL's
  // credentials in its path or query; a Location not followed or refused was resolved before
  // any scrub, and ReiseApiError.location kept it.
  const pw = "pä\"s's-W0rd";
  const base = `https://alice:${encodeURIComponent(pw)}@mirror.example`;
  const basic = Buffer.from(`alice:${pw}`, "utf8").toString("base64");
  const secrets = [pw, `alice:${pw}`, basic];
  const leaks = (text: string): boolean => {
    const decoded = text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    return secrets.some((secret) => decoded.includes(secret));
  };
  const locations = [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(pw)}`,
    `https://elsewhere.example/login?pw=${pw}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${pw}`)}/x`,
    `https://elsewhere.example/auth?basic=${basic}`,
    `/relative/${pw}`,
  ];
  const redirect = (location: string): HttpResponse => ({ status: 302, headers: { location }, body: Buffer.from("") });
  for (const location of locations) {
    // A loop (past maxRedirects the 3xx is the error), an error answer, a refused connection
    // after one redirect, a 3xx not followed at all (maxRedirects 0), a 300 naming the target.
    const cases: Array<[number, (n: number) => HttpResponse]> = [
      [5, () => redirect(location)],
      [5, (n) => (n === 0 ? redirect(location) : jsonResponse({}, 401))],
      [
        5,
        (n) => {
          if (n === 0) return redirect(location);
          throw Object.assign(new Error("socket hang up"), { code: "ECONNREFUSED" });
        },
      ],
      [0, () => redirect(location)],
      [5, () => ({ status: 300, headers: { location }, body: Buffer.from("") })],
    ];
    for (const [maxRedirects, answer] of cases) {
      let n = 0;
      const e = new RequestEngine({ baseUrl: base, maxRetries: 1, maxRedirects, sleep: async () => {}, transport: async () => answer(n++) });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof Error, String(err));
      const e2 = err as Error & { url?: string; location?: string };
      for (const text of [err.message, e2.url ?? "", e2.location ?? ""]) assert.ok(!leaks(text), `${location}: ${text}`);
    }
    // onRetry names the request after the redirect as messages do.
    let n = 0;
    const retries: string[] = [];
    await new RequestEngine({
      baseUrl: base,
      maxRetries: 1,
      sleep: async () => {},
      onRetry: (event) => retries.push(event.url),
      transport: async () => (n++ === 0 ? redirect(location) : jsonResponse({}, 503)),
    })
      .getJson("/x")
      .catch(() => undefined);
    assert.equal(retries.length, 1);
    assert.ok(!leaks(retries[0] ?? ""), `${location}: ${retries[0]}`);
  }
  // A refused redirect (another scheme, https→http) names its target scrubbed.
  for (const location of [`ftp://elsewhere.example/${encodeURIComponent(pw)}`, `http://elsewhere.example/?pw=${pw}`]) {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => redirect(location) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof ReiseNetworkError && /^Refusing to follow/.test(err.message), String(err));
    assert.ok(!leaks(err.message), err.message);
  }
});

test("a credential echoed in the Content-Type, Content-Encoding or charset a message quotes is scrubbed", async () => {
  // The engine quoted these response headers sanitised but not scrubbed.
  const pw = "s3cret-Pw";
  const base = `https://alice:${pw}@mirror.example`;
  const answers: HttpResponse[] = [
    { status: 200, headers: { "content-type": `text/x-${pw}; charset=utf-8` }, body: Buffer.from("<html>") },
    { status: 200, headers: { "content-type": "application/json", "content-encoding": `gzip, x-${pw}` }, body: Buffer.from("{}") },
    { status: 200, headers: { "content-type": `application/json; charset=${pw}` }, body: Buffer.from("{}") },
  ];
  for (const answer of answers) {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => answer });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof ReiseParseError, String(err));
    assert.ok(!err.message.includes(pw) && err.message.includes("***"), err.message);
  }
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a token as the base URL's user name is scrubbed from errors in every form a server echoes it", async () => {
  // Without a password the user name is the secret, and Node sends it as Basic `TOKEN:`.
  const token = "T0kenS3cret";
  const basic = Buffer.from(`${token}:`, "utf8").toString("base64");
  for (const base of [`https://${token}@mirror.example`, `https://${token}:@mirror.example`]) {
    for (const echo of [`bad token ${token}`, `Authorization: Basic ${basic}`, `user ${token}: unknown`]) {
      const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => jsonResponse({ message: echo }, 401) });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof ReiseApiError, String(err));
      for (const text of [err.message, err.detail ?? "", err.body]) {
        assert.ok(!text.includes(token) && !text.includes(basic), `${base} ${echo}: ${text}`);
      }
    }
  }
});

test("a base URL with a backslash, or whose scheme is not followed by // and the host, is refused, never echoing the password (F, F4)", () => {
  // WHATWG ends an http(s) authority at "\" and repairs `http:host`, `http:/host`, `http:///host`
  // silently into `http://host`: the host requested is not the one typed.
  const f4 = 'Expected an absolute http(s) URL ("https://" and the host).';
  const backslash = 'A base URL cannot contain a backslash (\\); write "/" instead.';
  for (const [baseUrl, reason] of [
    ["https://alice:s3cret@api.example\\@evil.example", backslash],
    ["https://api.example\\evil", backslash],
    ["http:alice:s3cret@h.example", f4],
    ["https:/alice:s3cret@h.example", f4],
    ["http:///alice:s3cret@h.example", f4],
    ["HTTPS:h.example/v1", f4],
    ["https:\\\\alice:s3cret@h.example", backslash],
  ] as const) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) => err instanceof ReiseValidationError && err.message === `Invalid baseUrl: ${reason}` && !err.message.includes("s3cret"),
      baseUrl,
    );
    assert.equal(mt.calls.length, 0, baseUrl);
  }
  // A spelling the parser keeps as typed stays accepted: an upper-case scheme, an explicit port.
  for (const baseUrl of ["HTTPS://h.example/v1", "http://alice:pw@h.example:8080"]) {
    assert.doesNotThrow(() => new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, baseUrl }), baseUrl);
  }
});

test("credentialsIn ends the authority of a special scheme at a backslash, and skips the slashes WHATWG skips (F, F3)", () => {
  for (const scheme of ["http", "https", "HTTPS", "ws", "wss", "ftp"]) {
    assert.deepEqual(credentialsIn(`${scheme}://u:p@a.example\\@b.example/x`), ["u:p"], scheme);
    assert.equal(new URL(`${scheme}://u:p@a.example\\@b.example/x`).password, "p", scheme);
  }
  // Another scheme's authority runs on to "/", "?" or "#".
  assert.deepEqual(credentialsIn("foo://u:p@a.example\\@b.example/x"), ["u:p@a.example\\"]);
  assert.deepEqual(credentialsIn("https://u:p@a.example/x\\@y"), ["u:p"]);
  // `http:///u:pw@h`, `https:\\u:pw@h` and `http:u:pw@h` all carry `u:pw` for WHATWG.
  for (const value of [
    "http:alice:pw@h.example",
    "http:/alice:pw@h.example",
    "http:///alice:pw@h.example/x",
    "https:////alice:pw@h.example",
    "HTTPS:\\\\alice:pw@h.example",
    "wss:\\/alice:pw@h.example",
    "ftp:alice:pw@h.example",
  ]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
    assert.equal(new URL(value).password, "pw", value);
  }
  // Another scheme needs "//" before an authority: `foo:u:p@h` and `foo:///u:p@h` carry none.
  assert.deepEqual(credentialsIn("foo:u:p@h.example"), []);
  assert.deepEqual(credentialsIn("foo:///u:p@h.example"), []);
});

test("requests go to the host of the parsed base URL, spelled as it parses, an @ in its path included (F)", async () => {
  for (const base of ["https://alice:pw@api.example/v1/@evil.example", "https://API.Example:443/v1"]) {
    const parsed = new URL(base);
    const mt = makeMockTransport(() => jsonResponse({}));
    await new RequestEngine({ baseUrl: base, transport: mt.transport }).getJson("/x");
    const sent = mt.last().url;
    assert.equal(new URL(sent).origin, parsed.origin, `${base}: ${sent}`);
    assert.equal(sent.slice(sent.indexOf("//") + 2).split("/")[0], parsed.host, `${base}: ${sent}`);
  }
});
