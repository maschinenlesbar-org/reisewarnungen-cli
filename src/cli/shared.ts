// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { ReiseError } from "../client/errors.js";
import type { EngineOptions } from "../client/engine.js";

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

/** Build a commander value-parser for a base-10 integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * commander value-parser for `--base-url`: accept only a well-formed absolute
 * `http:`/`https:` URL. Rejecting at parse time yields commander's usage error
 * (exit 2) with a clear message, and forecloses a non-http(s) scheme up front —
 * defense in depth ahead of the transport's own request-time allowlist. `--base-url`
 * is self-chosen input, so this is a usability/contract guard, not a trust boundary.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected a valid absolute URL (e.g. https://host).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError('Only "http:" and "https:" base URLs are supported.');
  }
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
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short confirmation on stderr so stdout stays
 * clean for piping) or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global.output, data, global.force === true);
  } else {
    deps.io.out(text);
  }
}

/**
 * Write the result to `--output`, with a short confirmation on stderr so stdout
 * stays clean for piping. A filesystem failure (bad path, missing directory,
 * permission denied) is a foreseeable user error, so it is surfaced as a clean
 * ReiseError ("Error: could not write …", exit 1) rather than bubbling up as a
 * raw Node errno through run()'s "Unexpected error" fallback.
 *
 * The write is exclusive unless `force` is set: an existing file at `path` is
 * never silently overwritten (a mistyped `-o` path would otherwise destroy it).
 * The EEXIST case is surfaced with a message pointing at --force.
 */
function writeOutputFile(deps: CliDeps, path: string, data: Buffer, force: boolean): void {
  try {
    deps.io.writeFile(path, data, force);
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    if (code === "EEXIST") {
      throw new ReiseError(
        `Refusing to overwrite existing file ${path}; pass --force to overwrite.`,
        { cause },
      );
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ReiseError(`Could not write to ${path}: ${reason}`, { cause });
  }
  deps.io.err(`Wrote ${data.length} bytes to ${path}`);
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
