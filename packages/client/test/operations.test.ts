// The skills' use cases against a mock of the API with recorded answers (fixtures.ts), the
// skills' traps as cases: German short names, ISO codes and former names; a name several
// countries share reported, never picked; "no flag" never read as safe while the text advises
// against travel; the advisory's own flags; levels compared, not "warned or not"; Unix seconds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReisewarnungenClient } from "../src/client.js";
import { ReiseNetworkError, ReiseParseError, ReiseValidationError } from "../src/errors.js";
import {
  findCountry,
  getAdvisory,
  getTravelAdvice,
  getWarnedCountries,
  getWarningChanges,
  listCountries,
  parseSnapshot,
  snapshotOf,
  warningLevel,
  type TripCountry,
  type TripReadFailure,
} from "../src/operations.js";
import type { CountryEntry } from "../src/types.js";
import { COUNTRIES, MALI, OESTERREICH, THAILAND, TUERKEI, reiseApi, type ListFixture } from "./fixtures.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

const clientOf = (transport = reiseApi()) => new ReisewarnungenClient({ transport: transport.transport, maxRetries: 0 });
const ENTRIES: CountryEntry[] = Object.entries(COUNTRIES).map(([id, entry]) => ({ id, ...entry }));
const name = (id: string) => COUNTRIES[id]?.countryName;

test("findCountry: the official German name, case and umlaut spelling aside", () => {
  for (const query of ["Thailand", "thailand", "Türkei", "tuerkei", "TÜRKEI", "Vereinigtes Königreich", "vereinigtes koenigreich", "cote d’ivoire", "Côte d'Ivoire"]) {
    const found = findCountry(ENTRIES, query);
    assert.equal(found.status, "ok", query);
    assert.equal(found.status === "ok" && found.matchedBy, "name", query);
  }
  const usa = findCountry(ENTRIES, "USA");
  assert.equal(usa.status === "ok" && usa.entry.countryName, "USA");
});

test("findCountry: an English request goes by ISO alpha-2 or alpha-3 code", () => {
  for (const [query, expected] of [["TH", "Thailand"], ["tha", "Thailand"], ["EG", "Ägypten"], ["EGY", "Ägypten"], ["us", "USA"]]) {
    const found = findCountry(ENTRIES, query as string);
    assert.equal(found.status === "ok" && found.entry.countryName, expected, query);
  }
});

test("findCountry: two or three letters that are no ISO code are never a part of a name (UK is the United Kingdom, not Ukraine)", () => {
  const ukraine: CountryEntry = { id: "201946", countryName: "Ukraine", countryCode: "UA", iso3CountryCode: "UKR", warning: true, partialWarning: false };
  const neuseeland: CountryEntry = { id: "205670", countryName: "Neuseeland", countryCode: "NZ", iso3CountryCode: "NZL", warning: false, partialWarning: false };
  const entries = [...ENTRIES, ukraine, neuseeland];
  for (const query of ["UK", "uk"]) {
    const found = findCountry(entries, query);
    assert.equal(found.status === "ok" && found.entry.countryName, "Vereinigtes Königreich", query);
    assert.equal(found.status === "ok" && found.matchedBy, "alias", query);
  }
  for (const query of ["EU", "kra", "ine"]) {
    const found = findCountry(entries, query);
    assert.equal(found.status, "empty", query);
    assert.match(found.status === "empty" ? found.reason : "", /no ISO 3166 code/, query);
  }
  const ukr = findCountry(entries, "UKR");
  assert.equal(ukr.status === "ok" && ukr.matchedBy, "code");
  const part = findCountry(entries, "Ukra");
  assert.equal(part.status === "ok" && part.matchedBy, "part");
});

test("findCountry: everyday and former names map to the country (several are under a full warning)", () => {
  for (const [query, expected] of [
    ["Russland", "Russische Föderation"],
    ["Weißrussland", "Belarus"],
    ["Weissrussland", "Belarus"],
    ["Palästina", "Palästinensische Gebiete*"],
    ["Gaza", "Palästinensische Gebiete*"],
    ["Elfenbeinküste", "Côte d'Ivoire"],
    ["Großbritannien", "Vereinigtes Königreich"],
    ["England", "Vereinigtes Königreich"],
    ["Holland", "Niederlande"],
    ["Vereinigte Staaten", "USA"],
  ]) {
    const found = findCountry(ENTRIES, query as string);
    assert.equal(found.status === "ok" && found.entry.countryName, expected, query);
    assert.equal(found.status === "ok" && found.matchedBy, "alias", query);
  }
});

