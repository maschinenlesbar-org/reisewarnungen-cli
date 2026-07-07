// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { ReisewarnungenClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";

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
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // `wx` creates the file exclusively (errors if it already exists) unless the
  // caller opted into overwriting with --force, which uses the default `w` flag.
  writeFile: (path, data, force) => writeFileSync(path, data, { flag: force ? "w" : "wx" }),
};
