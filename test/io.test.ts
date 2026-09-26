import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors } from "../src/cli/io.js";
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

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setupStreams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
  );
  return { stdout, stderr, exits };
}

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = setupStreams();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr exits 0 as well", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("another stderr write error exits 1", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});