test("findCountry: a name two countries share is ambiguous with both, never picked (the two Kongos carry different warnings)", () => {
  const kongo = findCountry(ENTRIES, "Kongo");
  assert.equal(kongo.status, "ambiguous");
  assert.deepEqual(kongo.status === "ambiguous" && kongo.candidates.map((c) => [c.countryName, c.level]), [
    ["Demokratische Republik Kongo", "regional"],
    ["Republik Kongo", "none"],
  ]);
  const korea = findCountry(ENTRIES, "korea");
  assert.equal(korea.status === "ambiguous" && korea.total, 2);
});

test("findCountry: an exact name wins over the names containing it, which are named (Sudan, not Südsudan; Guinea of four)", () => {
  const sudan = findCountry(ENTRIES, "Sudan");
  assert.equal(sudan.status === "ok" && sudan.entry.countryName, "Sudan");
  assert.deepEqual(sudan.status === "ok" && sudan.alsoMatching, ["Südsudan"]);
  const guinea = findCountry(ENTRIES, "Guinea");
  assert.equal(guinea.status === "ok" && guinea.entry.countryName, "Guinea");
  assert.equal(guinea.status === "ok" && guinea.alsoMatching?.length, 3);
});

test("findCountry: a part of one name is that country; nothing found is empty with what to give, never 'no warning'", () => {
  const part = findCountry(ENTRIES, "Palästin");
  assert.equal(part.status === "ok" && part.matchedBy, "part");
  const none = findCountry(ENTRIES, "Narnia");
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /No country in the Auswärtiges Amt's list matches "Narnia"\. Give the official German short name .* ISO 3166 code/);
});

test("findCountry: a content id is looked up as the number it is; one the list lacks is empty, saying ids can change", () => {
  const found = findCountry(ENTRIES, ` 0${THAILAND} `);
  assert.equal(found.status === "ok" && found.matchedBy, "id");
  assert.equal(found.status === "ok" && found.entry.countryName, "Thailand");
  const gone = findCountry(ENTRIES, "999999");
  assert.match(gone.status === "empty" ? gone.reason : "", /no country has the content id 999999.*can change/i);
});

test("findCountry: a blank or invisible name, or one over 100 characters, is refused", () => {
  for (const bad of ["", "  ", "Thai​land", "x".repeat(101)]) assert.throws(() => findCountry(ENTRIES, bad), ReiseValidationError, JSON.stringify(bad));
});

test("warningLevel: the strongest flag; only true counts", () => {
  assert.equal(warningLevel({ warning: true, partialWarning: true }), "full");
  assert.equal(warningLevel({ warning: false, partialWarning: true }), "regional");
  assert.equal(warningLevel({ situationPartWarning: true }), "situation-part");
  assert.equal(warningLevel({ warning: false, partialWarning: false, situationWarning: false, situationPartWarning: false }), "none");
});

test("getTravelAdvice: a full warning, a regional one with its regions, advice against travel without a flag, and advice only", async () => {
  const transport = reiseApi();
  const answer = await getTravelAdvice(clientOf(transport), { countries: ["Mali", "Thailand", "Türkei", "Österreich"] });
  assert.equal(answer.status, "ok");
  assert.equal(transport.calls.length, 5, "the list once, then one advisory per country");
  const [mali, thailand, tuerkei, oesterreich] = answer.countries as TripCountry[];
  assert.equal(mali?.verdict, "full-warning");
  assert.match(mali?.verdictText ?? "", /^Full travel warning \(Reisewarnung\): the Auswärtiges Amt warns against all travel to Mali\.$/);
  assert.ok(mali?.travelAdvice.some((s) => s.text === "Vor Reisen nach Mali wird gewarnt."));
  assert.equal(thailand?.verdict, "regional-warning");
  assert.ok(thailand?.travelAdvice.some((s) => /Narathiwat, Yala und Pattani/.test(s.text)), "the regions are named");
  // Türkei: four false flags, yet the text advises against travel to the border areas.
  assert.deepEqual(tuerkei?.flags, []);
  assert.equal(tuerkei?.verdict, "advice-in-text");
  assert.ok(tuerkei?.travelAdvice.some((s) => s.text.startsWith("Vermeiden Sie alle nicht zwingend erforderlichen Reisen")));
  assert.match(tuerkei?.verdictText ?? "", /No formal travel warning for Türkei .* read them before calling it safe/);
  assert.equal(oesterreich?.verdict, "advice-only");
  assert.deepEqual(oesterreich?.travelAdvice, []);
  assert.equal(answer.summary.split(". ").at(-1), "Of 4 countries, 2 carry a formal warning: Mali (full travel warning (Reisewarnung)), Thailand (regional travel warning (Teilreisewarnung)).");
});

