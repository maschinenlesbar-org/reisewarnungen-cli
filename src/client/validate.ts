// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives here (or next to the option it guards) as a pure,
// exported function, so the CLI calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (a usage error, exit 1).
// - `assertValid` runs a `Problem` in the library and throws a
//   `ReiseValidationError` ("Invalid <name>: <reason>") before any request is made.
//   Methods that return a promise call it inside the async body, so they reject
//   rather than throw synchronously; constructors throw.

import { ReiseValidationError } from "./errors.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link ReiseValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new ReiseValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** A boolean option: only `true` or `false` (a truthy string such as "false" is not one). */
export const booleanProblem: Problem = (value) =>
  typeof value === "boolean" ? undefined : "Expected true or false.";

/**
 * An integer in `min..max` (inclusive): a safe integer, so NaN, Infinity and
 * fractions are rejected ("Expected an integer."), then the bounds
 * ("Must be >= 0.", "Must be <= 10.").
 */
export function intInRangeProblem(min: number, max: number = Number.MAX_SAFE_INTEGER): Problem {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return "Expected an integer.";
    if (value < min) return `Must be >= ${min}.`;
    if (value > max) return `Must be <= ${max}.`;
    return undefined;
  };
}

/**
 * A value that goes into an HTTP header (the User-Agent): non-blank, no C0 control
 * or DEL (tab is allowed, as in HTTP), nothing above U+00FF. Node's HTTP layer
 * refuses those with an opaque "Invalid character in header content" TypeError at
 * request time, an injected transport would send a CR/LF value as is, and a blank
 * value would be sent as an empty header. Checked by char code so the source stays
 * free of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * A base URL: an absolute `http:`/`https:` URL with no query or fragment. Request
 * paths are appended to the base URL as a string, so a `?` or `#` in it would
 * swallow every path (`http://h/?x=1` requests `/?x=1/opendata/...`, `http://h/#f`
 * requests `/`). A malformed value (`notaurl`, `""`, `http://`) fails the parse.
 */
export const baseUrlProblem: Problem = (value) => {
  const malformed = "Expected a valid absolute URL (e.g. https://host).";
  if (typeof value !== "string") return malformed;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return malformed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return 'Only "http:" and "https:" base URLs are supported.';
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  return undefined;
};
