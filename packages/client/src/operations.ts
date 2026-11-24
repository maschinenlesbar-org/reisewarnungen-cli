// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's use-case
// tools, a library user) has to know them.
// - getTravelAdvice: the warning level of one to five countries and every sentence of their
//   advisories that may advise against travel (the trip-check skill);
// - getWarnedCountries: every country under a formal travel warning, ranked by level (the
//   warned-overview skill);
// - getWarningChanges: what changed since an earlier snapshot or a date (the watch skill);
// - listCountries and getAdvisory: the list and one advisory's text, behind them.
// The traps: country names are the official German short names (USA, Russische Föderation,
// Côte d'Ivoire), so everyday and former names (Russland, Weißrussland, Holland) are mapped to
// their ISO code, and an English name goes by its code; a name several countries share (Kongo,
// Korea) is reported, never picked; content ids are no ISO codes and can change, so they are
// resolved fresh from the list; the flags record only the formal warnings, and an all-false
// country can still advise against travel in its text, so "no flag" is never "safe" until the
// text is read; the situation flags are false in the live data so far; the times are Unix
// seconds; a level change and a text revision are kept apart. No bare "not found": an empty
// answer says what was searched and what to change.

import { adviceSentences, advisoryBlocks, type AdviceSentence, type AdvisoryBlock } from "./advice.js";
import { canonicalContentId, type ReisewarnungenClient } from "./client.js";
import { ReiseValidationError, quoteValue } from "./errors.js";
import type { CountryEntry, TravelWarning } from "./types.js";
import { assertValid, normalizeToken, tokenProblem } from "./validate.js";

// ---- shared ---------------------------------------------------------------------------------

/** The most countries one {@link getTravelAdvice} call takes. */
export const MAX_TRIP_COUNTRIES = 5;

/** The most candidates an ambiguous answer lists. */
const MAX_CANDIDATES = 10;

/** The longest country name or code a lookup takes. */
const MAX_QUERY_LENGTH = 100;

/**
 * A country's formal warning level, from its strongest flag: `full` (warning: Reisewarnung),
 * `regional` (partialWarning: Teilreisewarnung), `situation` (situationWarning), `situation-part`
 * (situationPartWarning), `none` (all four false: no formal warning, which is not "safe").
 */
export type WarningLevel = "full" | "regional" | "situation" | "situation-part" | "none";

/** The order levels are ranked in: the strongest first. */
const LEVEL_RANK: Readonly<Record<WarningLevel, number>> = { full: 0, regional: 1, situation: 2, "situation-part": 3, none: 4 };

/** The four flags, in the order the levels follow them. */
const FLAGS = ["warning", "partialWarning", "situationWarning", "situationPartWarning"] as const;
type Flag = (typeof FLAGS)[number];

/** A country's level from its flags; only the boolean `true` counts (the client refuses other values). */
export function warningLevel(entry: TravelWarning): WarningLevel {
  if (entry.warning === true) return "full";
  if (entry.partialWarning === true) return "regional";
  if (entry.situationWarning === true) return "situation";
  if (entry.situationPartWarning === true) return "situation-part";
  return "none";
}

/** A country as answers name it. */
export interface CountryRef {
  /** The content id: what the API keys the country by (no ISO code; it can change). */
  id: string;
  /** The official German short name, as the Auswärtiges Amt writes it. */
  countryName?: string;
  /** ISO 3166-1 alpha-2. */
  countryCode?: string;
  /** ISO 3166-1 alpha-3. */
  iso3CountryCode?: string;
}

/** A country with its level, the flags that are set, and its dates. */
export interface CountryStatus extends CountryRef {
  level: WarningLevel;
  /** The flags that are `true` (none: no formal warning). */
  flags: Flag[];
  /** When the current advice took effect (ISO 8601, UTC; the API's Unix seconds). */
  effective?: string;
  /** When the entry was last changed (ISO 8601, UTC). */
  lastModified?: string;
  /** The advisory's title (`Thailand: Reise- und Sicherheitshinweise`). */
  title?: string;
}

/** Unix seconds as ISO 8601, or undefined when it is no time. */
function isoOf(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function refOf(entry: CountryEntry): CountryRef {
  return {
    id: entry.id,
    ...(entry.countryName === undefined ? {} : { countryName: entry.countryName }),
    ...(entry.countryCode === undefined ? {} : { countryCode: entry.countryCode }),
    ...(entry.iso3CountryCode === undefined ? {} : { iso3CountryCode: entry.iso3CountryCode }),
  };
}

/** `entry` as an answer shows it: its names, level, set flags and dates. */
export function statusOf(entry: CountryEntry): CountryStatus {
  const effective = isoOf(entry.effective);
  const lastModified = isoOf(entry.lastModified);
  return {
    ...refOf(entry),
    level: warningLevel(entry),
    flags: FLAGS.filter((flag) => entry[flag] === true),
    ...(effective === undefined ? {} : { effective }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(entry.title === undefined ? {} : { title: entry.title }),
  };
}

/** Rank by level (strongest first), then by German name. */
function byLevelThenName(a: CountryStatus, b: CountryStatus): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.countryName ?? a.id).localeCompare(b.countryName ?? b.id, "de");
}

