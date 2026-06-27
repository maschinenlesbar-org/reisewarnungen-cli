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
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short confirmation on stderr so stdout stays
 * clean for piping) or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global.output, data);
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
 */
function writeOutputFile(deps: CliDeps, path: string, data: Buffer): void {
  try {
    deps.io.writeFile(path, data);
  } catch (cause) {
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
