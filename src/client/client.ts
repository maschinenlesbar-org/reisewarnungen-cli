// ReisewarnungenClient — a typed client over the open (no-auth) travel-warning
// API of the Auswärtiges Amt (https://www.auswaertiges-amt.de/opendata/travelwarning).
//
//   client.list()            // all countries, keyed by content id
//   client.summaries()       // the same, flattened to an array with ids
//   client.summaries({ warnedOnly: true })  // only countries with a warning in force
//   client.get("226768")     // one country's full warning (HTML content)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { ReiseNotFoundError, ReiseParseError, ReiseValidationError } from "./errors.js";
import { assertKnownKeys, assertValid, booleanProblem } from "./validate.js";
import type { TravelWarning, TravelWarningList, CountryEntry, JsonObject } from "./types.js";
import { adviceSentences, type AdviceSentence } from "./advice.js";

const PATH = "/opendata/travelwarning";
const enc = encodeURIComponent;

/**
 * Check a content id before it becomes a path segment. Content ids are numeric (the
 * keys of `list()`, the `id` of `summaries()`), so only ASCII digits pass: `""`,
 * `"."` and `".."` would otherwise reach the list endpoint or its parent directory
 * (URL dot-segment normalisation), and the upstream reads a *leading* integer
 * leniently (`226768x` returns 226768's country). Throws ReiseValidationError (a
 * ReiseError), like every other rejected input; a number (`226768`) is refused with a
 * message that says it must be a string. The echoed value is cut at 500 characters.
 */
export function assertContentId(contentId: string): void {
  if (typeof contentId !== "string") {
    throw new ReiseValidationError(
      `Invalid contentId: Expected a string of digits (e.g. "226768"), got ${contentId === null ? "null" : typeof contentId}.`,
    );
  }
  if (!/^\d+$/.test(contentId)) {
    const shown = JSON.stringify(contentId.length > 500 ? contentId.slice(0, 500) : contentId) + (contentId.length > 500 ? "…" : "");
    throw new ReiseValidationError(`Invalid contentId ${shown}. Expected a numeric content id (e.g. 226768).`);
  }
}

/**
 * Whether a country counts as "warned": true when **any** of the four warning flags
 * (`warning`, `partialWarning`, `situationWarning`, `situationPartWarning`) is
 * `true`. Only a real boolean `true` counts; the client refuses an answer whose flags
 * are not booleans (checkFlags), so a malformed value never reaches it. This is the rule
 * behind `summaries({ warnedOnly: true })` and the CLI's `countries --warned-only`.
 * Anything but an entry object is a ReiseValidationError.
 */
export function isWarned(entry: TravelWarning): boolean {
  if (!isObject(entry)) throw new ReiseValidationError("Invalid entry: Expected a country entry object.");
  return (
    entry.warning === true ||
    entry.partialWarning === true ||
    entry.situationWarning === true ||
    entry.situationPartWarning === true
  );
}

/** One country's flags plus the advice-against-travel sentences of its advisory ({@link ReisewarnungenClient.advice}). */
export interface TravelAdvice {
  /** The content id that was asked for. */
  id: string;
  countryName?: string;
  countryCode?: string;
  iso3CountryCode?: string;
  /** The four warning flags, as in `get` (only `true` counts as a warning; see isWarned). */
  warning?: boolean;
  partialWarning?: boolean;
  situationWarning?: boolean;
  situationPartWarning?: boolean;
  /** Unix seconds: when the current advice took effect / was last changed. */
  effective?: number;
  lastModified?: number;
  /**
   * Every sentence of the advisory that warns or advises against something (adviceSentences):
   * „abgeraten", „rät … ab", „gewarnt", „Reisewarnung", „(ver)meiden"/„gemieden", „verzichten",
   * „unterlassen", „aufgefordert", „nicht … reisen/aufsuchen". Those with `travel: true` may
   * advise against travel to the country or a region; with all four flags false, only an
   * advisory with no such sentence is "advice only".
   */
  sentences: AdviceSentence[];
}

/** Options for {@link ReisewarnungenClient.summaries}. */
export interface SummariesOptions {
  /**
   * Keep only the countries with a warning of any kind in force ({@link isWarned}).
   * Defaults to `false` (every country).
   */
  warnedOnly?: boolean;
}

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(path: string, expected: string): ReiseParseError {
  return new ReiseParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}

/**
 * The documented `{ "response": { ... } }` envelope, unwrapped. A 2xx body that is
 * not such an envelope (null, an array, `{}`, another API's JSON) is a broken or
 * wrong-API response, not an empty result: it raises ReiseParseError rather than
 * reading as "no data" or "not found".
 */
