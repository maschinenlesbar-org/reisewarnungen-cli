import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors, stderrAfterStdout } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";
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

test("EPIPE on stderr is ignored, so the run's own exit code stands", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, []);
});

test("ENOTCONN (stdout a socket whose reader has gone) counts as EPIPE on both streams", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("ENOTCONN"));
  assert.deepEqual(s.exits, []);
  s.stdout.emit("error", writeError("ENOTCONN"));
  assert.deepEqual(s.exits, [0]);
});

test("another stderr write error exits 1", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});

test("a stdout write error other than a closed pipe is an ERROR record of reisewarnungen.output, in the run's format, and exits 1", () => {
  // Only a reader that has gone is a success; EBADF, ENOSPC or EIO means the output is incomplete.
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => exits.push(code), log);
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "reisewarnungen.output", msg: "Could not write to stdout: write EBADF" },
  ]);
  assert.deepEqual(written, []);
});

test("without a logger, a stdout write error is a text ERROR record on the streams' stderr", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => exits.push(code));
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /^\S+Z ERROR \[reisewarnungen\.output\] Could not write to stdout: write EBADF\n$/);
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});
