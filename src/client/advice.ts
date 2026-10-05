// Advice against travel, extracted from an advisory's HTML `content`.
//
// The four warning flags record only the formal levels (Reisewarnung, Teilreisewarnung).
// Below them, the Auswärtiges Amt advises against travel in the text alone, in a graded and
// varied vocabulary: „wird (dringend) abgeraten", „rät … ab", „Vermeiden Sie … Reisen",
// „Meiden Sie möglichst Reisen …", „… sollte … gemieden werden". A two-keyword grep
// („abgeraten|gewarnt") missed the last three (Türkei, Angola, Bangladesch on 2026-10-05) and
// gave those countries an "advice only" all-clear. This module finds every sentence that uses
// any of the phrasings in ADVICE_PATTERNS, as whole sentences: it splits at block elements
// (paragraphs, list items, headings), not at the full stop of „z. B." or „o.g.", and a sentence
// that introduces a list („Von Reisen in folgende Regionen wird abgeraten:") carries the
// list's items. Each sentence names the section it stands in and whether it mentions travel or
// a region (`travel`), so a reader can drop the ones about crowds or drugs — but nothing that
// advises against travel is ever dropped by the extraction itself.

/** One sentence of an advisory that uses an advise-against or warning phrasing. */
export interface AdviceSentence {
  /** The headings it stands under, outermost first, joined with " › " (`Sicherheit › Terrorismus`). */
  section: string;
  /** The sentence as plain text (tags removed, entities decoded, whitespace collapsed). */
  text: string;
  /**
   * True when the sentence also mentions travel, a stay or a part of the country (Reise,
   * Aufenthalt, Region, Gebiet, Provinz, Grenze, Landesteil, …; see TRAVEL_PATTERN). Such a
   * sentence may advise against travel to the country or a region and must be read; one
   * without it is about something else (crowds, drugs, driving at night).
   */
  travel: boolean;
}

/**
 * The phrasings that mark a warning or advice against something, matched case-insensitively
 * per sentence: the passive and active „abraten" forms, „warnen", the formal terms, every
 * form of „meiden"/„vermeiden" (Meiden Sie, vermeiden Sie, gemieden, vermieden), „verzichten",
 * „unterlassen"/„unterbleiben", „aufgefordert" (… das Land zu verlassen), and „nicht" with
 * „reisen"/„aufsuchen"/„besuchen". Exported so the documentation and tests name the same list.
 */
export const ADVICE_PATTERNS: readonly RegExp[] = [
  /abgeraten|abzuraten/iu,
  word("rät|raten", "[^]*", "ab"),
  /gewarnt/iu,
  word("warnt|warnen"),
  /reisewarnung/iu,
  /meiden|meidet|gemieden|vermieden/iu,
  /verzicht/iu,
  /unterlassen|unterbleiben/iu,
  /aufgefordert/iu,
  word("nicht", "[^]*", "reisen|bereisen|bereist|aufsuchen|aufgesucht|besuchen|besucht"),
];

/**
 * A case-insensitive pattern for whole words (`\b` is ASCII-only in JavaScript, so `\brät\b`
 * never matches before a space): the first alternation, then optionally `gap` and further
 * whole-word alternations in order.
 */
function word(first: string, gap?: string, then?: string): RegExp {
  const w = (alternatives: string): string => `(?<!\\p{L})(?:${alternatives})(?!\\p{L})`;
  return new RegExp(w(first) + (gap !== undefined && then !== undefined ? gap + w(then) : ""), "iu");
}

/** Words that tie a sentence to travel or a part of the country (see AdviceSentence.travel). */
export const TRAVEL_PATTERN =
  /reise|fahrt|aufenthalt|region|gebiet|provinz|grenz|landesteil|bundesstaat|distrikt|bezirk|departement|gegend|insel|(?<!\p{L})(?:land|landes|teil|teilen|stadt|städte|norden|süden|osten|westen|nordosten|südosten|nordwesten|südwesten)(?!\p{L})/iu;

