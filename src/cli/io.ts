// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { ReisewarnungenClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Persist raw bytes to a file. */
  writeFile(path: string, data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EngineOptions): ReisewarnungenClient;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data) => writeFileSync(path, data),
};
