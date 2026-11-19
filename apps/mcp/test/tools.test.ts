// This server's tools against a mock of the travel-warning API (the client's recorded answers),
// with the skills' traps as cases: a name several countries share is ambiguous, never picked; no
// flag is not "safe" while the text advises against travel; formal warnings ranked; level changes
// kept apart from text revisions; the Auswärtiges Amt's terms in every result; the advisory's own
// text, a section and a page at a time. The rules every server follows are the conformance tests
// (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { COUNTRIES, MALI, THAILAND, TUERKEI, reiseApi, type ListFixture } from "./helpers.js";

const BASE = "https://www.auswaertiges-amt.de/opendata/travelwarning";

async function call(name: string, args: Record<string, unknown>, transport = reiseApi()) {
  const connection = await connect({ transport });
  const result = await connection.call(name, args);
  await connection.close();
  return { result, answer: (result.structuredContent ?? {}) as Record<string, unknown>, text: result.content[0]?.text ?? "" };
}

test("five tools: the three use cases first, then the two generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getTravelAdvice", "getWarnedCountries", "getWarningChanges", "listCountries", "getAdvisory"]);
});

test("getTravelAdvice: the verdict per country, the regions, the advisories as source and the AA's terms", async () => {
  const transport = reiseApi();
  const { answer, text } = await call("getTravelAdvice", { countries: ["Thailand", "Türkei", "Österreich"] }, transport);
  assert.equal(answer["status"], "ok", text);
  const countries = answer["countries"] as { countryName: string; verdict: string; travelAdvice: { text: string }[] }[];
  assert.deepEqual(countries.map((c) => [c.countryName, c.verdict]), [["Thailand", "regional-warning"], ["Türkei", "advice-in-text"], ["Österreich", "advice-only"]]);
  assert.ok(countries[1]?.travelAdvice.some((s) => s.text.startsWith("Vermeiden Sie alle nicht zwingend erforderlichen Reisen")), "the advice against travel no flag records");
  assert.equal(answer["source"], `${BASE}/{${THAILAND},${TUERKEI},210962}`);
  assert.match(String(answer["licence"]), /^Quelle: Auswärtiges Amt .*Keine Gewähr.*no open licence.*taken over completely and kept current.*open-data-schnittstelle-736118$/);
  assert.equal(transport.calls.length, 4);
});

test("getTravelAdvice: a name two countries share is ambiguous with both, and the list is the source", async () => {
  const { answer } = await call("getTravelAdvice", { countries: ["Kongo"] });
  assert.equal(answer["status"], "ambiguous");
  const [kongo] = answer["countries"] as { status: string; candidates: { countryName: string }[] }[];
  assert.deepEqual(kongo?.candidates.map((c) => c.countryName), ["Demokratische Republik Kongo", "Republik Kongo"]);
  assert.equal(answer["source"], BASE);
});

test("getTravelAdvice: a former name finds a country under a full warning; an unknown one is empty, never 'no warning'", async () => {
  const russland = await call("getTravelAdvice", { countries: ["Russland"] });
  assert.equal((russland.answer["countries"] as { verdict: string }[])[0]?.verdict, "full-warning");
  const narnia = await call("getTravelAdvice", { countries: ["Narnia"] });
  assert.equal(narnia.answer["status"], "empty");
  assert.match(String(narnia.answer["summary"]), /"Narnia": not found in the Auswärtiges Amt's list\./);
});

test("getWarnedCountries: full warnings first, compact entries, the totals as verdict; a level narrows", async () => {
  const { answer, text } = await call("getWarnedCountries", {});
  assert.equal(answer["status"], "ok", text);
  const countries = answer["countries"] as { countryName: string; level: string; title?: string }[];
  const firstRegional = countries.findIndex((c) => c.level === "regional");
  assert.ok(firstRegional > 0 && countries.slice(0, firstRegional).every((c) => c.level === "full"));
  assert.ok(countries.every((c) => c.title === undefined), "no title in a ranked list");
  assert.match(String(answer["verdict"]), /countries have a formal travel warning: \d+ full \(Reisewarnung\), \d+ regional \(Teilreisewarnung\)\. Formal warnings only/);
  assert.equal(answer["source"], BASE);
  const situation = await call("getWarnedCountries", { level: "situation" });
  assert.equal(situation.answer["status"], "empty");
  assert.match(String(situation.answer["reason"]), /situation flags have been false/);
});

test("getWarningChanges: a snapshot to keep, then the changes since it, levels apart from text revisions", async () => {
  const old: Record<string, ListFixture> = { ...COUNTRIES, [MALI]: { ...(COUNTRIES[MALI] as ListFixture), warning: false, partialWarning: true } };
  const first = await call("getWarningChanges", {}, reiseApi({ countries: old }));
  const snapshot = String(first.answer["snapshot"]);
  assert.match(snapshot, /^rw1:\d+:28:/);
  assert.ok(Array.isArray(first.answer["recent"]));
  const { answer, text } = await call("getWarningChanges", { previous: snapshot });
  assert.equal(answer["status"], "ok", text);
  const changes = answer["changes"] as Record<string, { countryName: string; from?: string; to?: string }[]>;
  assert.deepEqual(changes["escalated"]?.map((c) => [c.countryName, c.from, c.to]), [["Mali", "partial", "full"]]);
  assert.deepEqual(changes["updated"], []);
});

test("getWarningChanges: a snapshot that isn't one is a tool error saying what to pass, before any request", async () => {
  const transport = reiseApi();
  const { result, text } = await call("getWarningChanges", { previous: "last week" }, transport);
  assert.equal(result.isError, true);
  assert.match(text, /^Invalid previous snapshot: .*Pass the snapshot string of an earlier getWarningChanges answer unchanged/);
  assert.equal(transport.calls.length, 0);
});

test("listCountries: a page of the list by German name, nextOffset where the next starts", async () => {
  const { answer } = await call("listCountries", { limit: 5 });
  assert.equal(answer["total"], Object.keys(COUNTRIES).length);
  assert.deepEqual((answer["countries"] as { countryName: string }[]).map((c) => c.countryName), ["Afghanistan", "Ägypten", "Äquatorialguinea", "Belarus", "Côte d'Ivoire"]);
  assert.equal(answer["nextOffset"], 5);
  const past = await call("listCountries", { offset: 500 });
  assert.equal(past.answer["status"], "empty");
});

test("getAdvisory: one section of the text, block by block, the advisory as source, a page at a time", async () => {
  const { answer, text } = await call("getAdvisory", { country: "Türkei", section: "Sicherheit", limit: 3 });
  assert.equal(answer["status"], "ok", text);
  assert.equal(answer["source"], `${BASE}/${TUERKEI}`);
  const blocks = answer["blocks"] as { section: string; text: string }[];
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((b) => b.section.startsWith("Sicherheit")));
  assert.equal(answer["nextOffset"], 3);
  assert.ok((answer["blockCount"] as number) > 3);
  assert.deepEqual(answer["sections"], ["Aktuelles", "Sicherheit", "Gesundheit"]);
});

test("getAdvisory: a section the advisory lacks is empty with its sections", async () => {
  const { answer } = await call("getAdvisory", { country: MALI, section: "Wintersport" });
  assert.equal(answer["status"], "empty");
  assert.match(String(answer["reason"]), /no section matching "Wintersport"/);
});
