// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object, and the
// `-o` file through OutputFiles, so tests can capture output instead of hitting the real
// stdout/stderr and file system.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ReiseError, cutForMessage } from "@maschinenlesbar.org/reisewarnungen-client/internal/errors";
import type { ReisewarnungenClient } from "@maschinenlesbar.org/reisewarnungen-client/internal/client";
import type { EngineOptions } from "@maschinenlesbar.org/reisewarnungen-client/internal/engine";
import { createLogger, type Logger } from "./log.js";

/**
 * Writing the output failed: the `-o` file (a full disk, a file that appeared during the
 * request, EACCES), or an answer too deeply nested to print. Logged as an ERROR of
 * `reisewarnungen.output`, exit 1.
 */
export class OutputError extends ReiseError {}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EngineOptions): ReisewarnungenClient;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
  /** Where `-o` writes. Unset, the real file system (`nodeFiles`). */
  files?: OutputFiles;
}

/** The file seam for `-o` (checkOutputTarget and renderJson in shared.ts). */
export interface OutputFiles {
  /** What is at `path`: nothing, a directory, or anything else (a file, a link: a dangling one too). */
  state(path: string): "absent" | "directory" | "exists";
  /**
   * Write `data` to `path` atomically: the old file stays as it was until the new one is
   * complete. Without `overwrite` an existing path is refused, checked by an exclusive create
   * that closes the race with a file appearing meanwhile. Throws an Error whose message names
   * the file and the reason (`refuseOverwrite`, `isDirectoryMessage`, `Could not write to …`).
   */
  write(path: string, data: Buffer, overwrite: boolean): void;
}

/** The message for an existing `-o` path without `--force`. */
export function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${cutForMessage(path)}"; pass --force to overwrite.`;
}

/** The message for an `-o` path that is a directory, which `--force` can't fix. */
export function isDirectoryMessage(path: string): string {
  return `"${cutForMessage(path)}" is a directory; give a file path to --output.`;
}

/** The real file system for `-o`. */
export const nodeFiles: OutputFiles = {
  state(path) {
    try {
      return statSync(path).isDirectory() ? "directory" : "exists";
    } catch {
      // statSync follows a link; a dangling one is still something an exclusive create
      // refuses, so lstat decides between "exists" and "absent".
      try {
        lstatSync(path);
        return "exists";
      } catch {
        return "absent";
      }
    }
  },
  write(path, data, overwrite) {
    if (nodeFiles.state(path) === "directory") throw new Error(isDirectoryMessage(path));
    let claimed = false;
    try {
      // Without overwrite the name is claimed first with an exclusive create, which fails for
      // any existing path (a dangling link too, since it never follows one).
      if (!overwrite) {
        closeSync(openSync(path, "wx"));
        claimed = true;
      }
      replaceFile(overwrite ? throughLinks(path) : path, data);
    } catch (cause) {
      // A write cut short (a full disk, a quota) leaves no file under the new name either, so
      // the next run isn't refused for a file that holds half a result.
      if (claimed) rmSync(path, { force: true });
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST" && !claimed) throw new Error(refuseOverwrite(path), { cause });
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not write to "${cutForMessage(path)}": ${reason}`, { cause });
    }
  },
};

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created exclusively,
 * renamed over it. A write cut short (a full disk, a killed process) leaves the old file as it
 * was, never half of the new one. An existing file's mode is kept.
 */
function replaceFile(target: string, data: Buffer): void {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = modeOf(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** The file a path names, through any symlinks, so --force writes where a link points. */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on" | "write">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any other stdout error is an ERROR record of
 * `reisewarnungen.output` (`Could not write to stdout: <message>`, through `log`, in the
 * run's format) and exits 1. On stderr an EPIPE is ignored, so a failed run keeps its
 * exit code; any other stderr error exits 1 silently (there is nowhere left to report
 * it). The bin shim installs this once, before `run()`, with a logger for the format
 * argv asks for (`processLogger`); without one, records are text on `streams.stderr`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => streams.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` used to turn a failure into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

/** What `stderrAfterStdout` needs of stdout: its backlog, and the events that end one. */
export interface StdoutBacklog {
  readonly writableLength: number;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** How often a held record checks whether stdout's backlog is gone (ms). */
const BACKLOG_POLL_MS = 10;

/**
 * A stderr writer that waits for stdout. With both streams on one pipe (`2>&1 |`) and a
 * slow reader, stdout's data is still queued in the process while a record is written
 * to stderr at once, so the record could land inside the JSON (at 64 KiB). Here a text is
 * held while `stdout.writableLength > 0` and written, in order, once the backlog is
 * gone: on stdout's `drain`, `close` or `error`, or at the latest when a short poll sees
 * it empty (`drain` only follows a write that returned false). The poll keeps the
 * process alive until then, so a held record is never lost at exit.
 */
export function stderrAfterStdout(stdout: StdoutBacklog, write: (text: string) => void): (text: string) => void {
  const held: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    for (const text of held.splice(0)) write(text);
  };
  let listening = false;
  return (text) => {
    if (held.length === 0 && stdout.writableLength === 0) return write(text);
    held.push(text);
    if (!listening) {
      listening = true;
      for (const event of ["drain", "close", "error"] as const) stdout.on(event, flush);
    }
    poll ??= setInterval(() => {
      if (stdout.writableLength === 0) flush();
    }, BACKLOG_POLL_MS);
  };
}

const stderrLine = stderrAfterStdout(process.stdout, (text) => process.stderr.write(text + "\n"));

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  // A record never lands inside the data when both streams share a pipe.
  err: stderrLine,
};
