import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO } from "../src/cli/io.js";
import { ReiseError } from "../src/client/errors.js";

test("writeFile names a directory instead of suggesting --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "reisewarnungen-io-"));
  try {
    for (const force of [false, true]) {
      assert.throws(
        () => defaultIO.writeFile(dir, Buffer.from("x"), force),
        (err: unknown) =>
          err instanceof ReiseError &&
          err.message === `"${dir}" is a directory; give a file path to --output.`,
        `force=${force}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile still refuses an existing file with EEXIST and overwrites with force", () => {
  const dir = mkdtempSync(join(tmpdir(), "reisewarnungen-io-"));
  try {
    const file = join(dir, "a.json");
    defaultIO.writeFile(file, Buffer.from("one"), false);
    assert.throws(
      () => defaultIO.writeFile(file, Buffer.from("two"), false),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EEXIST",
    );
    defaultIO.writeFile(file, Buffer.from("two"), true);
    assert.equal(readFileSync(file, "utf8"), "two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
