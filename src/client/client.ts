// ReisewarnungenClient — a typed client over the open (no-auth) travel-warning
// API of the Auswärtiges Amt (https://www.auswaertiges-amt.de/opendata/travelwarning).
//
//   client.list()            // all countries, keyed by content id
//   client.summaries()       // the same, flattened to an array with ids
//   client.get("226768")     // one country's full warning (HTML content)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { ReiseNotFoundError } from "./errors.js";
import type { TravelWarning, TravelWarningList, CountryEntry, JsonObject } from "./types.js";

const PATH = "/opendata/travelwarning";
const enc = encodeURIComponent;

interface Wrapped {
  response: JsonObject;
}

export class ReisewarnungenClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** The raw `response`: a `lastModified` timestamp plus one entry per country. */
  async list(): Promise<TravelWarningList> {
    const res = await this.engine.getJson<Wrapped>(PATH);
    return res.response ?? {};
  }

  /**
   * The list flattened to an array of country entries (each carrying its content
   * `id`), with the `lastModified` envelope key dropped.
   */
  async summaries(): Promise<CountryEntry[]> {
    const response = await this.list();
    const entries: CountryEntry[] = [];
    for (const [id, value] of Object.entries(response)) {
      if (id === "lastModified") continue;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entries.push({ id, ...(value as TravelWarning) });
      }
    }
    return entries;
  }

  /**
   * One country's full travel warning (the HTML `content` is populated here).
   *
   * Throws {@link ReiseNotFoundError} when the (2xx) response contains no entry
   * for `contentId`, so an absent country is observable rather than masked as an
   * empty success. The single-warning endpoint keys its one entry under the
   * content id; as a tolerance for that key ever differing, a *sole* non-
   * `lastModified` object entry is accepted as the result, but an ambiguous
   * (multi-entry) response is treated as not-found rather than risk returning a
   * different country than requested.
   */
  async get(contentId: string): Promise<TravelWarning> {
    const res = await this.engine.getJson<Wrapped>(`${PATH}/${enc(contentId)}`);
    const response = res.response ?? {};

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
