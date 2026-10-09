// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import {
  ReiseApiError,
  ReiseError,
  ReiseNetworkError,
  ReiseNotFoundError,
  ReiseValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also covers
 * a URL that does not parse; the last `@` before the host ends the userinfo. A backstop
 * behind the exact-string redaction of withRedactedOutput.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints. Commander echoes rejected values in its errors (`argument '<url>' is invalid`),
 * the CLI's own messages name unknown commands and option values, and library errors name
 * the request URL: whatever path a credential takes to stdout or stderr, the exact userinfo
 * (as `credentialsIn` finds it, plus its JSON-quoted form) is replaced by `***`. A pattern
 * alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings
 * can. Without credentials the output passes through unchanged. Files written with
 * `--output` are data and are not touched.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  // Every record goes through the redacted `io.err`, so a secret is kept out of the
  // log in either format.
  const redacted = deps;
  deps = {
    ...deps,
    log: createLogger({ format: logFormatFromArgv(argv), write: (line) => redacted.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) }),
  };
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
    // The probe program must be exit-overridden AND silenced: parseOptions runs
    // the option value-parsers (e.g. parseBaseUrl), so an invalid value would
    // otherwise trigger commander's default process.exit(). Silence its output so
    // the error is only reported once, by the real parse below.
    const probeProgram = buildProgram(deps);
    probeProgram.exitOverride();
    probeProgram.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const probe = probeProgram.parseOptions([...argv]);
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
    const log = logOf(deps);
    if (err instanceof ReiseValidationError) {
      // The library rejected an input before any request: a usage error, with the
      // exit code commander gives a value its parsers reject (1).
      log.error("cli", err.message);
      return 1;
    }
    if (err instanceof ReiseApiError) {
      log.error("api", err.message);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof ReiseNotFoundError) {
      // A 2xx response that contained no matching entry: same "not found"
      // exit code as an upstream 404 for scripting symmetry.
      log.error("api", err.message);
      return 4;
    }
    if (err instanceof ReiseError) {
      // A connection failure is the transport's; an API error rewrapped for its exit code
      // (a 404 on the list endpoint, exit 1) is still the API's answer.
      log.error(err instanceof ReiseNetworkError ? "http" : err.cause instanceof ReiseApiError ? "api" : "cli", err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