// ---- finding a country ------------------------------------------------------------------------

/** `value` folded for comparing names: lower case, umlauts as ae/oe/ue, ß as ss, no accents. */
function fold(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Everyday and former German names that are not the official short name, to their ISO code (the
 * trip-check skill's table): several name countries under a full warning, so a miss must never
 * read as "no warning".
 */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  russland: "RU",
  weissrussland: "BY",
  palaestina: "PS",
  gaza: "PS",
  gazastreifen: "PS",
  westjordanland: "PS",
  burma: "MM",
  birma: "MM",
  elfenbeinkueste: "CI",
  grossbritannien: "GB",
  england: "GB",
  schottland: "GB",
  wales: "GB",
  uk: "GB",
  nordirland: "GB",
  osttimor: "TL",
  swasiland: "SZ",
  "kap verde": "CV",
  kapverden: "CV",
  "vereinigte staaten": "US",
  "vereinigte staaten von amerika": "US",
  amerika: "US",
  holland: "NL",
  tschechien: "CZ",
  moldawien: "MD",
  moldau: "MD",
  mazedonien: "MK",
  emirate: "AE",
  vae: "AE",
  dubai: "AE",
  vatikan: "VA",
};

/** How a country was found: its content id, its name, its ISO code, a former name, a part of its name. */
export type MatchedBy = "id" | "name" | "code" | "alias" | "part";

/** A name looked up in the list. */
export type CountryLookup =
  | { status: "ok"; query: string; entry: CountryEntry; matchedBy: MatchedBy; alsoMatching?: string[] }
  | { status: "ambiguous"; query: string; total: number; candidates: CountryStatus[] }
  | { status: "empty"; query: string; reason: string };

/** A country name, code or content id, checked: a string, not blank, no control character, at most 100 characters. */
function checkQuery(name: string, value: unknown): string {
  const query = normalizeToken(assertValid(name, value as string, tokenProblem));
  if (query.length > MAX_QUERY_LENGTH) throw new ReiseValidationError(`Invalid ${name}: at most ${MAX_QUERY_LENGTH} characters, got ${query.length}.`);
  return query;
}

const NOT_FOUND_HINT =
  "Give the official German short name (Ägypten, Vereinigtes Königreich, Russische Föderation, USA), the ISO 3166 code (EG, EGY), or a part of the German name; an English name goes by its ISO code.";

/**
 * Find the country `query` names in `entries` (the list): a content id; the official German name
 * (case, umlauts written ae/oe/ue and accents aside); an ISO alpha-2 or alpha-3 code; an everyday
 * or former name ({@link COUNTRY_ALIASES}, UK among them); else a part of the German name, of four
 * letters or more (two or three letters are only ever a code: `UK` is never the Ukraine). One exact name wins
 * over the others containing it (`Guinea`, `Sudan`: they are named in `alsoMatching`); several
 * partial matches are `ambiguous`, never picked (`Kongo`, `Korea`). None is `empty`, saying what
 * to give instead: never "no warning".
 */
export function findCountry(entries: readonly CountryEntry[], query: string): CountryLookup {
  const q = checkQuery("country", query);
  if (/^\d+$/.test(q)) {
    const id = canonicalContentId(q);
    const entry = entries.find((e) => e.id === id);
    if (entry !== undefined) return { status: "ok", query: q, entry, matchedBy: "id" };
    return { status: "empty", query: q, reason: `No country has the content id ${id} in the current list. Content ids can change: look the country up by its name or ISO code.` };
  }
  const wanted = fold(q);
  const containing = entries.filter((e) => e.countryName !== undefined && fold(e.countryName).includes(wanted));
  const exact = containing.filter((e) => fold(e.countryName as string) === wanted);
  const others = (entry: CountryEntry): string[] | undefined => {
    const names = containing.filter((e) => e !== entry).map((e) => e.countryName as string);
    return names.length === 0 ? undefined : names;
  };
  const ok = (entry: CountryEntry, matchedBy: MatchedBy): CountryLookup => {
    const also = others(entry);
    return { status: "ok", query: q, entry, matchedBy, ...(also === undefined ? {} : { alsoMatching: also }) };
  };
  if (exact.length === 1) return ok(exact[0] as CountryEntry, "name");
  const code = q.toUpperCase();
  if (/^[A-Za-z]{2}$/.test(q) || /^[A-Za-z]{3}$/.test(q)) {
    const byCode = entries.filter((e) => (q.length === 2 ? e.countryCode : e.iso3CountryCode)?.toUpperCase() === code);
    if (byCode.length === 1) return { status: "ok", query: q, entry: byCode[0] as CountryEntry, matchedBy: "code" };
  }
  const alias = COUNTRY_ALIASES[wanted];
  if (alias !== undefined) {
    const byAlias = entries.filter((e) => e.countryCode?.toUpperCase() === alias);
    if (byAlias.length === 1) return { status: "ok", query: q, entry: byAlias[0] as CountryEntry, matchedBy: "alias" };
  }
  // Two or three letters are a code (or an alias, UK): never a part of a name, which would make
  // "UK" the Ukraine and "EU" a choice between Neuseeland and Papua-Neuguinea.
  if (/^[A-Za-z]{2,3}$/.test(q)) {
    return { status: "empty", query: q, reason: `${quoteValue(q)} is no ISO 3166 code of a country in the Auswärtiges Amt's list; two or three letters are read only as a code (a part of a name needs four letters or more). ${NOT_FOUND_HINT}` };
  }
  if (containing.length === 1) return { status: "ok", query: q, entry: containing[0] as CountryEntry, matchedBy: "part" };
  if (containing.length > 1) {
    const candidates = containing.map(statusOf).sort((a, b) => (a.countryName ?? "").localeCompare(b.countryName ?? "", "de"));
    return { status: "ambiguous", query: q, total: candidates.length, candidates: candidates.slice(0, MAX_CANDIDATES) };
  }
  return { status: "empty", query: q, reason: `No country in the Auswärtiges Amt's list matches ${quoteValue(q)}. ${NOT_FOUND_HINT}` };
}

// ---- getTravelAdvice --------------------------------------------------------------------------

/**
 * The verdict for a trip, from the flags and the advisory's text:
 * - `full-warning`, `regional-warning`, `situation-warning`, `partial-situation-warning`: a
 *   formal warning (the strongest flag);
 * - `advice-in-text`: no formal warning, but sentences of the advisory may advise against travel
 *   to the country or a region (`travelAdvice`): read them before calling the country safe;
 * - `advice-only`: no formal warning and no sentence advising against travel.
 */
export type TripVerdict = "full-warning" | "regional-warning" | "situation-warning" | "partial-situation-warning" | "advice-in-text" | "advice-only";

const VERDICT_OF_LEVEL: Readonly<Record<Exclude<WarningLevel, "none">, TripVerdict>> = {
  full: "full-warning",
  regional: "regional-warning",
  situation: "situation-warning",
  "situation-part": "partial-situation-warning",
};

/** One country of a trip, resolved and read. */
export interface TripCountry extends CountryStatus {
  status: "ok";
  query: string;
  matchedBy: MatchedBy;
  /** Other countries whose name contains the query (an exact name was taken: `Sudan`, not `Südsudan`). */
  alsoMatching?: string[];
  verdict: TripVerdict;
  /** The verdict in words, with the German term. */
  verdictText: string;
  /** The advisory's own note on what changed last ("Letzte Änderungen"), item by item. */
  lastChanges: string[];
  /**
   * Every sentence that warns or advises against something and mentions travel, a stay or a part
   * of the country, with its section: the regions of a regional warning, and for an all-false
   * country the advice against travel no flag records. A text the advisory repeats (under
   * Aktuelles and again under Sicherheit) is listed once, where it first stands.
   */
  travelAdvice: AdviceSentence[];
  /** How many other warning sentences the advisory has (crowds, drugs, driving at night): getAdvisory has them. */
  otherAdvice: number;
  /** The advisory's top-level sections (Aktuelles, Sicherheit, Natur und Klima, Reiseinfos, Einreise und Zoll, Gesundheit, …). */
  sections: string[];
}

/** A name of a trip that did not resolve to one country. */
export type TripLookupFailure = Exclude<CountryLookup, { status: "ok" }>;

/** The answer of {@link getTravelAdvice}. */
export interface TripAdvice {
  /** ok: every country was found; ambiguous: a name names several (ask which); empty: a name names none. */
  status: "ok" | "ambiguous" | "empty";
  /** One line per country, then the combined verdict. */
  summary: string;
  countries: (TripCountry | TripLookupFailure)[];
}

/** The input of {@link getTravelAdvice}. */
export interface TravelAdviceInput {
  /** One to five countries: German names, ISO codes, former names or content ids. */
  countries: readonly string[];
}

/** The top-level sections of advisory blocks, in order, each once. */
function topSections(blocks: readonly AdvisoryBlock[]): string[] {
  const seen = new Set<string>();
  for (const block of blocks) {
    const top = block.section.split(" › ")[0] ?? "";
    if (top !== "") seen.add(top);
  }
  return [...seen];
}

/** Blocks as one text, each section's heading path before its first block (`Haftungsausschluss: …`). */
function textWithHeadings(blocks: readonly AdvisoryBlock[]): string {
  let section = "";
  return blocks
    .map((block) => {
      const head = block.section !== section && block.section !== "" ? `${block.section}: ` : "";
      section = block.section;
      return head + block.text;
    })
    .join(" ");
}

/** `sentences` with each text once, where it first stands. */
function onceEach(sentences: readonly AdviceSentence[]): AdviceSentence[] {
  const seen = new Set<string>();
  return sentences.filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true)));
}

