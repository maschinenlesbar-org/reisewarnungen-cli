import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient } from "../src/client/client.js";
import { ReiseApiError, ReiseNotFoundError } from "../src/client/errors.js";
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

test("get falls back to a sole entry when the id key is absent", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ response: { lastModified: 1, "999": { countryName: "Y" } } }),
  );
  const warning = await clientWith(mt).get("226768");
  assert.equal(warning.countryName, "Y");
});

test("get throws ReiseNotFoundError when the 200 response has no object entry", async () => {
  const mt = makeMockTransport(() => jsonResponse({ response: { lastModified: 1 } }));
  await assert.rejects(
    () => clientWith(mt).get("226768"),
    (err) => err instanceof ReiseNotFoundError && err.contentId === "226768" && err.status === 404,
  );
});

test("get throws ReiseNotFoundError when the response is an empty envelope", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  await assert.rejects(() => clientWith(mt).get("226768"), ReiseNotFoundError);
});

test("get does NOT return the wrong country when the response is ambiguous (multi-entry)", async () => {
  // The id is absent and there is more than one object entry: the old eager
  // firstEntry fallback would hand back an unrelated country; now it is a miss.
  const mt = makeMockTransport(() =>
    jsonResponse({
      response: {
        lastModified: 1,
        "111": { countryName: "Wrongland" },
        "222": { countryName: "Alsowrong" },
      },
    }),
  );
  await assert.rejects(() => clientWith(mt).get("226768"), ReiseNotFoundError);
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
