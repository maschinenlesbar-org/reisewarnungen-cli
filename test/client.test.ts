import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient, isWarned } from "../src/client/client.js";
import type { TravelWarning } from "../src/client/types.js";
import {
  ReiseApiError,
  ReiseError,
  ReiseNetworkError,
  ReiseNotFoundError,
  ReiseParseError,
  ReiseValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

/** The two flags every country entry must carry (booleans); fixtures spread it first. */
const F = { warning: false, partialWarning: false } as const;

function clientWith(mt: ReturnType<typeof makeMockTransport>): ReisewarnungenClient {
  return new ReisewarnungenClient({ transport: mt.transport });
}

const listBody = {
  response: {
    lastModified: 1700000000,
    "100": { ...F, countryName: "Atlantis", countryCode: "AT", warning: true },
    "200": { ...F, countryName: "Bukovia", countryCode: "BU", warning: false, partialWarning: true },
  },
};

test("the client rejects a non-http(s) base URL even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(listBody));
    assert.throws(
      () => new ReisewarnungenClient({ baseUrl, transport: mt.transport }),
      (err: unknown) =>
        err instanceof ReiseValidationError && !(err instanceof ReiseNetworkError),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("list unwraps the response object", async () => {
  const mt = makeMockTransport(() => jsonResponse(listBody));
  const res = await clientWith(mt).list();
  assert.equal(new URL(mt.last().url).pathname, "/opendata/travelwarning");
  assert.equal(res["lastModified"], 1700000000);
  assert.ok(res["100"]);
});

test("summaries flattens to an array with ids and drops lastModified", async () => {
  const mt = makeMockTransport(() => jsonResponse(listBody));
  const entries = await clientWith(mt).summaries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.id).sort(),
    ["100", "200"],
  );
  assert.equal(entries.find((e) => e.id === "100")?.countryName, "Atlantis");
});

test("summaries keeps the map key as id even when an entry carries its own id field", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ response: { "100": { ...F, countryName: "A", id: "555" } } }),
  );
  const entries = await clientWith(mt).summaries();
  assert.deepEqual(entries, [{ id: "100", ...F, countryName: "A" }]);
  assert.deepEqual(Object.keys(entries[0]!)[0], "id"); // id stays first
});

test("get builds the per-id path and unwraps the matching entry", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ response: { lastModified: 1, "226768": { ...F, countryName: "X", content: "<p>hi</p>" } } }),
  );
  const warning = await clientWith(mt).get("226768");
  assert.equal(new URL(mt.last().url).pathname, "/opendata/travelwarning/226768");
  assert.equal(warning.countryName, "X");
  assert.equal(warning.content, "<p>hi</p>");
});

test("get never returns a sole entry keyed by another id (a different country)", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({
      response: { lastModified: 1, "999": { ...F, countryName: "OtherCountry" }, contentList: ["999"] },
    }),
  );
  await assert.rejects(
    () => clientWith(mt).get("226768"),
    (err: unknown) =>
      err instanceof ReiseParseError &&
      err.message ===
        'Unexpected response shape from /opendata/travelwarning/226768: expected the entry for content id "226768", got country entries under other keys only.',
  );
});

test("get throws ReiseNotFoundError when the 200 response has no object entry", async () => {
  const mt = makeMockTransport(() => jsonResponse({ response: { lastModified: 1 } }));
  await assert.rejects(
    () => clientWith(mt).get("226768"),
    (err) => err instanceof ReiseNotFoundError && err.contentId === "226768" && err.status === 404,
  );
});

test("get and list reject a body that is not the response envelope (ReiseParseError)", async () => {
  // null, {}, another API's JSON, a response array: a broken or wrong-API answer,
  // never "not found" (exit 4) nor an untyped TypeError.
  for (const body of [null, {}, { data: { items: [] } }, { response: [1, 2] }, [1], "x"]) {
    const mt = makeMockTransport(() => jsonResponse(body));
    await assert.rejects(
      () => clientWith(mt).get("226768"),
      (err: unknown) =>
        err instanceof ReiseParseError &&
        err.message ===
          'Unexpected response shape from /opendata/travelwarning/226768: expected a JSON object with a "response" object.',
      JSON.stringify(body),
    );
    await assert.rejects(
      () => clientWith(mt).list(),
      (err: unknown) =>
        err instanceof ReiseParseError &&
        /^Unexpected response shape from \/opendata\/travelwarning: expected a JSON object/.test(err.message),
      JSON.stringify(body),
    );
  }
});

