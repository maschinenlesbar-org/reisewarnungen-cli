// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { statSync, writeFileSync } from "node:fs";
import { ReiseError } from "../client/errors.js";
import type { ReisewarnungenClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";
import { createLogger, type Logger } from "./log.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. When `force` is false the write is exclusive
   * (the `wx` flag): it fails rather than clobbering an existing file, so a
   * mistyped `-o` path can never silently destroy data. `force` opts into an
   * overwriting write.
   */
  writeFile(path: string, data: Buffer, force: boolean): void;
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // `wx` creates the file exclusively (errors if it already exists) unless the
  // caller opted into overwriting with --force, which uses the default `w` flag.
  writeFile: (path, data, force) => {
    try {
      writeFileSync(path, data, { flag: force ? "w" : "wx" });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      // `wx` answers EEXIST and `w` EISDIR for a directory; --force cannot help there.
      if ((code === "EEXIST" || code === "EISDIR") && isDirectory(path)) {
        throw new ReiseError(`"${path}" is a directory; give a file path to --output.`, { cause });
      }
      throw cause;
    }
  },
};
