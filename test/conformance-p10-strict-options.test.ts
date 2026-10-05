// Conformance test P10 (fix plan 2026-10-06, decision 5): the library rejects unknown option
// keys and wrong value types instead of ignoring them. reisewarnungen has no filter
// parameters beyond summaries({ warnedOnly }); the shared marktstammdatenregister test did not
// exist yet when this was written, so this file covers the repo's own option objects.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { ReisewarnungenClient as Client } from "../src/client/client.js";
import { ReiseValidationError as ValidationError } from "../src/client/errors.js";
const okBody = { response: { lastModified: 1, contentList: ["1"], "1": { countryName: "Atlantis", warning: true, partialWarning: false } } };
/** Calls whose options must be rejected before any request. */
const badCalls: Array<[string, (c: Client) => Promise<unknown>]> = [
  ["misspelt warnedonly", (c) => c.summaries({ warnedonly: true } as never)],
  ["__proto__ key", (c) => c.summaries(JSON.parse('{"__proto__": {"warnedOnly": true}}') as never)],
  ["constructor key", (c) => c.summaries({ constructor: true } as never)],
  ["null options", (c) => c.summaries(null as never)],
  ["array options", (c) => c.summaries([] as never)],
  ["warnedOnly as an array", (c) => c.summaries({ warnedOnly: [true] } as never)],
  ["warnedOnly NaN", (c) => c.summaries({ warnedOnly: Number.NaN } as never)],
];
/** Client options that must be rejected by the constructor. */
const badOptions: unknown[] = [{ timeout: 5 }, { baseurl: "https://h" }, JSON.parse('{"__proto__": {}}'), "https://h"];
// --------------------------------------------------------------------------------------

function client(): { c: Client; requests: () => number } {
  let n = 0;
  const transport = async (): Promise<HttpResponse> => {
    n++;
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  };
  return { c: new Client({ transport }), requests: () => n };
}

test("P10: unknown option keys and wrong value types are rejected before any request", async () => {
  for (const [label, fn] of badCalls) {
    const { c, requests } = client();
    await assert.rejects(fn(c), ValidationError, label);
    assert.equal(requests(), 0, label);
  }
});

test("P10: the client constructor rejects unknown option keys", () => {
  for (const options of badOptions) {
    assert.throws(() => new Client(options as never), ValidationError, JSON.stringify(options));
  }
  // A key set to undefined (a spread config) changes nothing.
  assert.doesNotThrow(() => new Client({ timeoutMs: undefined }));
  assert.doesNotThrow(() => new Client(null as never));
});

test("P10: a misspelt key names the right one", async () => {
  const { c } = client();
  await assert.rejects(c.summaries({ warnedonly: true } as never), /did you mean warnedOnly/);
});
