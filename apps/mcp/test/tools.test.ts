// This server's tools against a mock of the travel-warning API (the client's recorded answers),
// with the skills' traps as cases: a name several countries share is ambiguous, never picked; no
// flag is not "safe" while the text advises against travel; formal warnings ranked; level changes
// kept apart from text revisions; the Auswärtiges Amt's terms in every result; the advisory's own
// text, a section and a page at a time. The rules every server follows are the conformance tests
// (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkError } from "../src/mcp/api.js";
import { limitTransport } from "../src/mcp/limiter.js";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { COUNTRIES, MALI, THAILAND, TUERKEI, reiseApi, reiseResponder, type ListFixture } from "./helpers.js";

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
  assert.match(snapshot, /^rw2:\d+:28:/);
  assert.ok(Array.isArray(first.answer["recent"]));
  const { answer, text } = await call("getWarningChanges", { previous: snapshot });
  assert.equal(answer["status"], "ok", text);
  const changes = answer["changes"] as { change: string; countryName: string; from?: string; to?: string }[];
  assert.deepEqual(changes.map((c) => [c.change, c.countryName, c.from, c.to]), [["escalated", "Mali", "partial", "full"]]);
  assert.deepEqual(answer["changeCounts"], { newlyWarned: 0, escalated: 1, downgraded: 0, lifted: 0, flagsChanged: 0, updated: 0 });
  assert.equal(answer["nextOffset"], undefined);
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

test("getTravelAdvice at the call deadline answers with the countries it has read and names the others", async () => {
  // Mali's advisory never answers; the limiter passes the call's signal to each request, as the
  // server runs it.
  const answer = reiseResponder();
  const transport = limitTransport((request) => {
    if (!request.url.endsWith(`/${MALI}`)) return Promise.resolve(answer(request));
    return new Promise((_resolve, reject) => {
      const stop = (): void => reject(request.signal?.reason instanceof Error ? request.signal.reason : new NetworkError("Request aborted by its caller before it finished"));
      if (request.signal?.aborted === true) stop();
      else request.signal?.addEventListener("abort", stop, { once: true });
    });
  });
  const connection = await connect({ transport: { transport }, config: { callTimeoutMs: 300 } });
  const result = await connection.call("getTravelAdvice", { countries: ["Thailand", "Mali", "Türkei"] });
  await connection.close();
  const content = (result.structuredContent ?? {}) as Record<string, unknown>;
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const countries = content["countries"] as { status: string; countryName: string; reason?: string }[];
  assert.deepEqual(countries.map((c) => [c.countryName, c.status]), [["Thailand", "ok"], ["Mali", "failed"], ["Türkei", "failed"]]);
  assert.match(countries[1]?.reason ?? "", /call's time ran out/);
  assert.match(String(content["reason"]), /The advisories of Mali, Türkei could not be read/);
  assert.equal(content["source"], `${BASE}/${THAILAND}`);
});

test("getAdvisory: an offset past the last block is empty, saying how many blocks there are", async () => {
  const whole = await call("getAdvisory", { country: "Türkei" });
  const count = whole.answer["blockCount"] as number;
  const past = await call("getAdvisory", { country: "Türkei", offset: count });
  assert.equal(past.answer["status"], "empty", past.text);
  assert.equal(past.answer["reason"], `The advisory holds ${count} blocks; offset ${count} is past its end.`);
  assert.equal(past.answer["blockCount"], count);
  const section = await call("getAdvisory", { country: "Türkei", section: "Sicherheit", offset: 500 });
  assert.equal(section.answer["status"], "empty");
  assert.match(String(section.answer["reason"]), /^The blocks of section "Sicherheit" are \d+; offset 500 is past their end\.$/);
});

/** A list of `n` countries with seven-digit content ids, every one under a full warning (a worldwide warning, as in spring 2020). */
function worldwide(n: number): Record<string, ListFixture> {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      String(9_000_000 + i),
      { lastModified: 1_790_000_000 + i, effective: 1_790_000_000, title: `Land ${i}: Reise- und Sicherheitshinweise`, countryCode: `${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}`, iso3CountryCode: `X${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}`, countryName: `Land ${String(i).padStart(3, "0")}`, warning: true, partialWarning: false, situationWarning: false, situationPartWarning: false },
    ]),
  );
}

test("getWarningChanges: the snapshot of 200 warned countries is kept whole and reads back", async () => {
  const countries = worldwide(200);
  const first = await call("getWarningChanges", {}, reiseApi({ countries }));
  const snapshot = String(first.answer["snapshot"]);
  assert.ok(snapshot.length > 2000 && snapshot.length <= 4000, `${snapshot.length}`);
  assert.doesNotMatch(snapshot, /…\[cut/);
  const again = await call("getWarningChanges", { previous: snapshot }, reiseApi({ countries }));
  assert.equal(again.result.isError, undefined, again.text);
  assert.match(String(again.answer["verdict"]), /^Nothing changed since the previous snapshot\./);
});

test("getWarningChanges: 200 newly warned countries come a page at a time, by class, with the totals; a small size cap keeps the snapshot", async () => {
  const countries = worldwide(200);
  const none = Object.fromEntries(Object.entries(countries).map(([id, c]) => [id, { ...c, warning: false }]));
  const snapshot = String((await call("getWarningChanges", {}, reiseApi({ countries: none }))).answer["snapshot"]);
  const first = await call("getWarningChanges", { previous: snapshot }, reiseApi({ countries }));
  assert.equal(first.result.isError, undefined, first.text);
  assert.equal((first.answer["changes"] as unknown[]).length, 50);
  assert.equal((first.answer["changeCounts"] as Record<string, number>)["newlyWarned"], 200);
  assert.equal(first.answer["nextOffset"], 50);
  assert.match(String(first.answer["verdict"]), /^Since the previous snapshot: 200 newly warned/);
  const last = await call("getWarningChanges", { previous: snapshot, offset: 150 }, reiseApi({ countries }));
  assert.deepEqual((last.answer["changes"] as { countryName: string }[]).map((c) => c.countryName).slice(-1), ["Land 199"]);
  assert.equal(last.answer["nextOffset"], undefined);
  const past = await call("getWarningChanges", { previous: snapshot, offset: 200 }, reiseApi({ countries }));
  assert.deepEqual(past.answer["changes"], []);
  assert.match(String(past.answer["verdict"]), /offset 200 is past the 200 changes/);
  // Under a small cap the page is shortened (nextOffset moves on) and the snapshot stays whole.
  const connection = await connect({ transport: reiseApi({ countries }), config: { maxResultChars: 8000 } });
  const small = await connection.call("getWarningChanges", { previous: snapshot, limit: 200 });
  await connection.close();
  const content = (small.structuredContent ?? {}) as Record<string, unknown>;
  assert.equal(small.isError, undefined, small.content[0]?.text);
  const kept = (content["changes"] as unknown[]).length;
  assert.ok(kept > 1 && kept < 200 && content["nextOffset"] === kept, `${kept} ${String(content["nextOffset"])}`);
  assert.equal(content["snapshot"], String(first.answer["snapshot"]));
  // Without a snapshot the recent list pages too.
  const recent = await call("getWarningChanges", { limit: 10, offset: 190 }, reiseApi({ countries }));
  assert.equal((recent.answer["recent"] as unknown[]).length, 10);
  assert.equal(recent.answer["nextOffset"], undefined);
  assert.equal((await call("getWarningChanges", { limit: 10 }, reiseApi({ countries }))).answer["nextOffset"], 10);
});