/** Tags that end a block of text (a paragraph, list item, heading, line break, table cell). */
const BLOCK_TAGS = new Set([
  "p", "li", "ul", "ol", "div", "blockquote", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "button", "table", "tr", "td", "th", "dt", "dd", "section", "article", "header", "footer",
]);

/** Heading level per heading tag; an accordion `<button>` opens a top-level section. */
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6, button: 2 };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", auml: "ä", ouml: "ö",
  uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ndash: "–", mdash: "—", bdquo: "„",
  ldquo: "“", rdquo: "”", sbquo: "‚", lsquo: "‘", rsquo: "’", hellip: "…", euro: "€",
  eacute: "é", egrave: "è", aacute: "á", agrave: "à", ccedil: "ç", oacute: "ó", iacute: "í",
  uacute: "ú", ntilde: "ñ", laquo: "«", raquo: "»", middot: "·", deg: "°",
};

/** Decode the HTML character references in a text run. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/** Collapse whitespace and drop invisible characters (soft hyphen, zero-width, BOM). */
function cleanText(text: string): string {
  return text.replace(/[­​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

interface Block {
  text: string;
  section: string;
  /** The list a list item belongs to (undefined for anything else). */
  list: number | undefined;
}

/** Split advisory HTML into text blocks, each with the heading path it stands under. */
function blocksOf(html: string): Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let heading: { level: number; text: string } | undefined;
  let buffer = "";
  let currentList: number | undefined;
  const lists: number[] = [];
  let listCounter = 0;
  let inItem = false;
  let skip = 0; // inside <script>/<style>

  const flush = (): void => {
    const text = cleanText(buffer);
    buffer = "";
    if (text === "") return;
    blocks.push({ text, section: headings.filter((h) => h !== "").join(" › "), list: inItem ? currentList : undefined });
  };

  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<!--[^]*?-->|[^<]+|</g)) {
    const [token, closing, rawName] = m;
    if (rawName === undefined) {
      if (token.startsWith("<!--") || skip > 0) continue;
      const text = decodeEntities(token === "<" ? "<" : token);
      if (heading !== undefined) heading.text += text;
      else buffer += text;
      continue;
    }
    const name = rawName.toLowerCase();
    if (name === "script" || name === "style") {
      skip += closing ? -1 : 1;
      if (skip < 0) skip = 0;
      continue;
    }
    const level = HEADING_LEVEL[name];
    if (level !== undefined) {
      if (!closing) {
        flush();
        heading = { level, text: "" };
      } else if (heading !== undefined) {
        headings.length = heading.level - 1;
        for (let i = 0; i < heading.level - 1; i++) headings[i] ??= "";
        headings[heading.level - 1] = cleanText(heading.text);
        heading = undefined;
      }
      continue;
    }
    if (!BLOCK_TAGS.has(name)) {
      // An inline element (span, strong, a, abbr, …) is part of the running text; keep the
      // words apart where it would glue them (`<br/>`-less line ends are blocks already).
      continue;
    }
    if (heading !== undefined) continue;
    flush();
    if (name === "ul" || name === "ol") {
      if (!closing) {
        listCounter += 1;
        lists.push(listCounter);
        currentList = listCounter;
      } else {
        lists.pop();
        currentList = lists[lists.length - 1];
      }
    } else if (name === "li") {
      inItem = !closing;
    }
  }
  flush();
  return blocks;
}

/** Words that end in a full stop without ending a sentence (lower-case, without the dot). */
const ABBREVIATIONS = new Set([
  "bzw", "ca", "ggf", "evtl", "inkl", "nr", "str", "st", "dr", "vgl", "sog", "usw", "etc", "tel",
  "mio", "mrd", "bspw", "insb", "max", "min", "abs", "art", "gem", "lt", "einschl", "zzgl", "zzt",
  "jan", "feb", "mär", "apr", "jun", "jul", "aug", "sep", "sept", "okt", "nov", "dez", "prof", "ff",
  "mind", "ehem", "std", "km", "bzgl", "chr", "zt", "ggü", "allg", "bes", "ehem", "kath", "evang",
]);

