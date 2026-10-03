import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { ReiseError, ReiseValidationError } from "../src/client/errors.js";
import { ReisewarnungenClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, jsonResponse } from "./helpers.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

function throwingDeps(error: Error) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {} },
    createClient: () => {
      throw error;
    },
  };
  return { deps, out, err };
}

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("contentId", "226768", nonBlank), "226768");
});

test("assertValid throws ReiseValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("contentId", "  ", nonBlank),
    (err: unknown) =>
      err instanceof ReiseValidationError &&
      err instanceof ReiseError &&
      err.name === "ReiseValidationError" &&
      err.message === "Invalid contentId: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.ReiseValidationError, ReiseValidationError);
});

test("run() maps a ReiseValidationError raised in an action to the usage exit 1, 'Error: <message>'", async () => {
  const cli = throwingDeps(new ReiseValidationError("Invalid thing: Expected a non-empty value."));
  assert.equal(await run(["list"], cli.deps), 1);
  assert.deepEqual(cli.err, ["Error: Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(cli.out, []);
});

test("run() still maps a plain ReiseError to exit 1", async () => {
  const cli = throwingDeps(new ReiseError("boom"));
  assert.equal(await run(["list"], cli.deps), 1);
  assert.deepEqual(cli.err, ["Error: boom"]);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const body = { response: { lastModified: 1, "100": { countryName: "Atlantis", warning: true } } };
  const { cli, lib: l } = await parity(
    ["--compact", "countries"],
    (transport) => new ReisewarnungenClient({ transport }).summaries(),
    () => jsonResponse(body),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests.length, 1);
  assert.equal(l.ok, true);
  assert.equal(l.requests.length, 1);
  assert.equal(cli.requests[0]!.url, l.requests[0]!.url);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});