/** The items of a `lastChanges` note, as text, without its label. */
function changeItems(html: unknown): string[] {
  if (typeof html !== "string") return [];
  return advisoryBlocks(html)
    .map((block) => block.text)
    .filter((text) => !/^letzte änderungen:?$/i.test(text))
    .map((text) => text.replace(/^letzte änderungen:\s*/i, ""))
    .filter((text) => text !== "");
}

function verdictText(verdict: TripVerdict, name: string, travel: number): string {
  switch (verdict) {
    case "full-warning":
      return `Full travel warning (Reisewarnung): the Auswärtiges Amt warns against all travel to ${name}.`;
    case "regional-warning":
      return `Regional travel warning (Teilreisewarnung) for parts of ${name}, not the whole country: travelAdvice names the regions.`;
    case "situation-warning":
      return `Situation warning for ${name} (situationWarning).`;
    case "partial-situation-warning":
      return `Situation warning for part of ${name} (situationPartWarning).`;
    case "advice-in-text":
      return `No formal travel warning for ${name} (all four flags false), but ${travel} sentence(s) of the advisory may advise against travel to the country or a region (travelAdvice): read them before calling it safe. One that advises against or says to avoid travel there („rät ab", „wird abgeraten", „meiden") is advice against travel, not a formal warning; sentences about crowds, demonstrations or night driving are not.`;
    case "advice-only":
      return `No formal travel warning for ${name} and no sentence in the advisory that advises against travel: advice only.`;
  }
}

