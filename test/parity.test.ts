// CLI <-> library parity: the same input through run() and through the library
// call on one recording mock transport must give the same outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient } from "../src/client/client.js";
import { ReiseValidationError } from "../src/client/errors.js";
import type { EngineOptions } from "../src/client/engine.js";
import { parity, jsonResponse, type CliOutcome, type LibOutcome } from "./helpers.js";

const listBody = { response: { lastModified: 1, "100": { countryName: "Atlantis", warning: true } } };

/** Both sides reject the input with no request; the library with a ReiseValidationError. */
function assertBothReject(cli: CliOutcome, lib: LibOutcome, message: RegExp): void {
  assert.equal(cli.code, 1, cli.err);
  assert.deepEqual(cli.requests, []);
  assert.equal(lib.ok, false);
  assert.deepEqual(lib.requests, []);
  if (!lib.ok) {
    assert.ok(lib.error instanceof ReiseValidationError, String(lib.error));
    assert.match((lib.error as Error).message, message);
  }
}

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

// ---- Finding #3 (PAT-8): the engine's numeric limits ---------------------------

const engineOptionCases: Array<[string[], EngineOptions, RegExp]> = [
  [["--timeout", "-1"], { timeoutMs: -1 }, /^Invalid timeoutMs: Must be >= 0\.$/],
  [["--timeout", "NaN"], { timeoutMs: NaN }, /^Invalid timeoutMs: Expected an integer\.$/],
  [["--timeout", "1.5"], { timeoutMs: 1.5 }, /^Invalid timeoutMs: Expected an integer\.$/],
  [["--timeout", "2147483648"], { timeoutMs: 2_147_483_648 }, /^Invalid timeoutMs: Must be <= 2147483647\.$/],
  [["--max-retries", "11"], { maxRetries: 11 }, /^Invalid maxRetries: Must be <= 10\.$/],
  [["--max-retries", "100"], { maxRetries: 100 }, /^Invalid maxRetries: Must be <= 10\.$/],
  [["--max-retries", "Infinity"], { maxRetries: Infinity }, /^Invalid maxRetries: Expected an integer\.$/],
  [["--max-retries", "-1"], { maxRetries: -1 }, /^Invalid maxRetries: Must be >= 0\.$/],
  [["--max-redirects", "NaN"], { maxRedirects: NaN }, /^Invalid maxRedirects: Expected an integer\.$/],
  [["--max-redirects", "Infinity"], { maxRedirects: Infinity }, /^Invalid maxRedirects: Expected an integer\.$/],
  [["--max-redirects", "1.5"], { maxRedirects: 1.5 }, /^Invalid maxRedirects: Expected an integer\.$/],
  [["--max-redirects", "-1"], { maxRedirects: -1 }, /^Invalid maxRedirects: Must be >= 0\.$/],
  [["--max-response-bytes", "-1"], { maxResponseBytes: -1 }, /^Invalid maxResponseBytes: Must be >= 0\.$/],
  [["--max-response-bytes", "NaN"], { maxResponseBytes: NaN }, /^Invalid maxResponseBytes: Expected an integer\.$/],
  [["--max-response-bytes", "1.5"], { maxResponseBytes: 1.5 }, /^Invalid maxResponseBytes: Expected an integer\.$/],
];

for (const [flags, options, message] of engineOptionCases) {
  test(`parity: an out-of-range engine option is rejected by CLI and library alike (${flags.join(" ")})`, async () => {
    const { cli, lib } = await parity(
      ["--compact", ...flags, "list"],
      (transport) => new ReisewarnungenClient({ ...options, transport }).list(),
      () => jsonResponse(listBody),
    );
    assertBothReject(cli, lib, message);
  });
}

test("parity: in-range engine options send the identical request from CLI and library", async () => {
  const { cli, lib } = await parity(
    ["--compact", "--timeout", "0", "--max-retries", "10", "--max-redirects", "0", "--max-response-bytes", "0", "list"],
    (transport) =>
      new ReisewarnungenClient({ timeoutMs: 0, maxRetries: 10, maxRedirects: 0, maxResponseBytes: 0, transport }).list(),
    () => jsonResponse(listBody),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.ok(lib.ok);
  assert.deepEqual(cli.requests, lib.requests);
  assert.deepEqual(JSON.parse(cli.out), lib.value);
});