function unwrap(body: unknown, path: string): JsonObject {
  if (!isObject(body) || !isObject(body["response"])) {
    throw shapeError(path, 'a JSON object with a "response" object');
  }
  return body["response"];
}

/** The flags every country entry must carry as booleans. */
const REQUIRED_FLAGS = ["warning", "partialWarning"] as const;
/** The flags that must be booleans when present (all `false` in the live data so far). */
const OPTIONAL_FLAGS = ["situationWarning", "situationPartWarning"] as const;

/**
 * Throw a ReiseParseError when a country entry's warning flags are not booleans: `warning`
 * and `partialWarning` must be present, the two situation flags may be absent. A malformed
 * flag used to fail open — `"true"` or `1` was not counted as warned (`--warned-only` dropped
 * the country silently), a renamed `Warning` left every country unwarned, and the watch
 * skill's jq read `"false"` as a warning. Such an answer is a format change upstream; no
 * rule can read it safely, so it is refused.
 */
function checkFlags(entry: JsonObject, contentId: string, path: string): void {
  for (const flag of REQUIRED_FLAGS) {
    if (typeof entry[flag] !== "boolean") throw flagError(entry, contentId, flag, path);
  }
  for (const flag of OPTIONAL_FLAGS) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") throw flagError(entry, contentId, flag, path);
  }
}

function flagError(entry: JsonObject, contentId: string, flag: string, path: string): ReiseParseError {
  const name = typeof entry["countryName"] === "string" ? ` (${cutText(entry["countryName"])})` : "";
  const value = entry[flag];
  const got = value === undefined ? "it is missing" : `got ${cutText(JSON.stringify(value))}`;
  return new ReiseParseError(
    `Unexpected response shape from ${path}: the "${flag}" flag of content id "${contentId}"${name} ` +
      `must be true or false, ${got}; the warning level can't be read safely.`,
  );
}

/** Keys of the list envelope that are not countries. */
const ENVELOPE_KEYS = new Set(["lastModified", "contentList"]);

/**
 * Check the unwrapped list `response` against the documented shape and return it. The list
 * always holds about 200 countries, so a 2xx answer that holds none is a broken answer, never
 * "no travel warnings": a `{"response":{}}`, an envelope with only `lastModified` /
 * `contentList`, or one carrying an `error` text used to print `[]` with exit 0, which the
 * warned-overview skill reported as good news. Throws ReiseParseError for
 *
 * - an `error` member (an error envelope sent with a 2xx status), naming its text;
 * - a content-id key (all digits) whose value is not an object;
 * - no country entry at all;
 * - a `contentList` naming an id that has no entry (a partial answer that would drop
 *   countries silently).
 */
function checkList(response: JsonObject, path: string): JsonObject {
  const error = response["error"];
  if (error !== undefined) {
    const text = typeof error === "string" ? error : JSON.stringify(error);
    throw new ReiseParseError(
      `The API answered ${path} with an error envelope instead of the travel-warning list: ${cutText(text)}`,
    );
  }
  let countries = 0;
  for (const [key, value] of Object.entries(response)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    if (/^\d+$/.test(key)) {
      if (!isObject(value)) throw shapeError(path, `an object for content id "${key}"`);
      checkFlags(value, key, path);
      countries += 1;
    }
  }
  if (countries === 0) {
    throw new ReiseParseError(
      `Unexpected response shape from ${path}: the travel-warning list holds no country ` +
        "(a broken or partial answer, not \"no warnings\"); try again later.",
    );
  }
  const contentList = response["contentList"];
  if (Array.isArray(contentList)) {
    const missing = contentList.map(String).filter((id) => !isObject(response[id]));
    if (missing.length > 0) {
      throw new ReiseParseError(
        `Unexpected response shape from ${path}: contentList names ${missing.length} id(s) without an entry ` +
          `(${cutText(missing.slice(0, 10).join(", "))}${missing.length > 10 ? ", …" : ""}), a partial answer.`,
      );
    }
  }
  return response;
}

