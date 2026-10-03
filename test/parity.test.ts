// CLI <-> library parity: the same input through run() and through the library
// call on one recording mock transport must give the same outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient } from "../src/client/client.js";
import { ReiseNetworkError, ReiseValidationError } from "../src/client/errors.js";
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

// ---- Finding #2 (PAT-5): the User-Agent value ----------------------------------

const badUserAgents: Array<[string, RegExp]> = [
  ["", /^Invalid userAgent: Expected a non-empty value\.$/],
  ["   ", /^Invalid userAgent: Expected a non-empty value\.$/],
  ["a\r\nX-Evil: 1", /^Invalid userAgent: Value contains control characters\.$/],
  ["a\u0000b", /^Invalid userAgent: Value contains control characters\.$/],
  ["a\u007f", /^Invalid userAgent: Value contains control characters\.$/],
  ["€-agent", /^Invalid userAgent: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/],
];

for (const [ua, message] of badUserAgents) {
  test(`parity: User-Agent ${JSON.stringify(ua)} is rejected by CLI and library alike`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "list"],
      (transport) => new ReisewarnungenClient({ transport, userAgent: ua }).list(),
      () => jsonResponse(listBody),
    );
    assertBothReject(cli, lib, message);
  });
}

test("parity: a tab and Latin-1 in the User-Agent are sent identically by CLI and library", async () => {
  const ua = "my-app/1.0\tü";
  const { cli, lib } = await parity(
    ["--compact", "--user-agent", ua, "list"],
    (transport) => new ReisewarnungenClient({ transport, userAgent: ua }).list(),
    () => jsonResponse(listBody),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.ok(lib.ok);
  assert.deepEqual(cli.requests, lib.requests);
  assert.equal(lib.requests[0]!.headers?.["User-Agent"], ua);
});

// ---- Finding #4 (PAT-2): the base URL ------------------------------------------

const badBaseUrls: Array<[string, string]> = [
  ["ftp://h.example", 'Only "http:" and "https:" base URLs are supported.'],
  ["https://h.example/?q=1", "A base URL cannot have a query (?) or fragment (#)."],
  ["https://h.example/#f", "A base URL cannot have a query (?) or fragment (#)."],
  ["", "Expected a valid absolute URL (e.g. https://host)."],
  ["http://", "Expected a valid absolute URL (e.g. https://host)."],
  ["notaurl", "Expected a valid absolute URL (e.g. https://host)."],
];

for (const [baseUrl, reason] of badBaseUrls) {
  test(`parity: base URL ${JSON.stringify(baseUrl)} is rejected by CLI and library with one message`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "list"],
      (transport) => new ReisewarnungenClient({ baseUrl, transport }).list(),
      () => jsonResponse(listBody),
    );
    const escaped = reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assertBothReject(cli, lib, new RegExp(`^Invalid baseUrl: ${escaped}$`));
    assert.ok(!(!lib.ok && lib.error instanceof ReiseNetworkError), "not a network error");
    assert.ok(cli.err.includes(reason), cli.err);
  });
}

for (const baseUrl of ["https://h.example//", "https://h.example/pre"]) {
  test(`parity: base URL ${JSON.stringify(baseUrl)} sends the identical request from CLI and library`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "list"],
      (transport) => new ReisewarnungenClient({ baseUrl, transport }).list(),
      () => jsonResponse(listBody),
    );
    assert.equal(cli.code, 0, cli.err);
    assert.ok(lib.ok);
    assert.deepEqual(cli.requests, lib.requests);
  });
}