test("get does NOT return the wrong country when the response holds several other entries", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({
      response: {
        lastModified: 1,
        "111": { ...F, countryName: "Wrongland" },
        "222": { ...F, countryName: "Alsowrong" },
      },
    }),
  );
  await assert.rejects(() => clientWith(mt).get("226768"), ReiseParseError);
});

test("get returns the matching entry even when other entries are present", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({
      response: {
        lastModified: 1,
        "226768": { ...F, countryName: "Right", content: "<p>ok</p>" },
        "999": { ...F, countryName: "Other" },
      },
    }),
  );
  const warning = await clientWith(mt).get("226768");
  assert.equal(warning.countryName, "Right");
  assert.equal(warning.content, "<p>ok</p>");
});

test("a 404 raises ReiseApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).get("999999"),
    (err) => err instanceof ReiseApiError && err.status === 404,
  );
});

test("get rejects a non-numeric content id before any request (no dot segments)", async () => {
  for (const id of ["..", ".", "", " 1", "226768x", "%2e%2e", "__proto__", "１２"]) {
    const mt = makeMockTransport(() => jsonResponse({ response: {} }));
    await assert.rejects(
      () => clientWith(mt).get(id),
      (err: unknown) =>
        err instanceof ReiseError &&
        err.message === `Invalid contentId ${JSON.stringify(id)}. Expected a numeric content id (e.g. 226768).`,
      id,
    );
    assert.equal(mt.calls.length, 0, id);
  }
});

// ---- isWarned / summaries({ warnedOnly }) ---------------------------------------

const WARNING_FLAGS = ["warning", "partialWarning", "situationWarning", "situationPartWarning"] as const;

for (const flag of WARNING_FLAGS) {
  test(`isWarned is true for an entry warned only via ${flag}`, () => {
    assert.equal(isWarned({ [flag]: true }), true);
  });

  test(`summaries({ warnedOnly: true }) keeps a country warned only via ${flag}`, async () => {
    const mt = makeMockTransport(() =>
      jsonResponse({
        response: {
          lastModified: 1,
          "100": { ...F, countryName: "Flagged", [flag]: true },
          "200": { ...F, countryName: "Clear", warning: false },
        },
      }),
    );
    const entries = await clientWith(mt).summaries({ warnedOnly: true });
    assert.deepEqual(entries.map((e) => e.countryName), ["Flagged"]);
  });
}

test("isWarned is false when no flag is true, and only a real `true` counts", () => {
  assert.equal(isWarned({}), false);
  assert.equal(
    isWarned({ warning: false, partialWarning: false, situationWarning: false, situationPartWarning: false }),
    false,
  );
  // Malformed upstream values: a string "false" or a number 1 is not a warning.
  assert.equal(isWarned({ warning: "false" } as unknown as TravelWarning), false);
  assert.equal(isWarned({ warning: 1 } as unknown as TravelWarning), false);
});

test("summaries() and summaries({ warnedOnly: false }) return every country", async () => {
  const mt = makeMockTransport(() => jsonResponse(listBody));
  assert.equal((await clientWith(mt).summaries()).length, 2);
  assert.equal((await clientWith(mt).summaries({ warnedOnly: false })).length, 2);
});

test("summaries rejects a non-boolean warnedOnly before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse(listBody));
  await assert.rejects(
    clientWith(mt).summaries({ warnedOnly: "yes" as unknown as boolean }),
    (err: unknown) =>
      err instanceof ReiseValidationError &&
      err.message === "Invalid warnedOnly: Expected true or false.",
  );
  assert.equal(mt.calls.length, 0);
});