test("getTravelAdvice: a sentence the advisory repeats under Aktuelles and Sicherheit is listed once, where it first stands", async () => {
  const answer = await getTravelAdvice(clientOf(), { countries: ["Thailand"] });
  const thailand = answer.countries[0] as TripCountry;
  const texts = thailand.travelAdvice.map((s) => s.text);
  assert.equal(new Set(texts).size, texts.length);
  const kambodscha = thailand.travelAdvice.filter((s) => s.text.startsWith("Vor Reisen in das Grenzgebiet (20 km zum Grenzverlauf) zu Kambodscha"));
  assert.deepEqual(kambodscha.map((s) => s.section), ["Aktuelles"]);
});

test("getTravelAdvice: an unflagged country whose advisory asks Germans to leave, or advises against visits, is advice in text", async () => {
  for (const sentence of ["Deutsche Staatsangehörige werden dringend aufgefordert, Österreich umgehend zu verlassen.", "Das Auswärtige Amt rät dringend von Besuchen in Österreich ab."]) {
    const advisories = { [OESTERREICH]: { lastChanges: "", content: `<h2>Aktuelles</h2><p>${sentence}</p>` } };
    const answer = await getTravelAdvice(clientOf(reiseApi({ advisories })), { countries: ["Österreich"] });
    const oesterreich = answer.countries[0] as TripCountry;
    assert.equal(oesterreich.verdict, "advice-in-text", sentence);
    assert.deepEqual(oesterreich.travelAdvice.map((s) => s.text), [sentence]);
  }
});

test("getTravelAdvice and getAdvisory: an advisory without its text is a parse error, never advice only or no blocks", async () => {
  // Live, Türkei's advisory has twelve travel sentences: without its text the verdict can't be
  // made, and "advice-only" (the reassuring answer) was. The CLI's advice refused the same answer.
  for (const content of [undefined, null, "", "  ", 42, "<p> </p><div></div>"]) {
    const transport = reiseApi();
    const client = clientOf({ ...transport, transport: async (request) => {
      const response = await transport.transport(request);
      if (!request.url.endsWith(`/${TUERKEI}`)) return response;
      const body = JSON.parse(response.body.toString()) as { response: Record<string, Record<string, unknown>> };
      const entry = body.response[TUERKEI] as Record<string, unknown>;
      if (content === undefined) delete entry["content"];
      else entry["content"] = content;
      return { ...response, body: Buffer.from(JSON.stringify(body)) };
    } });
    const label = JSON.stringify(content) ?? "missing";
    await assert.rejects(getTravelAdvice(client, { countries: ["Türkei"] }), (err: Error) => err instanceof ReiseParseError && new RegExp(`content id "${TUERKEI}" has no content, so its advice can't be read`).test(err.message), label);
    await assert.rejects(getAdvisory(client, { country: TUERKEI }), ReiseParseError, label);
  }
});

