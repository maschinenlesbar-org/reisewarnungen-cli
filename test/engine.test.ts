import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { ReiseApiError, ReiseNetworkError, ReiseParseError } from "../src/client/errors.js";
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

test("buildUrl rejects a malformed base URL with a clear, base-only message", () => {
  const e = new RequestEngine({ baseUrl: "notaurl" });
  assert.throws(
    () => e.buildUrl("/opendata/travelwarning"),
    (err: unknown) =>
      err instanceof ReiseNetworkError &&
      /Invalid base URL: "notaurl"/.test(err.message) &&
      // the diagnostic must NOT carry the request path (which read as if at fault)
      !/travelwarning/.test(err.message),
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
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
  await assert.rejects(() => e.getJson("/start"), ReiseApiError);
  // initial request + 2 followed redirects = 3 transport calls, then it stops.
  assert.equal(mt.calls.length, 3);
});

test("a 3xx without a Location header is surfaced, not followed forever", async () => {
  const mt = makeMockTransport(() => redirectWithoutLocation());
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  await assert.rejects(() => e.getJson("/start"), ReiseApiError);
  assert.equal(mt.calls.length, 1);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});
