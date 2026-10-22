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

import { ReiseValidationError, quoteValue } from "./errors.js";

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
 * A `%` in the user name or password must start a valid escape (`%25` for a literal
 * one): the userinfo is decoded for the Authorization header, and Node failed at
 * request time ("URI malformed") as a network error. Surrounding whitespace (U+00A0
 * included) and control characters are rejected: `new URL()` trims or drops them
 * silently, but the raw string is what the request URL is built from.
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
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  return undefined;
};

/**
 * Check that `options` is a plain options object (or undefined) whose keys are all in
 * `known`, and throw a ReiseValidationError otherwise. A JavaScript caller's typo
 * (`warnedonly` for `warnedOnly`, `timeout` for `timeoutMs`) was ignored silently and the
 * default applied; TypeScript catches it at compile time, JavaScript does not. A key set
 * to `undefined` changes nothing and passes. `__proto__` and `constructor` are never
 * option names.
 */
export function assertKnownKeys(name: string, options: unknown, known: readonly string[]): void {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ReiseValidationError(`Invalid ${name}: Expected an object.`);
  }
  for (const key of Reflect.ownKeys(options)) {
    const value = (options as Record<string | symbol, unknown>)[key];
    if (typeof key === "string" && known.includes(key)) continue;
    if (value === undefined && typeof key === "string" && key !== "__proto__") continue;
    const label = typeof key === "string" ? JSON.stringify(key) : String(key);
    const lower = typeof key === "string" ? key.toLowerCase() : "";
    const hint = known.find((k) => k.toLowerCase() === lower || (lower !== "" && (k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))));
    throw new ReiseValidationError(
      `Invalid ${name}: Unknown option ${label}` + (hint === undefined ? `; the options are ${known.join(", ")}.` : ` (did you mean ${hint}?).`),
    );
  }
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which would be sent as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value is
 * refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value: a value the API compares exactly (here the content id). The rules apply to the
 * value with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank
 * (and not only invisible characters or combining marks), no lone surrogate, and no control or
 * format character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an
 * invisible character in an id only ever makes it match nothing. The reason quotes the value
 * visibly (`quoteValue`).
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}
