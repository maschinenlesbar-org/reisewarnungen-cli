// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OutputError, isDirectoryMessage, logOf, nodeFiles, refuseOverwrite, type CliDeps } from "./io.js";
import { ReiseError, ReiseValidationError } from "@maschinenlesbar.org/reisewarnungen-client/internal/errors";
import { baseUrlProblem, headerValueProblem, intInRangeProblem } from "@maschinenlesbar.org/reisewarnungen-client/internal/validate";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type EngineOptions, type RetryEvent } from "@maschinenlesbar.org/reisewarnungen-client/internal/engine";

/**
 * commander value-parser: a non-negative integer in plain base-10 notation.
 *
 * Only a run of ASCII digits is accepted. This deliberately rejects the forms
 * `Number()` would otherwise coerce silently (hex `0x10`, binary `0b101`,
 * exponent `1e3`, a leading `+`, surrounding whitespace, and the empty string),
 * each of which would mask a typo as a real value. Values above
 * `Number.MAX_SAFE_INTEGER` are rejected too, since they cannot be represented
 * as the integer the user typed.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * Build a commander value-parser for a base-10 integer constrained to [min, max].
 * The range rule is the library's own `intInRangeProblem`; this only converts the
 * string and turns the reason into a usage error.
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intInRangeProblem(min, max);
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/**
 * commander value-parser for `--base-url`: the library's baseUrlProblem rule (an
 * absolute http(s) URL, no query or fragment), reported at parse time as
 * commander's usage error (exit 1). The engine enforces the same rule when the
 * client is built, and the transport still gates the scheme on every hop.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's headerValueProblem (non-blank, no C0 control or DEL, tab allowed,
 * nothing above U+00FF), reported as a usage error. The client applies the same
 * rule to `userAgent` when it is built.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for `--output`: reject an empty / whitespace-only path.
 * Without this, `-o ""` (e.g. from an unset `-o "$VAR"` in a script) is falsy and
 * would silently fall back to stdout, writing no file and giving no warning.
 */
export function parseOutputPath(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Output path must not be empty.");
  }
  return value;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a ReiseError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ReiseError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxRedirects !== undefined) options.maxRedirects = global.maxRedirects;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. An answer nested too deeply (hostile or broken) overflows
 * the stack: an OutputError rather than "Unexpected error: Maximum call stack size exceeded".
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    if (!compact) return JSON.stringify(value, null, 2);
    return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new OutputError(
      compact ? "The answer is nested too deeply to print." : "The answer is nested too deeply to pretty-print; try --compact.",
      { cause: err },
    );
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/** Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting costs no stack. */
function holdsHugeString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      if (item.length >= HUGE_STRING_LENGTH) return true;
    } else if (typeof item === "object" && item !== null) {
      for (const [key, element] of Object.entries(item)) {
        if (key.length >= HUGE_STRING_LENGTH) return true;
        if (typeof element === "string" || (typeof element === "object" && element !== null)) stack.push(element);
      }
    }
  }
  return false;
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`, a
 * directory, and an existing path (a dangling link too) without `--force` are usage errors
 * (a ReiseValidationError: an ERROR record of `reisewarnungen.cli`, exit 1). `-o -` is stdout.
 * The write checks again: a file that appears during the request is not overwritten either
 * (an OutputError then, exit 1).
 */
export function checkOutputTarget(deps: CliDeps, options: GlobalOptions): void {
  if (options.force === true && options.output === undefined) {
    throw new ReiseValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const path = fileOf(options);
  if (path === undefined) return;
  const state = (deps.files ?? nodeFiles).state(path);
  if (state === "directory") throw new ReiseValidationError(isDirectoryMessage(path));
  if (state === "exists" && options.force !== true) throw new ReiseValidationError(refuseOverwrite(path));
}

/**
 * Render a JSON value, pretty by default and compact with --compact, to stdout or to the
 * `-o` file (with an INFO record of `reisewarnungen.output` saying how many bytes went where,
 * so stdout stays clean for a pipe). The file holds exactly what stdout would show, plus a
 * newline. `-o -` means stdout, as in other CLIs: a script passing `-o "$OUT"` with `OUT=-`
 * used to get a file named `-` and no output.
 *
 * The write is atomic and never overwrites by accident (`OutputFiles.write`): without
 * `--force` the name is claimed exclusively, so a file that appeared during the request is
 * kept; the data goes to a temporary file beside the target, renamed over it, so a write cut
 * short (a full disk) leaves the old file as it was and no half-written file; `--force` keeps
 * the old file's mode and writes through a symlink. Every failure is an OutputError (an ERROR
 * record of `reisewarnungen.output`, exit 1) naming the file.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  const path = fileOf(global);
  if (path === undefined) return deps.io.out(text);
  const data = Buffer.from(`${text}\n`, "utf8");
  try {
    (deps.files ?? nodeFiles).write(path, data, global.force === true);
  } catch (cause) {
    throw new OutputError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
  logOf(deps).info("output", `Wrote ${data.length} bytes to ${path}`);
}

/** The `-o` file, or undefined for stdout (no `-o`, or `-o -`). */
function fileOf(options: GlobalOptions): string | undefined {
  return options.output === undefined || options.output === "-" ? undefined : options.output;
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Before the client is built (so before any request), the base URL is checked: plain
 * `http:` to a remote host gets one WARN record of `reisewarnungen.http` (the
 * `cleartextProblem` sentence) on stderr. An action runs once per run, so the warning
 * does too; help, version and usage errors never reach an action and never warn.
 * stdout is never touched.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // A refused -o target is a usage error before anything else happens.
    checkOutputTarget(deps, global);
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/**
 * Make giving a single-value option twice a usage error, on `command` and every subcommand:
 * commander keeps the last value silently, so `--timeout 1000 --timeout 0` switched the timeout
 * off with nothing telling the user a value was dropped. Flags without a value are left alone,
 * and so is a repeatable option, declared the commander way with an array default
 * (`.option("--tag <t>", …, collect, [])`): each value adds to the list. Call it once on a
 * freshly built program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}