test("getTravelAdvice: one advisory that fails is that country's failure; the others are read and answered", async () => {
  const failing = (status: number) => {
    const transport = reiseApi();
    return { transport, client: clientOf({ ...transport, transport: async (request) => (request.url.endsWith(`/${MALI}`) ? { status, headers: { "content-type": "application/json" }, body: Buffer.from("{}") } : transport.transport(request)) }) };
  };
  const { transport, client } = failing(404);
  const answer = await getTravelAdvice(client, { countries: ["Thailand", "Mali", "Türkei"] });
  assert.deepEqual(answer.countries.map((c) => c.status), ["ok", "failed", "ok"]);
  assert.deepEqual(transport.calls.map((c) => c.url.split("/").pop()), ["travelwarning", THAILAND, TUERKEI], "Türkei is read after Mali failed");
  const mali = answer.countries[1] as TripReadFailure;
  assert.equal(mali.id, MALI);
  assert.equal(mali.countryName, "Mali");
  assert.match(mali.reason, /^Its advisory could not be read: HTTP 404 for GET .*\/208258/);
  assert.match(answer.summary, /Mali: its advisory could not be read; ask for it again\./);
  assert.match(answer.reason ?? "", /^The advisory of Mali could not be read: ask for it again on its own; the other countries are answered\./);
  assert.equal(answer.status, "ok");
  // A trip whose every advisory fails is the error itself.
  await assert.rejects(getTravelAdvice(failing(404).client, { countries: ["Mali"] }), /HTTP 404/);
});