/**
 * The travel advice for one to five countries: each name is resolved fresh from the list
 * ({@link findCountry}), its advisory read, and the verdict made from the advisory's own flags
 * (authoritative) and its advice sentences ({@link adviceSentences}): a formal warning by its
 * strongest flag; with all flags false, `advice-in-text` when a sentence may advise against travel
 * to the country or a region, `advice-only` only when none does. A name that names several
 * countries is `ambiguous` with the candidates, one that names none `empty` with the reason; the
 * others are read all the same.
 */
export async function getTravelAdvice(client: ReisewarnungenClient, input: TravelAdviceInput): Promise<TripAdvice> {
  const queries = input.countries;
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_TRIP_COUNTRIES) {
    throw new ReiseValidationError(`Invalid countries: Expected 1 to ${MAX_TRIP_COUNTRIES} country names, codes or content ids.`);
  }
  queries.forEach((q, i) => checkQuery(`countries[${i}]`, q));
  const entries = await client.summaries();
  const lookups = queries.map((q) => findCountry(entries, q));
  const countries: (TripCountry | TripLookupFailure)[] = [];
  const seen = new Set<string>();
  for (const lookup of lookups) {
    if (lookup.status !== "ok") {
      countries.push(lookup);
      continue;
    }
    if (seen.has(lookup.entry.id)) continue; // the same country named twice is read once
    seen.add(lookup.entry.id);
    const advisory = await client.get(lookup.entry.id);
    const entry: CountryEntry = { ...lookup.entry, ...advisory, id: lookup.entry.id };
    // An advisory repeats its key sentences under Aktuelles and Sicherheit: each text once, at its first place.
    const sentences = onceEach(adviceSentences(typeof advisory.content === "string" ? advisory.content : ""));
    const travelAdvice = sentences.filter((s) => s.travel);
    const status = statusOf(entry);
    const verdict: TripVerdict = status.level !== "none" ? VERDICT_OF_LEVEL[status.level] : travelAdvice.length > 0 ? "advice-in-text" : "advice-only";
    countries.push({
      status: "ok",
      query: lookup.query,
      matchedBy: lookup.matchedBy,
      ...(lookup.alsoMatching === undefined ? {} : { alsoMatching: lookup.alsoMatching }),
      ...status,
      verdict,
      verdictText: verdictText(verdict, entry.countryName ?? entry.id, travelAdvice.length),
      lastChanges: changeItems(advisory.lastChanges),
      travelAdvice,
      otherAdvice: sentences.length - travelAdvice.length,
      sections: topSections(advisoryBlocks(typeof advisory.content === "string" ? advisory.content : "")),
    });
  }
  const failed = countries.filter((c) => c.status !== "ok");
  const status = failed.some((c) => c.status === "ambiguous") ? "ambiguous" : failed.length > 0 ? "empty" : "ok";
  return { status, summary: tripSummary(countries), countries };
}

