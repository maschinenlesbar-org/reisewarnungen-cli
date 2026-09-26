// ReisewarnungenClient — a typed client over the open (no-auth) travel-warning
// API of the Auswärtiges Amt (https://www.auswaertiges-amt.de/opendata/travelwarning).
//
//   client.list()            // all countries, keyed by content id
//   client.summaries()       // the same, flattened to an array with ids
//   client.get("226768")     // one country's full warning (HTML content)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { ReiseError, ReiseNotFoundError, ReiseParseError } from "./errors.js";
import type { TravelWarning, TravelWarningList, CountryEntry, JsonObject } from "./types.js";

const PATH = "/opendata/travelwarning";
const enc = encodeURIComponent;

/**
 * Check a content id before it becomes a path segment. Content ids are numeric (the
 * keys of `list()`, the `id` of `summaries()`), so only ASCII digits pass: `""`,
 * `"."` and `".."` would otherwise reach the list endpoint or its parent directory
 * (URL dot-segment normalisation), and the upstream reads a *leading* integer
 * leniently (`226768x` returns 226768's country). Throws ReiseError.
 */
export function assertContentId(contentId: string): void {
  if (typeof contentId !== "string" || !/^\d+$/.test(contentId)) {
    throw new ReiseError(
      `Invalid contentId ${JSON.stringify(String(contentId))}. Expected a numeric content id (e.g. 226768).`,
    );
  }
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

export class ReisewarnungenClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** The raw `response`: a `lastModified` timestamp plus one entry per country. */
  async list(): Promise<TravelWarningList> {
    return unwrap(await this.engine.getJson<unknown>(PATH), PATH);
  }

  /**
   * The list flattened to an array of country entries (each carrying its content
   * `id`), with the `lastModified` envelope key dropped.
   */
  async summaries(): Promise<CountryEntry[]> {
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
    return entries;
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
   * not all ASCII digits is rejected with a ReiseError before any request.
   */
  async get(contentId: string): Promise<TravelWarning> {
    assertContentId(contentId);
    const path = `${PATH}/${enc(contentId)}`;
    const response = unwrap(await this.engine.getJson<unknown>(path), path);

    const direct = Object.hasOwn(response, contentId) ? response[contentId] : undefined;
    if (isObject(direct)) return direct as TravelWarning;

    if (Object.values(response).some(isObject)) {
      throw shapeError(
        path,
        `the entry for content id "${contentId}", got country entries under other keys only`,
      );
    }
    throw new ReiseNotFoundError(contentId);
  }
}
