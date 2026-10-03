// CLI <-> library parity: the same input through run() and through the library
// call on one recording mock transport must give the same outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient } from "../src/client/client.js";
import { parity, jsonResponse } from "./helpers.js";

// ---- countries --warned-only == summaries({ warnedOnly: true }) ----------------

const flagsBody = {
  response: {
    lastModified: 1700000000,
    "101": { countryName: "Full", warning: true },
    "102": { countryName: "Partial", partialWarning: true },
    "103": { countryName: "Situation", situationWarning: true },
    "104": { countryName: "SituationPart", situationPartWarning: true },
    "105": {
      countryName: "Clear",
      warning: false,
      partialWarning: false,
      situationWarning: false,
      situationPartWarning: false,
    },
  },
};

// Malformed flag values: only a real `true` counts as a warning.
const malformedBody = {
  response: {
    lastModified: 1700000000,
    "201": { countryName: "StringFalse", warning: "false" },
    "202": { countryName: "NumberOne", warning: 1 },
    "203": { countryName: "Zero", warning: 0, partialWarning: null },
  },
};

for (const [label, body, ids] of [
  ["realistic", flagsBody, ["101", "102", "103", "104"]],
  ["malformed", malformedBody, []],
] as const) {
  test(`parity: countries --warned-only == summaries({ warnedOnly: true }) (${label} body)`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "countries", "--warned-only"],
      (transport) => new ReisewarnungenClient({ transport }).summaries({ warnedOnly: true }),
      () => jsonResponse(body),
    );
    assert.equal(cli.code, 0, cli.err);
    assert.ok(lib.ok);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
    assert.deepEqual(JSON.parse(cli.out), lib.value);
    assert.deepEqual((lib.value as { id: string }[]).map((e) => e.id), ids);
  });
}

test("parity: countries without --warned-only == summaries() (every country)", async () => {
  const { cli, lib } = await parity(
    ["--compact", "countries"],
    (transport) => new ReisewarnungenClient({ transport }).summaries(),
    () => jsonResponse(flagsBody),
  );
  assert.equal(cli.code, 0);
  assert.ok(lib.ok);
  assert.deepEqual(JSON.parse(cli.out), lib.value);
  assert.equal((lib.value as unknown[]).length, 5);
});