const VERDICT_WORDS: Readonly<Record<TripVerdict, string>> = {
  "full-warning": "full travel warning (Reisewarnung)",
  "regional-warning": "regional travel warning (Teilreisewarnung)",
  "situation-warning": "situation warning",
  "partial-situation-warning": "partial situation warning",
  "advice-in-text": "no formal warning; read the advice against travel in the text",
  "advice-only": "advice only",
};

function tripSummary(countries: readonly (TripCountry | TripLookupFailure)[]): string {
  const lines = countries.map((c) => {
    if (c.status === "ok") return `${c.countryName ?? c.id}: ${VERDICT_WORDS[c.verdict]}.`;
    if (c.status === "ambiguous") return `${quoteValue(c.query)} names ${c.total} countries (${c.candidates.map((x) => x.countryName).join(", ")}): ask which one.`;
    return `${quoteValue(c.query)}: not found in the Auswärtiges Amt's list.`;
  });
  const found = countries.filter((c): c is TripCountry => c.status === "ok");
  if (found.length > 1) {
    const warned = found.filter((c) => c.verdict !== "advice-in-text" && c.verdict !== "advice-only");
    lines.push(
      warned.length === 0
        ? `None of the ${found.length} countries has a formal travel warning.`
        : `Of ${found.length} countries, ${warned.length} ${warned.length === 1 ? "carries" : "carry"} a formal warning: ${warned.map((c) => `${c.countryName ?? c.id} (${VERDICT_WORDS[c.verdict]})`).join(", ")}.`,
    );
  }
  return lines.join(" ");
}

// ---- getWarnedCountries ---------------------------------------------------------------------

/** The input of {@link getWarnedCountries}. */
export interface WarnedCountriesInput {
  /** Only this level (default: every formal warning). */
  level?: Exclude<WarningLevel, "none"> | undefined;
}

/** The answer of {@link getWarnedCountries}. */
export interface WarnedCountries {
  status: "ok" | "empty";
  /** The totals in words: the headline. */
  verdict: string;
  /** How many countries the list holds. */
  listed: number;
  /** How many have a formal warning (any flag). */
  warned: number;
  /** Warned countries per level. */
  byLevel: Record<Exclude<WarningLevel, "none">, number>;
  /** The warned countries (of `level`, if given), the strongest level first, then by name. */
  countries: CountryStatus[];
  reason?: string;
}

const LEVELS = ["full", "regional", "situation", "situation-part"] as const;

/**
 * Every country under a formal travel warning, ranked: full warnings (Reisewarnung) first, then
 * regional (Teilreisewarnung), then the situation flags (false in the live data so far), each by
 * German name. Formal warnings only: advice against travel without a flag (Jordanien, Türkei) is
 * in the advisory texts ({@link getTravelAdvice}). The list holding no warned country is said
 * plainly, never confused with a failure (a broken list is an error of the client).
 */
export async function getWarnedCountries(client: ReisewarnungenClient, input: WarnedCountriesInput = {}): Promise<WarnedCountries> {
  const level = input.level;
  if (level !== undefined && !(LEVELS as readonly string[]).includes(level)) {
    throw new ReiseValidationError(`Invalid level ${quoteValue(String(level))}: Expected one of ${LEVELS.join(", ")}.`);
  }
  const entries = await client.summaries();
  const warned = entries.map(statusOf).filter((c) => c.level !== "none").sort(byLevelThenName);
  const byLevel = { full: 0, regional: 0, situation: 0, "situation-part": 0 };
  for (const c of warned) byLevel[c.level as keyof typeof byLevel] += 1;
  const countries = level === undefined ? warned : warned.filter((c) => c.level === level);
  const verdict =
    `${warned.length} of ${entries.length} countries have a formal travel warning: ${byLevel.full} full (Reisewarnung), ${byLevel.regional} regional (Teilreisewarnung)` +
    (byLevel.situation + byLevel["situation-part"] > 0 ? `, ${byLevel.situation} situation, ${byLevel["situation-part"]} partial situation` : "") +
    ". Formal warnings only: advice against travel without a flag is in the advisory texts.";
  if (countries.length === 0) {
    const reason =
      level === undefined
        ? "The Auswärtiges Amt lists no formal travel warning right now. Advice against travel without a flag is in the advisory texts (getTravelAdvice)."
        : `No country has a warning of level ${level} right now (the situation flags have been false in the live data so far).`;
    return { status: "empty", verdict, listed: entries.length, warned: warned.length, byLevel, countries, reason };
  }
  return { status: "ok", verdict, listed: entries.length, warned: warned.length, byLevel, countries };
}

