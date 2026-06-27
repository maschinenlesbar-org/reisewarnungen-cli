// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { ReiseApiError, ReiseError, ReiseNotFoundError } from "../client/errors.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A no-subcommand invocation (`reisewarnungen`, `reisewarnungen --compact`,
  // `reisewarnungen -o x.json`) is a benign "show me what this does": print help to
  // stdout and exit 0, consistent with `--help`. Commander's default would instead
  // print help as an error to stderr and exit 1. We detect it by parsing only the
  // options (which correctly consumes global-option values) on a throwaway program:
  // empty `operands` with nothing left in `unknown` means no command and no
  // help/version or unknown option. `--help`/`--version`/unknown options land in
  // `unknown` and fall through to commander so it handles (and reports) them as before.
  try {
    const probe = buildProgram(deps).parseOptions([...argv]);
    if (probe.operands.length === 0 && probe.unknown.length === 0) {
      deps.io.out(program.helpInformation().replace(/\n$/, ""));
      return 0;
    }
  } catch {
    // Option parsing hiccuped — fall through and let the real parse report it.
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse errors carry their own code.
      return err.exitCode;
    }
    if (err instanceof ReiseApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof ReiseNotFoundError) {
      // A 2xx response that contained no matching entry: same "not found"
      // exit code as an upstream 404 for scripting symmetry.
      deps.io.err(`Error: ${err.message}`);
      return 4;
    }
    if (err instanceof ReiseError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