test("getTravelAdvice: once the caller's signal aborts, the countries not yet read are named, not read", async () => {
  const transport = reiseApi();
  const caller = new AbortController();
  const client = clientOf({ ...transport, transport: async (request) => {
    if (request.url.endsWith(`/${MALI}`)) {
      caller.abort();
      throw new ReiseNetworkError("Request aborted by its caller before it finished");
    }
    return transport.transport(request);
  } });
  const answer = await getTravelAdvice(client, { countries: ["Thailand", "Mali", "Türkei"], signal: caller.signal });
  assert.deepEqual(answer.countries.map((c) => c.status), ["ok", "failed", "failed"]);
  for (const country of answer.countries.slice(1) as TripReadFailure[]) assert.match(country.reason, /^Not read: the call's time ran out \(or it was cancelled\) first; ask for it again\.$/);
  assert.equal(transport.calls.length, 2, "Türkei is not asked for");
  assert.match(answer.reason ?? "", /^The advisories of Mali, Türkei could not be read/);
});

test("getTravelAdvice: one warned country of several 'carries' a warning", async () => {
  const answer = await getTravelAdvice(clientOf(), { countries: ["Thailand", "Österreich"] });
  assert.match(answer.summary, /Of 2 countries, 1 carries a formal warning: Thailand/);
});

test("getTravelAdvice: dates are the API's seconds as ISO times; the last-changes note is its items; the sections are listed", async () => {
  const answer = await getTravelAdvice(clientOf(), { countries: ["TH"] });
  const thailand = answer.countries[0] as TripCountry;
  assert.equal(thailand.lastModified, new Date((COUNTRIES[THAILAND] as ListFixture).lastModified * 1000).toISOString());
  assert.match(thailand.lastModified ?? "", /^2026-/, "seconds, not milliseconds (not 1970)");
  assert.deepEqual(thailand.lastChanges, ["Reiseinfos – Infrastruktur/Verkehr", "Einreise und Zoll - Anmerkungen", "Redaktionelle Änderungen"]);
  assert.deepEqual(thailand.sections, ["Aktuelles", "Sicherheit - Teilreisewarnung", "Gesundheit"]);
  assert.equal(thailand.matchedBy, "code");
});

test("getTravelAdvice: the advisory's own flags decide, not the list's", async () => {
  const countries = { ...COUNTRIES, [OESTERREICH]: { ...(COUNTRIES[OESTERREICH] as ListFixture) } };
  const transport = reiseApi({ countries });
  const client = clientOf({ ...transport, transport: async (request) => {
    const response = await transport.transport(request);
    if (!request.url.endsWith(`/${OESTERREICH}`)) return response;
    const body = JSON.parse(response.body.toString()) as { response: Record<string, Record<string, unknown>> };
    (body.response[OESTERREICH] as Record<string, unknown>)["partialWarning"] = true;
    return { ...response, body: Buffer.from(JSON.stringify(body)) };
  } });
  const answer = await getTravelAdvice(client, { countries: ["Österreich"] });
  assert.equal((answer.countries[0] as TripCountry).verdict, "regional-warning");
});

test("getTravelAdvice: an ambiguous name makes the answer ambiguous; the others are read all the same", async () => {
  const transport = reiseApi();
  const answer = await getTravelAdvice(clientOf(transport), { countries: ["Kenia", "Kongo", "Narnia", "kenia"] });
  assert.equal(answer.status, "ambiguous");
  assert.deepEqual(answer.countries.map((c) => c.status), ["ok", "ambiguous", "empty"], "Kenia named twice is read once");
  assert.equal(transport.calls.length, 2);
  assert.match(answer.summary, /^Kenia: regional travel warning \(Teilreisewarnung\)\. "Kongo" names 2 countries \(Demokratische Republik Kongo, Republik Kongo\): ask which one\. "Narnia": not found/);
});

test("getTravelAdvice: no country, more than five, or a blank name is refused before any request", async () => {
  const transport = reiseApi();
  for (const countries of [[], ["a", "b", "c", "d", "e", "f"], ["Mali", " "]]) {
    await assert.rejects(getTravelAdvice(clientOf(transport), { countries }), ReiseValidationError);
  }
  assert.equal(transport.calls.length, 0);
});

test("getWarnedCountries: formal warnings ranked full first, then regional, each by German name; the totals in the verdict", async () => {
  const answer = await getWarnedCountries(clientOf());
  assert.equal(answer.status, "ok");
  const full = answer.countries.filter((c) => c.level === "full").map((c) => c.countryName);
  const regional = answer.countries.filter((c) => c.level === "regional").map((c) => c.countryName);
  assert.deepEqual(answer.countries.map((c) => c.countryName), [...full, ...regional], "full warnings first");
  assert.deepEqual(full, [...full].sort((a, b) => (a ?? "").localeCompare(b ?? "", "de")));
  assert.ok(full.includes("Mali") && full.includes("Russische Föderation") && regional.includes("Thailand"));
  assert.ok(!answer.countries.some((c) => c.countryName === "Türkei"), "advice in the text is no formal warning");
  assert.equal(answer.listed, Object.keys(COUNTRIES).length);
  assert.equal(answer.byLevel.full, full.length);
  assert.match(answer.verdict, new RegExp(`^${answer.warned} of ${answer.listed} countries have a formal travel warning: ${full.length} full \\(Reisewarnung\\), ${regional.length} regional \\(Teilreisewarnung\\)\\. Formal warnings only`));
});

test("getWarnedCountries: a level narrows; none warned is said plainly (status empty with the reason), never as a failure", async () => {
  const regional = await getWarnedCountries(clientOf(), { level: "regional" });
  assert.ok(regional.countries.every((c) => c.level === "regional"));
  const situation = await getWarnedCountries(clientOf(), { level: "situation" });
  assert.equal(situation.status, "empty");
  assert.match(situation.reason ?? "", /situation flags have been false/);
  const calm = Object.fromEntries(Object.entries(COUNTRIES).map(([id, c]) => [id, { ...c, warning: false, partialWarning: false }]));
  const none = await getWarnedCountries(clientOf(reiseApi({ countries: calm })));
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /^The Auswärtiges Amt lists no formal travel warning right now\./);
  await assert.rejects(getWarnedCountries(clientOf(), { level: "none" as "full" }), ReiseValidationError);
});

/** The recorded countries with some changed, as they were "before". */
function before(): Record<string, ListFixture> {
  const old: Record<string, ListFixture> = {};
  for (const [id, c] of Object.entries(COUNTRIES)) old[id] = { ...c, lastModified: Math.min(c.lastModified, 1792000000) };
  old[THAILAND] = { ...(old[THAILAND] as ListFixture), partialWarning: false }; // newly warned now
  old[MALI] = { ...(old[MALI] as ListFixture), warning: false, partialWarning: true }; // escalated now
  old[TUERKEI] = { ...(old[TUERKEI] as ListFixture), partialWarning: true }; // lifted now
  old["999001"] = { ...(old[MALI] as ListFixture), countryName: "Altland", countryCode: "XA", iso3CountryCode: "XAA", warning: true }; // gone now
  return old;
}