// ---- getWarningChanges ------------------------------------------------------------------------

/** The prefix of a snapshot string; another prefix is refused. */
const SNAPSHOT_PREFIX = "rw1";

/** The most countries of the recent list (freshness view). */
export const MAX_RECENT = 200;

/** A snapshot read back: when it was taken (its newest lastModified), how many countries, the warned ones' flags. */
interface Snapshot {
  asOf: number;
  listed: number;
  /** content id -> flag bits (warning 8, partialWarning 4, situationWarning 2, situationPartWarning 1). */
  warned: Map<string, number>;
}

function bitsOf(entry: TravelWarning): number {
  return FLAGS.reduce((bits, flag, i) => (entry[flag] === true ? bits | (8 >> i) : bits), 0);
}

function flagsOfBits(bits: number): Flag[] {
  return FLAGS.filter((_, i) => (bits & (8 >> i)) !== 0);
}

/** The watch skill's level: full, partial (regional or a situation flag) or none. */
function watchLevel(bits: number): 0 | 1 | 2 {
  return (bits & 8) !== 0 ? 2 : bits !== 0 ? 1 : 0;
}

const WATCH_LEVEL_NAMES = ["none", "partial", "full"] as const;

/**
 * The snapshot of `entries` as a short string to keep and pass back: the newest lastModified, the
 * number of countries and the flags of the warned ones (`rw1:1794991261:200:201558-4,208258-8`).
 * Unwarned countries are not listed (their flags are all false); a text revision shows as a
 * lastModified after the snapshot's newest.
 */
export function snapshotOf(entries: readonly CountryEntry[]): string {
  const asOf = entries.reduce((max, e) => (typeof e.lastModified === "number" && e.lastModified > max ? e.lastModified : max), 0);
  const warned = entries
    .filter((e) => bitsOf(e) !== 0)
    .map((e) => `${e.id}-${bitsOf(e).toString(16)}`)
    .sort();
  return `${SNAPSHOT_PREFIX}:${Math.floor(asOf)}:${entries.length}:${warned.join(",")}`;
}

/** A snapshot string read back; a malformed one is a ReiseValidationError naming the fix. */
export function parseSnapshot(text: string): Snapshot {
  const bad = (why: string): never => {
    throw new ReiseValidationError(`Invalid previous snapshot: ${why} Pass the snapshot string of an earlier getWarningChanges answer unchanged, or leave it out to start one.`);
  };
  if (typeof text !== "string") return bad("Expected a string.");
  const parts = text.trim().split(":");
  if (parts.length !== 4 || parts[0] !== SNAPSHOT_PREFIX) return bad(`Expected "${SNAPSHOT_PREFIX}:<time>:<count>:<warned countries>".`);
  const [, asOfText, listedText, warnedText] = parts as [string, string, string, string];
  if (!/^\d{1,12}$/.test(asOfText) || !/^\d{1,4}$/.test(listedText)) return bad("The time or the count is not a number.");
  const warned = new Map<string, number>();
  for (const item of warnedText === "" ? [] : warnedText.split(",")) {
    const match = /^(\d{1,12})-([0-9a-f])$/.exec(item);
    if (match === null || match[2] === "0") return bad(`${quoteValue(item)} is no "<content id>-<flags>" entry.`);
    warned.set(match[1] as string, Number.parseInt(match[2] as string, 16));
  }
  return { asOf: Number(asOfText), listed: Number(listedText), warned };
}

/** A country whose level or flags changed. */
export interface LevelChange extends CountryRef {
  from: (typeof WATCH_LEVEL_NAMES)[number];
  to: (typeof WATCH_LEVEL_NAMES)[number];
  /** The flags set before and now. */
  flagsBefore: Flag[];
  flagsNow: Flag[];
  /** True when the country is no longer in the list at all. */
  gone?: true;
  lastModified?: string;
}

/** The changes since a snapshot, by class; a level change is never also a text update. */
export interface WarningChanges {
  newlyWarned: LevelChange[];
  escalated: LevelChange[];
  downgraded: LevelChange[];
  lifted: LevelChange[];
  /** Same level, other flags (partialWarning -> situationPartWarning): not a text-only edit. */
  flagsChanged: LevelChange[];
  /** Same flags, the advisory text revised since the snapshot (lastModified after it). */
  updated: CountryStatus[];
}

/** The input of {@link getWarningChanges}. */
export interface WarningChangesInput {
  /** The snapshot string of an earlier answer: the changes since then. */
  previous?: string | undefined;
  /** A date or time (ISO 8601): the countries whose advisory changed since then, newest first. */
  since?: string | undefined;
  /** The most countries in `recent` (1–200; default 15). */
  limit?: number | undefined;
}

