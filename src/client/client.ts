// ReisewarnungenClient — a typed client over the open (no-auth) travel-warning
// API of the Auswärtiges Amt (https://www.auswaertiges-amt.de/opendata/travelwarning).
//
//   client.list()            // all countries, keyed by content id
//   client.summaries()       // the same, flattened to an array with ids
//   client.get("226768")     // one country's full warning (HTML content)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { ReiseNotFoundError, ReiseParseError } from "./errors.js";
import type { TravelWarning, TravelWarningList, CountryEntry, JsonObject } from "./types.js";

const PATH = "/opendata/travelwarning";
const enc = encodeURIComponent;

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
        entries.push({ id, ...(value as TravelWarning) });
      }
    }
    return entries;
  }

  /**
   * One country's full travel warning (the HTML `content` is populated here).
   *
   * Throws {@link ReiseParseError} when the body is not the `{ "response": {...} }`
   * envelope, and {@link ReiseNotFoundError} when the (2xx) envelope contains no
   * entry for `contentId`, so an absent country is observable rather than masked as an
   * empty success. The single-warning endpoint keys its one entry under the
   * content id; as a tolerance for that key ever differing, a *sole* non-
   * `lastModified` object entry is accepted as the result, but an ambiguous
   * (multi-entry) response is treated as not-found rather than risk returning a
   * different country than requested.
   */
  async get(contentId: string): Promise<TravelWarning> {
    const path = `${PATH}/${enc(contentId)}`;
    const response = unwrap(await this.engine.getJson<unknown>(path), path);

    const direct = response[contentId];
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as TravelWarning;
    }

    const sole = this.soleEntry(response);
    if (sole) return sole as TravelWarning;

    throw new ReiseNotFoundError(contentId);
  }

  /**
   * The single non-`lastModified` object entry of a response, or `undefined`
   * when there is none or more than one (an ambiguous match is not returned).
   */
  private soleEntry(response: JsonObject): JsonObject | undefined {
    let found: JsonObject | undefined;
    for (const [key, value] of Object.entries(response)) {
      if (key === "lastModified") continue;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (found) return undefined; // more than one entry -> ambiguous
        found = value;
      }
    }
    return found;
  }
}