/** True when `token` (the word before a full stop, dot included) is an abbreviation or ordinal. */
function isAbbreviation(token: string): boolean {
  const word = token.replace(/^[(„"»‚'[]+/, "");
  if (/^\d{1,2}\.$/.test(word)) return true; // „am 5. Oktober", „3. Stock"
  if (/^\p{L}\.$/u.test(word)) return true; // „z.", „B.", „u." in „z. B.", „u. a."
  if (/^(?:\p{L}{1,2}\.){2,}$/u.test(word)) return true; // „o.g.", „z.B.", „i.d.R."
  return ABBREVIATIONS.has(word.slice(0, -1).toLowerCase());
}

/** Split a block of text into sentences, not at abbreviations or ordinals. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=\s+["„»‚'(]?[\p{Lu}\d])/gu)) {
    const end = m.index + 1;
    const piece = text.slice(start, end);
    if (m[0] === "." && isAbbreviation(/(\S+)$/.exec(piece)?.[1] ?? "")) continue;
    sentences.push(piece.trim());
    start = end;
  }
  sentences.push(text.slice(start).trim());
  return sentences.filter((s) => s !== "");
}

/** Whether a sentence uses one of the ADVICE_PATTERNS. */
export function isAdviceSentence(text: string): boolean {
  return ADVICE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Every sentence of an advisory's HTML `content` that warns or advises against something
 * (ADVICE_PATTERNS), in document order, each with its section path and the `travel` mark.
 * A sentence ending in ":" (or unfinished) that is followed by a list carries the list's
 * items („… wird dringend abgeraten: Bundesstaat Colima; Bundesstaat Guerrero, …"), and a
 * lower-case paragraph right after the list that finishes it („wird abgeraten."). Duplicates
 * (the same text in the same section) are dropped. Never throws on odd HTML; a non-string
 * gives `[]`.
 */
export function adviceSentences(html: string): AdviceSentence[] {
  if (typeof html !== "string" || html === "") return [];
  const blocks = blocksOf(html);
  const result: AdviceSentence[] = [];
  const seen = new Set<string>();
  const add = (section: string, text: string): void => {
    if (!isAdviceSentence(text)) return;
    const key = `${section}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ section, text, travel: TRAVEL_PATTERN.test(text) });
  };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const sentences = splitSentences(block.text);
    const last = sentences[sentences.length - 1] ?? "";
    const next = blocks[i + 1];
    // A sentence that runs into a list: one that introduces it („… wird abgeraten:") or one
    // the list completes („Von Reisen" · items · „wird abgeraten." — Tunesien, 2026-10-06).
    const open = last.endsWith(":") || !/[.!?…"“”)]$/.test(last);
    if (open && next !== undefined && next.list !== undefined && next.list !== block.list) {
      const items: string[] = [];
      let j = i + 1;
      while (j < blocks.length && blocks[j]!.list === next.list) {
        items.push(blocks[j]!.text.replace(/[.;,]$/, ""));
        j++;
      }
      let whole = `${last} ${items.join("; ")}`;
      // The rest of the sentence after the list starts in lower case („wird abgeraten.").
      const after = blocks[j];
      let rest: string[] = [];
      if (after !== undefined && after.list === undefined && /^\p{Ll}/u.test(after.text)) {
        const tail = splitSentences(after.text);
        whole += ` ${tail[0] ?? ""}`;
        rest = tail.slice(1);
        j++;
      } else if (!/[.!?]$/.test(whole)) {
        whole += ".";
      }
      if (isAdviceSentence(whole)) {
        for (const sentence of sentences.slice(0, -1)) add(block.section, sentence);
        add(block.section, whole);
        for (const sentence of rest) add(after!.section, sentence);
        i = j - 1; // the items (and the tail) are part of this sentence
        continue;
      }
    }
    for (const sentence of sentences) add(block.section, sentence);
  }
  return result;
}