/** The answer of {@link getWarningChanges}. */
export interface WarningChangesAnswer {
  status: "ok";
  /** The changes in words. */
  verdict: string;
  /** Keep it and pass it back as `previous` next time. */
  snapshot: string;
  /** The changes since `previous`. */
  changes?: WarningChanges;
  /** When the previous snapshot's newest change was (ISO 8601). */
  previousAsOf?: string;
  /** The countries changed since `since` (or the most recently changed, without `previous`), newest first, with their level. */
  recent?: CountryStatus[];
  /** How many countries changed since `since` in all (recent holds the first `limit`). */
  recentTotal?: number;
}

/** `since` as Unix seconds; a date that is no date is a ReiseValidationError. */
function sinceSeconds(since: string): number {
  const text = since.trim();
  const ms = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text) ? Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text) : Number.NaN;
  if (Number.isNaN(ms)) throw new ReiseValidationError(`Invalid since ${quoteValue(since)}: Expected a date or time in ISO 8601 (2026-11-12 or 2026-11-12T08:00:00Z).`);
  return ms / 1000;
}

/**
 * What changed in the travel warnings: with `previous` (a snapshot of an earlier answer), the
 * countries newly warned, escalated (partial -> full), downgraded, lifted (or gone from the list),
 * with other flags at the same level, and those whose text was revised with the same flags; with
 * `since` (a date), the countries whose advisory changed since then, newest first, with their
 * level; with neither, the most recently changed. Every answer carries the snapshot to pass back
 * next time. Levels are compared, never only "warned or not", so an escalation never reads as a
 * text update.
 */
export async function getWarningChanges(client: ReisewarnungenClient, input: WarningChangesInput = {}): Promise<WarningChangesAnswer> {
  const previous = input.previous === undefined ? undefined : parseSnapshot(input.previous);
  const since = input.since === undefined ? undefined : sinceSeconds(input.since);
  const limit = input.limit ?? 15;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECENT) throw new ReiseValidationError(`Invalid limit: Expected a whole number from 1 to ${MAX_RECENT}.`);
  const entries = await client.summaries();
  const snapshot = snapshotOf(entries);
  const answer: WarningChangesAnswer = { status: "ok", verdict: "", snapshot };
  const parts: string[] = [];

  if (previous !== undefined) {
    const changes: WarningChanges = { newlyWarned: [], escalated: [], downgraded: [], lifted: [], flagsChanged: [], updated: [] };
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const entry of entries) {
      const before = previous.warned.get(entry.id) ?? 0;
      const now = bitsOf(entry);
      const from = watchLevel(before);
      const to = watchLevel(now);
      const lastModified = isoOf(entry.lastModified);
      const change = (): LevelChange => ({
        ...refOf(entry),
        from: WATCH_LEVEL_NAMES[from],
        to: WATCH_LEVEL_NAMES[to],
        flagsBefore: flagsOfBits(before),
        flagsNow: flagsOfBits(now),
        ...(lastModified === undefined ? {} : { lastModified }),
      });
      if (from === 0 && to > 0) changes.newlyWarned.push(change());
      else if (from > 0 && to === 0) changes.lifted.push(change());
      else if (to > from) changes.escalated.push(change());
      else if (to < from) changes.downgraded.push(change());
      else if (before !== now) changes.flagsChanged.push(change());
      else if (typeof entry.lastModified === "number" && entry.lastModified > previous.asOf) changes.updated.push(statusOf(entry));
    }
    for (const [id, bits] of previous.warned) {
      if (byId.has(id)) continue;
      changes.lifted.push({ id, from: WATCH_LEVEL_NAMES[watchLevel(bits)], to: "none", flagsBefore: flagsOfBits(bits), flagsNow: [], gone: true });
    }
    changes.updated.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
    answer.changes = changes;
    const previousAsOf = isoOf(previous.asOf);
    if (previousAsOf !== undefined) answer.previousAsOf = previousAsOf;
    const levelChanges = changes.newlyWarned.length + changes.escalated.length + changes.downgraded.length + changes.lifted.length + changes.flagsChanged.length;
    parts.push(
      levelChanges === 0 && changes.updated.length === 0
        ? "Nothing changed since the previous snapshot."
        : `Since the previous snapshot: ${changes.newlyWarned.length} newly warned, ${changes.escalated.length} escalated, ${changes.downgraded.length} downgraded, ${changes.lifted.length} lifted, ${changes.flagsChanged.length} with other flags at the same level; ${changes.updated.length} advisories revised with the same flags.`,
    );
    if (previous.listed !== entries.length) parts.push(`The list held ${previous.listed} countries then and ${entries.length} now.`);
  }

  if (since !== undefined || previous === undefined) {
    const changed = entries
      .filter((e) => since === undefined || (typeof e.lastModified === "number" && e.lastModified > since))
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
      .map(statusOf);
    answer.recent = changed.slice(0, limit);
    answer.recentTotal = changed.length;
    parts.push(
      since === undefined
        ? `The ${answer.recent.length} most recently changed advisories, newest first (no previous snapshot: keep this answer's snapshot to compare next time).`
        : `${changed.length} advisories changed since ${input.since?.trim()}, newest first; a change may be a text revision only (compare the level with a snapshot).`,
    );
  }
  parts.push('Level "none" is no formal warning, not "safe": the advisory text may still advise against travel.');
  answer.verdict = parts.join(" ");
  return answer;
}