test("getWarningChanges: against a snapshot, level changes by class, kept apart from text revisions", async () => {
  const old = before();
  const first = await getWarningChanges(clientOf(reiseApi({ countries: old })));
  const answer = await getWarningChanges(clientOf(), { previous: first.snapshot });
  const changes = answer.changes!;
  assert.deepEqual(changes.newlyWarned.map((c) => [c.countryName, c.from, c.to]), [["Thailand", "none", "partial"]]);
  assert.deepEqual(changes.escalated.map((c) => [c.countryName, c.from, c.to]), [["Mali", "partial", "full"]]);
  assert.deepEqual(changes.downgraded, []);
  assert.deepEqual(changes.lifted.map((c) => [c.countryName ?? c.id, c.from, c.gone ?? false]), [["Türkei", "partial", false], ["999001", "full", true]]);
  // Revised since: the countries whose lastModified is after the snapshot's newest, flags the same.
  const revised = Object.entries(COUNTRIES).filter(([id, c]) => c.lastModified > 1792000000 && ![THAILAND, MALI, TUERKEI].includes(id)).map(([id]) => name(id));
  assert.deepEqual(changes.updated.map((c) => c.countryName).sort(), revised.sort());
  assert.ok(!changes.updated.some((c) => c.countryName === "Mali"), "an escalation is never a text update");
  assert.match(answer.verdict, /^Since the previous snapshot: 1 newly warned, 1 escalated, 0 downgraded, 2 lifted, 0 with other flags at the same level; \d+ advisories revised with the same flags\. The list held 29 countries then and 28 now\./);
  assert.equal(answer.recent, undefined, "no freshness list unless since is given");
});

test("getWarningChanges: other flags at the same level are a change, not a text edit", async () => {
  const old = { ...COUNTRIES, [THAILAND]: { ...(COUNTRIES[THAILAND] as ListFixture), partialWarning: false, situationPartWarning: true } };
  const first = await getWarningChanges(clientOf(reiseApi({ countries: old })));
  const answer = await getWarningChanges(clientOf(), { previous: first.snapshot });
  assert.deepEqual(answer.changes?.flagsChanged.map((c) => [c.countryName, c.flagsBefore, c.flagsNow]), [["Thailand", ["situationPartWarning"], ["partialWarning"]]]);
  assert.equal(answer.changes?.updated.length, 0);
  assert.match(answer.verdict, /^Since the previous snapshot: 0 newly warned, 0 escalated, 0 downgraded, 0 lifted, 1 with other flags/);
});

