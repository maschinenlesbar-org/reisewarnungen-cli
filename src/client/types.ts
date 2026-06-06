// Domain types for the Auswärtiges Amt travel-warning open-data API
// (auswaertiges-amt.de/opendata/travelwarning).
//
// Every response is wrapped in a top-level `response` object. The list response
// is a map of content id -> summary, plus a `lastModified` timestamp; the single
// response carries the same map shape with the full HTML `content` populated.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One country's travel-warning entry. `content` is HTML, populated on `get`. */
export interface TravelWarning {
  lastModified?: number;
  effective?: number;
  title?: string;
  countryCode?: string;
  iso3CountryCode?: string;
  countryName?: string;
  /** A full travel warning (Reisewarnung) is in force. */
  warning?: boolean;
  /** A partial (regional) warning is in force. */
  partialWarning?: boolean;
  /** Situation-specific warning. */
  situationWarning?: boolean;
  situationPartWarning?: boolean;
  lastChanges?: string;
  /** Full HTML text — present on the single-warning endpoint. */
  content?: string;
  disclaimer?: string;
}

/**
 * The unwrapped `response` of the list endpoint: a `lastModified` timestamp plus
 * one numeric-string key per country pointing at its summary.
 */
export type TravelWarningList = JsonObject;

/** A country summary augmented with its content id (from `summaries()`). */
export interface CountryEntry extends TravelWarning {
  id: string;
}
