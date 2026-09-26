import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient } from "../src/client/client.js";
import {
  ReiseApiError,
  ReiseNetworkError,
  ReiseNotFoundError,
  ReiseParseError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): ReisewarnungenClient {
  return new ReisewarnungenClient({ transport: mt.transport });
}

const listBody = {
  response: {
    lastModified: 1700000000,
    "100": { countryName: "Atlantis", countryCode: "AT", warning: true },
    "200": { countryName: "Bukovia", countryCode: "BU", warning: false, partialWarning: true },
  },
};

test("the client rejects a non-http(s) base URL even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(listBody));
    assert.throws(
      () => new ReisewarnungenClient({ baseUrl, transport: mt.transport }),
      (err: unknown) =>
        err instanceof ReiseNetworkError && /Unsupported protocol/.test(err.message),
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

test("get builds the per-id path and unwraps the matching entry", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ response: { lastModified: 1, "226768": { countryName: "X", content: "<p>hi</p>" } } }),
  );
  const warning = await clientWith(mt).get("226768");
  assert.equal(new URL(mt.last().url).pathname, "/opendata/travelwarning/226768");
  assert.equal(warning.countryName, "X");
  assert.equal(warning.content, "<p>hi</p>");
});

test("get never returns a sole entry keyed by another id (a different country)", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({
      response: { lastModified: 1, "999": { countryName: "OtherCountry" }, contentList: ["999"] },
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
        "111": { countryName: "Wrongland" },
        "222": { countryName: "Alsowrong" },
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
        "226768": { countryName: "Right", content: "<p>ok</p>" },
        "999": { countryName: "Other" },
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
    () => clientWith(mt).get("nope"),
    (err) => err instanceof ReiseApiError && err.status === 404,
  );
});