test("getWarningChanges: without a snapshot, the most recently changed first, and a snapshot to keep", async () => {
  const answer = await getWarningChanges(clientOf(), { limit: 3 });
  assert.deepEqual(answer.recent?.map((c) => c.countryName), ["Kenia", "Polen", "Ägypten"]);
  assert.equal(answer.recentTotal, Object.keys(COUNTRIES).length);
  assert.match(answer.snapshot, /^rw1:1795101313:28:(\d+-[0-9a-f],)*\d+-[0-9a-f]$/);
  assert.match(answer.verdict, /keep this answer's snapshot/);
  assert.match(answer.verdict, /Level "none" is no formal warning, not "safe"/);
});

test("getWarningChanges: since a date, the advisories changed after it, newest first", async () => {
  const answer = await getWarningChanges(clientOf(), { since: "2026-11-09" });
  assert.deepEqual(answer.recent?.map((c) => c.countryName), ["Kenia", "Polen", "Ägypten"]);
  assert.equal(answer.recentTotal, 3);
  await assert.rejects(getWarningChanges(clientOf(), { since: "last week" }), /Invalid since "last week": Expected a date or time in ISO 8601/);
});

test("getWarningChanges: a malformed snapshot is refused with the fix, before any request", async () => {
  const transport = reiseApi();
  for (const bad of ["", "rw2:1:1:", "rw1:x:1:", "rw1:1:1:12-0", "rw1:1:1:12-g", "rw1:1:1"]) {
    await assert.rejects(getWarningChanges(clientOf(transport), { previous: bad }), /Invalid previous snapshot: .* Pass the snapshot string of an earlier getWarningChanges answer unchanged/, bad);
  }
  assert.equal(transport.calls.length, 0);
});

test("snapshotOf / parseSnapshot: the newest change, the count and the warned countries' flags round-trip", () => {
  const snapshot = snapshotOf(ENTRIES);
  const read = parseSnapshot(snapshot);
  assert.equal(read.listed, ENTRIES.length);
  assert.equal(read.warned.get(MALI), 8);
  assert.equal(read.warned.get(THAILAND), 4);
  assert.equal(read.warned.has(TUERKEI), false);
  assert.ok(snapshot.length < 2000, "fits a result's string field");
});

test("listCountries: every country with its level, by German name; warnedOnly narrows", async () => {
  const all = await listCountries(clientOf());
  assert.equal(all.length, Object.keys(COUNTRIES).length);
  assert.equal(all[0]?.countryName, "Afghanistan");
  assert.equal(all.at(-1)?.countryName, "Vereinigtes Königreich");
  const warned = await listCountries(clientOf(), { warnedOnly: true });
  assert.ok(warned.length > 0 && warned.every((c) => c.level !== "none"));
});

test("getAdvisory: the whole text block by block with its sections, or one section; the words as published", async () => {
  const transport = reiseApi();
  const whole = await getAdvisory(clientOf(transport), { country: TUERKEI });
  assert.equal(transport.calls.length, 1, "a content id is read directly");
  assert.equal(whole.status, "ok");
  if (whole.status !== "ok" || !("blocks" in whole)) return;
  assert.equal(whole.countryName, "Türkei");
  assert.deepEqual(whole.sections, ["Aktuelles", "Sicherheit", "Gesundheit"]);
  assert.ok(whole.blocks.some((b) => b.section === "Sicherheit › Terrorismus › Südosten und Osten/Grenzgebiete zu Syrien und Irak" && b.text.startsWith("Vermeiden Sie alle nicht zwingend erforderlichen Reisen")));
  assert.match(whole.disclaimer ?? "", /Haftungsausschluss/);
  const health = await getAdvisory(clientOf(), { country: "Türkei", section: "gesundheit" });
  assert.ok(health.status === "ok" && "blocks" in health && health.blocks.length > 0 && health.blocks.every((b) => b.section.startsWith("Gesundheit")));
  // A top-level section wins over a heading that only starts like it (Aktuelles › Sicherheitslage in der Region).
  const security = await getAdvisory(clientOf(), { country: "Türkei", section: "Sicherheit" });
  assert.ok(security.status === "ok" && "blocks" in security && security.blocks.every((b) => b.section.startsWith("Sicherheit")));
  // No top-level section of that name: any heading that contains it.
  const terror = await getAdvisory(clientOf(), { country: "Türkei", section: "terror" });
  assert.ok(terror.status === "ok" && "blocks" in terror && terror.blocks.length > 0 && terror.blocks.every((b) => b.section.includes("Terrorismus")));
});

test("getAdvisory: a section the advisory lacks is empty with its sections; an unknown country is empty with what to give", async () => {
  const none = await getAdvisory(clientOf(), { country: "Mali", section: "Wintersport" });
  assert.equal(none.status, "empty");
  assert.deepEqual("sections" in none && none.sections, ["Aktuelles", "Sicherheit - Reisewarnung", "Gesundheit"]);
  const unknown = await getAdvisory(clientOf(), { country: "Atlantis" });
  assert.equal(unknown.status, "empty");
  assert.match("reason" in unknown ? unknown.reason : "", /ISO 3166 code/);
});

test("getAdvisory: a content id the API doesn't know is empty, saying ids can change, like getTravelAdvice", async () => {
  for (const id of ["999999", "0"]) {
    const answer = await getAdvisory(clientOf(), { country: id });
    assert.equal(answer.status, "empty", id);
    assert.match("reason" in answer ? answer.reason : "", new RegExp(`^The Auswärtiges Amt has no advisory with the content id ${id}\\. Content ids can change: look the country up by its name or ISO code\\.$`), id);
  }
  // An envelope without the country (the client's not-found) is the same answer.
  const empty = makeMockTransport(() => jsonResponse({ response: {} }));
  const answer = await getAdvisory(clientOf(empty), { country: "123456" });
  assert.equal(answer.status, "empty");
  // Any other failure is still the error.
  await assert.rejects(getAdvisory(clientOf(makeMockTransport(() => jsonResponse({}, 500))), { country: "123456" }), /HTTP 500/);
});