test("list and summaries reject a 2xx answer that holds no country (P9: never 'no warnings')", async () => {
  const lm = { lastModified: 1700000000 };
  const broken: unknown[] = [
    { response: {} },
    { response: { ...lm, contentList: [] } },
    { response: { error: "Service temporarily unavailable", ...lm } },
    { response: { ...listBody.response, error: { code: 503 } } },
    { response: { ...lm, contentList: ["100", "999"], "100": { ...F, countryName: "Atlantis", warning: true, partialWarning: false } } },
    { response: { ...lm, "100": "Atlantis" } },
  ];
  for (const body of broken) {
    for (const call of [(c: ReisewarnungenClient) => c.list(), (c: ReisewarnungenClient) => c.summaries({ warnedOnly: true })]) {
      const mt = makeMockTransport(() => jsonResponse(body));
      await assert.rejects(call(clientWith(mt)), ReiseParseError, JSON.stringify(body));
    }
  }
  // The error text is named.
  const mt = makeMockTransport(() => jsonResponse(broken[2]));
  await assert.rejects(clientWith(mt).summaries(), /Service temporarily unavailable/);
});

test("get reports an error envelope as a parse error, not as 'not found'", async () => {
  const mt = makeMockTransport(() => jsonResponse({ response: { error: "maintenance" } }));
  await assert.rejects(clientWith(mt).get("100"), (e: unknown) => e instanceof ReiseParseError && /maintenance/.test(e.message));
});

test("a non-boolean or missing warning flag is a parse error, on list, summaries and get (03#2)", async () => {
  for (const entry of [
    { countryName: "R", warning: "true", partialWarning: false },
    { countryName: "R", warning: 1, partialWarning: 0 },
    { countryName: "R", Warning: true },
    { countryName: "R", warning: false },
    { countryName: "R", warning: false, partialWarning: false, situationPartWarning: null },
  ]) {
    const body = { response: { lastModified: 1, "201536": entry } };
    for (const call of [
      (c: ReisewarnungenClient) => c.list(),
      (c: ReisewarnungenClient) => c.summaries({ warnedOnly: true }),
      (c: ReisewarnungenClient) => c.get("201536"),
    ]) {
      await assert.rejects(call(clientWith(makeMockTransport(() => jsonResponse(body)))), ReiseParseError, JSON.stringify(entry));
    }
  }
  // The situation flags may be absent.
  const ok = { response: { "1": { countryName: "Fine", warning: true, partialWarning: false } } };
  assert.equal((await clientWith(makeMockTransport(() => jsonResponse(ok))).summaries({ warnedOnly: true })).length, 1);
});

/** Characters the client's own messages never carry raw: C0, DEL, C1, U+2028/2029, bidi controls. */
const RAW_IN_MESSAGE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

test("server strings the client quotes in its own messages reach no terminal raw (ESC, OSC, C1, DEL, bidi)", async () => {
  const hostile = "Wartung\u001b]0;pwned\u0007 \u001b[2J\u001b[H x\u009b2J y\u007f z\u202eevil\u2066iso\nnext\u2028line";
  const cases: Array<[string, unknown, (c: ReisewarnungenClient) => Promise<unknown>]> = [
    ["list error envelope", { response: { error: hostile } }, (c) => c.list()],
    ["get error envelope", { response: { error: hostile } }, (c) => c.get("5")],
    ["flag error, countryName", { response: { "100": { countryName: hostile, warning: "true", partialWarning: false } } }, (c) => c.list()],
    ["flag error, value", { response: { "100": { countryName: "A", warning: hostile, partialWarning: false } } }, (c) => c.list()],
    ["contentList ids", { response: { "100": { ...F, countryName: "A" }, contentList: ["100", hostile] } }, (c) => c.list()],
  ];
  for (const [name, body, call] of cases) {
    const mt = makeMockTransport(() => jsonResponse(body));
    await assert.rejects(call(clientWith(mt)), (err: unknown) => {
      assert.ok(err instanceof ReiseParseError, name);
      assert.ok(!RAW_IN_MESSAGE.test(err.message), `${name}: ${JSON.stringify(err.message)}`);
      // The visible text survives; only the control and bidi characters are gone.
      assert.match(err.message, /Wartung/, name);
      return true;
    });
  }
});
