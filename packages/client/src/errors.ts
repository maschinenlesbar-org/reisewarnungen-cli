// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output. A URL
 * without userinfo is returned unchanged; one that does not parse has its credentials
 * cut out by text (credentialsIn).
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme (`^[A-Za-z][A-Za-z0-9+.-]*://`) counts: a bare `a:b@c` is a file name
 * (`-o run:2026-10-09@x.json`), a User-Agent or a country name as often as a credential,
 * and the base URL always has a scheme. It works on URLs that don't parse too: the
 * userinfo is everything between `://` and the last `@` before the host. Used to redact
 * those exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/** A scheme character (RFC 3986: letters, digits, `+`, `.`, `-`). */
function isSchemeChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/** An ASCII letter, with which a scheme starts. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Where the scheme of the `://` at `at` starts: the first letter of the run of scheme characters
 * before it, looking back no further than `from`; -1 when there is none (`1://`, ` ://`). A run
 * led by other scheme characters (`-https://`) starts at its first letter.
 */
function schemeStart(text: string, at: number, from: number): number {
  let start = at;
  while (start > from && isSchemeChar(text.charCodeAt(start - 1))) start--;
  while (start < at && !isLetter(text.charCodeAt(start))) start++;
  return start < at ? start : -1;
}

/**
 * `text` with the userinfo of every URL in it replaced by `***` (`https://user:secret@host`
 * becomes `https://***@host`): the pattern backstop for text no exact secret matches. Text-based,
 * so it also covers a URL that does not parse; the userinfo ends at the last `@` before the first
 * whitespace, `/`, `?`, `#` or `'` after `://`. Linear in `text`, however many URLs it holds: each
 * `://` is found with `indexOf`, its scheme by walking back no further than the previous `://`,
 * and the search goes on right after each `://`, not after the authority it read: a URL glued
 * onto the one before it (`https://host://u:p@h`, `https://u:p@x://v:q@w`) starts inside that
 * authority, which ends at its `/`. An authority holds no `/`, so no `://` lies wholly inside one,
 * and every character is read a bounded number of times: by the authority loop and `indexOf`
 * forwards, by `schemeStart` backwards. The URL regex this replaces was tried at every word
 * start, seconds on a long answer.
 */
