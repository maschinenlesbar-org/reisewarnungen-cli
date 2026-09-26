// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { ReisewarnungenClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseBoundedInt, parseIntArg, parseOutputPath, parseBaseUrl, parseHeaderValue } from "./shared.js";
import { registerWarningCommands } from "./commands/warnings.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new ReisewarnungenClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("reisewarnungen")
    .description(
      "CLI for the open Auswärtiges Amt travel-warning API " +
        "(https://www.auswaertiges-amt.de/opendata/travelwarning)",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://www.auswaertiges-amt.de")
    .option(
      "--timeout <ms>",
      "time limit per request in milliseconds, whole response included",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value (non-blank, Latin-1, no control characters)", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses (0..10; each waits the server's Retry-After, up to 30 s)",
      parseBoundedInt(0, 10),
    )
    .option("--max-redirects <n>", "HTTP redirects to follow (0 = none; default 5)", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output to this file instead of stdout", parseOutputPath)
    .option("--force", "overwrite the --output file if it already exists")
    .showHelpAfterError();

  registerWarningCommands(program, deps);

  return program;
}