// ---- generic: listCountries, getAdvisory ------------------------------------------------------

/** The input of {@link listCountries}. */
export interface ListCountriesInput {
  /** Only the countries with a warning of any kind in force. */
  warnedOnly?: boolean | undefined;
}

/** Every country of the list with its level and dates, by German name. */
export async function listCountries(client: ReisewarnungenClient, input: ListCountriesInput = {}): Promise<CountryStatus[]> {
  const entries = await client.summaries({ warnedOnly: input.warnedOnly === true });
  return entries.map(statusOf).sort((a, b) => (a.countryName ?? a.id).localeCompare(b.countryName ?? b.id, "de"));
}

/** The input of {@link getAdvisory}. */
export interface AdvisoryInput {
  /** A German name, an ISO code, a former name or a content id. */
  country: string;
  /**
   * Only the blocks of this section: the top-level sections that start with the text (`Sicherheit`,
   * `Einreise`, `Gesundheit`), else the blocks whose heading path contains it (`Visum`, `Impfschutz`).
   */
  section?: string | undefined;
}

/** The answer of {@link getAdvisory}. */
export type AdvisoryAnswer =
  | (CountryStatus & {
      status: "ok";
      query: string;
      matchedBy: MatchedBy;
      lastChanges: string[];
      /** The top-level sections of the whole advisory. */
      sections: string[];
      /** The advisory's text, block by block (a paragraph or a list item), with its section; all of it, or the blocks of `section`. */
      blocks: AdvisoryBlock[];
      /** The Auswärtiges Amt's disclaimer (Haftungsausschluss), as text. */
      disclaimer?: string;
    })
  | TripLookupFailure
  | { status: "empty"; query: string; reason: string; sections: string[] };

/**
 * One country's whole advisory as text: the flags and dates, the "Letzte Änderungen" note, and
 * every block with its section (or the blocks of one section). The text is the advisory's own,
 * tags dropped and nothing reworded. A content id is read directly; any other name is looked up
 * in the list first ({@link findCountry}).
 */
export async function getAdvisory(client: ReisewarnungenClient, input: AdvisoryInput): Promise<AdvisoryAnswer> {
  const query = checkQuery("country", input.country);
  const section = input.section === undefined ? undefined : checkQuery("section", input.section);
  let lookup: CountryLookup;
  if (/^\d+$/.test(query)) {
    lookup = { status: "ok", query, entry: { id: canonicalContentId(query) }, matchedBy: "id" };
  } else {
    lookup = findCountry(await client.summaries(), query);
  }
  if (lookup.status !== "ok") return lookup;
  const advisory = await client.get(lookup.entry.id);
  const entry: CountryEntry = { ...lookup.entry, ...advisory, id: lookup.entry.id };
  const all = advisoryBlocks(typeof advisory.content === "string" ? advisory.content : "");
  const sections = topSections(all);
  const wanted = section === undefined ? undefined : fold(section);
  // A top-level section that starts with the text wins (`Sicherheit` is that section, not also
  // `Aktuelles › Sicherheitslage …`); else any heading of the path that contains it (`Visum`).
  const top = (b: AdvisoryBlock): string => fold(b.section.split(" › ")[0] ?? "");
  const blocks =
    wanted === undefined
      ? all
      : all.some((b) => top(b).startsWith(wanted))
        ? all.filter((b) => top(b).startsWith(wanted))
        : all.filter((b) => fold(b.section).includes(wanted));
  if (blocks.length === 0 && wanted !== undefined) {
    return { status: "empty", query, reason: `The advisory of ${entry.countryName ?? entry.id} has no section matching ${quoteValue(section as string)}; its sections are listed in sections.`, sections };
  }
  const disclaimer = typeof advisory.disclaimer === "string" ? textWithHeadings(advisoryBlocks(advisory.disclaimer)) : "";
  return {
    status: "ok",
    query,
    matchedBy: lookup.matchedBy,
    ...statusOf(entry),
    lastChanges: changeItems(advisory.lastChanges),
    sections,
    blocks,
    ...(disclaimer === "" ? {} : { disclaimer }),
  };
}