export function redactUrlUserinfo(text: string): string {
  const parts = new TextBuilder();
  let copied = 0;
  let from = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", from)) {
    const begin = at + 3;
    let end = begin;
    let lastAt = -1;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x27 || /\s/.test(text[end] as string)) break;
      if (c === 0x40) lastAt = end;
    }
    if (lastAt !== -1 && schemeStart(text, at, from) !== -1) {
      parts.push(text.slice(copied, begin), "***");
      copied = lastAt;
    }
    from = begin;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.toString();
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a server answer and their replacements),
 * joined in batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text,
 * not to the number of pieces. One `+=` per piece made a rope node each, and one array of every
 * piece a slot each: millions of lone-surrogate repairs in a large answer exhausted a small heap
 * either way.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body: the `Authorization: Basic`
 * value (base64 of the decoded `user:password`, UTF-8 as the engine sends it), the
 * decoded `user:password` itself, and the password alone when it is at least 4
 * characters long. `[]` for a userinfo without a password. None of them has an `@` to
 * anchor on, so they are replaced as exact strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  if (colon < 0) return [];
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(userinfo.slice(0, colon));
  const password = decode(userinfo.slice(colon + 1));
  if (password === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (password.length >= 4) forms.push(password);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * The longest value (in characters) an own message quotes from a server answer or from
 * the user's input: a header, a key, a redirect target. A longer one is cut (`cutText`)
 * and ends in "…", so a library caller's `err.message` stays bounded too.
 */
export const MAX_QUOTED_LENGTH = 200;

/** `text` cut to `max` characters (default `MAX_QUOTED_LENGTH`), a cut marked with "…". */
export function cutForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  const cut = cutText(text, max);
  return cut.length < text.length ? `${cut}…` : text;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/** The most characters of a value {@link quoteValue} quotes, like a content id in a message. */
const MAX_QUOTED_VALUE_LENGTH = 500;

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it
 * leaves raw although a terminal acts on it: DEL, the C1 controls, every Unicode
 * format character (bidi overrides, zero-width characters, the soft hyphen) and the line and
 * paragraph separators U+2028/U+2029, which a viewer may break the line at. A refusal quotes
 * the value the user typed; an invisible character in it is shown (`\u200b`), never raw (D10).
 * A value longer than 500 characters is cut, and the "…" goes after the closing quote
 * (`"AAAA"…`), so it does not read as part of the value. The quoted part stays a valid JSON
 * string.
 */
export function quoteValue(value: string): string {
  const cut = value.length > MAX_QUOTED_VALUE_LENGTH;
  let out = "";
  for (const ch of JSON.stringify(cut ? cutText(value, MAX_QUOTED_VALUE_LENGTH) : value)) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return cut ? `${out}…` : out;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Base class for every error originating from this client. */
export class ReiseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present. For a 3xx that was
 * not followed (not a followable status, a missing or malformed Location, or past
 * `maxRedirects`), `location` holds the redirect target (absolute, sanitised) and the
 * message names it.
 */
export class ReiseApiError extends ReiseError {
  readonly status: number;
  readonly detail: string | undefined;
  /** The request URL, userinfo redacted (`https://***@host/…`). */
  readonly url: string;
  readonly method: string;
  /**
   * The response body, the base URL's credentials scrubbed. It is the body as sent, unless it
   * is JSON whose decoded text still holds an echoed credential (hidden behind an escape such
   * as `\u002d`): then it is the decoded JSON written again (`JSON.stringify`) with the echo
   * replaced by `***`, and `""` when it is nested too deeply to write again.
   */
  readonly body: string;
  readonly location: string | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    /** Redirects already followed when the `maxRedirects` limit stopped this one. */
    redirectsFollowed?: number;
    /** Extra context for the message (a redirect that dropped the base URL's credentials). */
    hint?: string;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.hint) parts.push(args.hint);
    if (args.status >= 300 && args.status < 400) {
      const limit =
        args.redirectsFollowed !== undefined && args.redirectsFollowed > 0
          ? ` (stopped after ${args.redirectsFollowed} redirects)`
          : "";
      parts.push(
        args.location
          ? `redirect to ${cutForMessage(args.location)} not followed${limit}`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    // The URL is shown and kept without userinfo: a credential in a base URL must not leak
    // into a message, a log line or JSON.stringify(err).
    const url = redactUrl(args.url);
    // A 5000-digit content id makes a 5 KB URL: the message shows at most 500 characters.
    const shown = cutForMessage(url, 500);
    super(`HTTP ${args.status} for ${args.method} ${shown}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * A requested entry was not present in an otherwise successful (2xx) response.
 * The upstream may answer `200` with an envelope holding no country entry
 * instead of a `404`; this surfaces that absence as a typed, observable error.
 * (An envelope whose entries sit under other keys is a ReiseParseError instead.)
 * Carries a synthetic `status` of 404 so the CLI maps it to the same exit code
 * as a real upstream 404.
 */
export class ReiseNotFoundError extends ReiseError {
  readonly status = 404;
  readonly contentId: string;

  constructor(contentId: string) {
    // The message quotes at most 500 characters of the id (a 6000-digit id made a 6 KB
    // message); `contentId` keeps it whole.
    super(`No travel warning found for content id "${cutForMessage(contentId, 500)}"`);
    this.contentId = contentId;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class ReiseNetworkError extends ReiseError {}

/** The response body could not be parsed as the expected JSON shape. */
export class ReiseParseError extends ReiseError {}

/**
 * A rejected input — a client option or a method argument that breaks one of the
 * library's rules (see validate.ts). Thrown before any request is made; the CLI
 * maps it to its usage exit code (1).
 */
export class ReiseValidationError extends ReiseError {}