/** Server text cut for a message: one line, at most 200 characters. */
function cutText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export class ReisewarnungenClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * The raw `response`: a `lastModified` timestamp, a `contentList` and one entry per
   * country. A 2xx answer without any country entry, with an `error` member, or whose
   * `contentList` names ids without an entry is a ReiseParseError (see checkList), never an
   * empty result.
   */
  async list(): Promise<TravelWarningList> {
    return checkList(unwrap(await this.engine.getJson<unknown>(PATH), PATH), PATH);
  }

  /**
   * The list flattened to an array of country entries (each carrying its content
   * `id`), with the `lastModified` envelope key dropped. With `warnedOnly: true`,
   * only the countries {@link isWarned} accepts (any of the four flags `true`).
   * A `warnedOnly` that is not a boolean, options that are not an object, and an unknown
   * option key (a misspelt `warnedonly`) are rejected with a ReiseValidationError before
   * any request.
   */
  async summaries(options: SummariesOptions = {}): Promise<CountryEntry[]> {
    // A misspelt key (`warnedonly`) used to be ignored, so a JavaScript caller's typo
    // switched the filter off and returned every country.
    assertKnownKeys("summaries options", options, ["warnedOnly"]);
    if (options.warnedOnly !== undefined) assertValid("warnedOnly", options.warnedOnly, booleanProblem);
    const response = await this.list();
    const entries: CountryEntry[] = [];
    for (const [id, value] of Object.entries(response)) {
      // `lastModified` is the envelope timestamp; `contentList` is an array of
      // all content ids the upstream includes alongside the per-country
      // summaries. Neither is a country, so both are skipped explicitly rather
      // than relying on the (incidental) object-vs-array shape check below.
      if (id === "lastModified" || id === "contentList") continue;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // The map key is the content id (what get() accepts): an `id` field inside
        // the entry must not replace it. It stays the first key of the entry.
        const { id: _entryId, ...fields } = value as TravelWarning & { id?: unknown };
        entries.push({ id, ...fields });
      }
    }
    return options.warnedOnly === true ? entries.filter(isWarned) : entries;
  }

  /**
   * One country's full travel warning (the HTML `content` is populated here).
   *
   * Throws {@link ReiseParseError} when the body is not the `{ "response": {...} }`
   * envelope, and {@link ReiseNotFoundError} when the (2xx) envelope contains no
   * country entry at all, so an absent country is observable rather than masked as
   * an empty success. Only the entry keyed by `contentId` is ever returned: an
   * envelope whose country entries sit under other keys is a wrong answer
   * (ReiseParseError), never read as the requested country. A `contentId` that is
   * not all ASCII digits is rejected with a ReiseValidationError before any request.
   */
  /**
   * One country's warning flags plus every sentence of its advisory that warns or advises
   * against something (see {@link TravelAdvice}) — the part of the 40–70 KB HTML a
   * travel-safety verdict depends on, because the flags record only the formal warning
   * levels. Fetches the advisory with {@link get} (same errors, same id rule); an entry
   * without `content` is a ReiseParseError, never an advisory without advice.
   */
  async advice(contentId: string): Promise<TravelAdvice> {
    const entry = await this.get(contentId);
    if (typeof entry.content !== "string" || entry.content.trim() === "") {
      throw new ReiseParseError(
        `The advisory for content id "${contentId}" has no content, so its advice can't be read.`,
      );
    }
    const pick = <K extends keyof TravelWarning>(key: K): Partial<Pick<TravelWarning, K>> =>
      entry[key] === undefined ? {} : ({ [key]: entry[key] } as Partial<Pick<TravelWarning, K>>);
    return {
      id: contentId,
      ...pick("countryName"),
      ...pick("countryCode"),
      ...pick("iso3CountryCode"),
      ...pick("warning"),
      ...pick("partialWarning"),
      ...pick("situationWarning"),
      ...pick("situationPartWarning"),
      ...pick("effective"),
      ...pick("lastModified"),
      sentences: adviceSentences(entry.content),
    };
  }

  async get(contentId: string): Promise<TravelWarning> {
    assertContentId(contentId);
    const path = `${PATH}/${enc(contentId)}`;
    const response = unwrap(await this.engine.getJson<unknown>(path), path);
    // An error envelope sent with a 2xx status is a failure, not "this country doesn't exist".
    if (response["error"] !== undefined) {
      const error = response["error"];
      throw new ReiseParseError(
        `The API answered ${path} with an error envelope instead of a travel warning: ` +
          cutText(typeof error === "string" ? error : JSON.stringify(error)),
      );
    }

    const direct = Object.hasOwn(response, contentId) ? response[contentId] : undefined;
    if (isObject(direct)) {
      checkFlags(direct, contentId, path);
      return direct as TravelWarning;
    }

    if (Object.values(response).some(isObject)) {
      throw shapeError(
        path,
        `the entry for content id "${contentId}", got country entries under other keys only`,
      );
    }
    throw new ReiseNotFoundError(contentId);
  }
}
