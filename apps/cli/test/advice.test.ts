import { test } from "node:test";
import assert from "node:assert/strict";
import { adviceSentences, splitSentences } from "@maschinenlesbar.org/reisewarnungen-client/internal/advice";
import { ReisewarnungenClient } from "@maschinenlesbar.org/reisewarnungen-client/internal/client";
import { ReiseNotFoundError, ReiseParseError } from "@maschinenlesbar.org/reisewarnungen-client/internal/errors";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

// The three phrasings the old „abgeraten|gewarnt" recipe missed (live, 2026-10-05), in the
// HTML shape the advisories use.
const TUERKEI =
  "<h2>Sicherheit</h2><h3>Terrorismus</h3><h4><em>Südosten und Osten/Grenzgebiete zu Syrien und Irak</em></h4>" +
  "<p><span>Im unmittelbaren Grenzgebiet der Türkei zu Syrien (Provinzen Şanlıurfa und Mardin) und zu Irak bestehen Gefahren. </span></p>" +
  '<ul class="rte--list"><li><span>Seien Sie insbesondere an belebten Orten aufmerksam.</span></li>' +
  "<li>Vermeiden Sie alle nicht zwingend erforderlichen Reisen in die o.g. Grenzgebiete.</li></ul>" +
  "<h2>Reiseinfos</h2><h3>Rechtliche Besonderheiten</h3><p>Es wird daher nachdrücklich davor gewarnt, von Händlern z. B. Antiquitäten anzukaufen.</p>";
const ANGOLA =
  "<h2>Sicherheit</h2><h3>Innenpolitische Lage</h3><ul><li>Meiden Sie möglichst Reisen in die Provinzen Cabinda, Lunda Norte und Lunda Sul und beachten Sie die " +
  '<a href="https://diplo.de/-/203202">Reise- und Sicherheitshinweise für die Demokratische Republik Kongo.</a></li></ul>';
const BANGLADESCH =
  "<h2>Sicherheit</h2><h3>Innenpolitische Lage</h3><p><span>Durch die Auseinandersetzungen in Myanmar kommt es zu Auswirkungen. " +
  "Das Grenzgebiet zu Myanmar sollte, wenn möglich, weiträumig gemieden werden. Die Landgrenze ist geschlossen.</span></p>";
const MEXIKO =
  "<h2>Sicherheit</h2><p><strong>Von Reisen in folgende Regionen wird dringend abgeraten:</strong></p>" +
  "<ul><li><strong>Bundesstaat Colima</strong></li><li><strong>Bundesstaat Guerrero, </strong><span>mit Ausnahme von Acapulco</span></li></ul>" +
  "<p>Achten Sie auf Ihre Wertsachen.</p>";

const travel = (html: string): string[] => adviceSentences(html).filter((s) => s.travel).map((s) => s.text);

test("advice: 'Vermeiden Sie … Reisen' (Türkei) is found as a whole sentence with its section", () => {
  const found = adviceSentences(TUERKEI);
  const s = found.find((x) => x.text.startsWith("Vermeiden Sie"));
  assert.deepEqual(s, {
    section: "Sicherheit › Terrorismus › Südosten und Osten/Grenzgebiete zu Syrien und Irak",
    text: "Vermeiden Sie alle nicht zwingend erforderlichen Reisen in die o.g. Grenzgebiete.",
    travel: true,
  });
  // „z. B." does not cut the antiques sentence, which is not about travel.
  const antiques = found.find((x) => x.text.includes("Antiquitäten"));
  assert.equal(antiques?.text, "Es wird daher nachdrücklich davor gewarnt, von Händlern z. B. Antiquitäten anzukaufen.");
  assert.equal(antiques?.travel, false);
});

test("advice: 'Meiden Sie möglichst Reisen …' (Angola) and '… sollte … gemieden werden' (Bangladesch) are found", () => {
  assert.deepEqual(travel(ANGOLA), [
    "Meiden Sie möglichst Reisen in die Provinzen Cabinda, Lunda Norte und Lunda Sul und beachten Sie die Reise- und Sicherheitshinweise für die Demokratische Republik Kongo.",
  ]);
  assert.deepEqual(travel(BANGLADESCH), ["Das Grenzgebiet zu Myanmar sollte, wenn möglich, weiträumig gemieden werden."]);
});

test("advice: a sentence that introduces a list carries the list's items", () => {
  assert.deepEqual(travel(MEXIKO), [
    "Von Reisen in folgende Regionen wird dringend abgeraten: Bundesstaat Colima; Bundesstaat Guerrero, mit Ausnahme von Acapulco.",
  ]);
});

test("advice: a sentence split around a list (Tunesien) is put back together", () => {
  const html =
    "<h2>Sicherheit</h2><p><strong>Von Reisen</strong></p><ul><li><strong>in das Gebiet südlich einer Linie Tozeur – Zarzis,</strong></li>" +
    "<li><strong>das unmittelbare Grenzgebiet zu Algerien sowie</strong></li><li><strong>individuellen Wüstentouren</strong></li></ul>" +
    "<p><strong>wird abgeraten</strong>.</p><h3>Innenpolitische Lage</h3><p>Die Lage ist ruhig.</p>";
  assert.deepEqual(adviceSentences(html), [
    {
      section: "Sicherheit",
      text: "Von Reisen in das Gebiet südlich einer Linie Tozeur – Zarzis; das unmittelbare Grenzgebiet zu Algerien sowie; individuellen Wüstentouren wird abgeraten.",
      travel: true,
    },
  ]);
});

test("advice: every documented phrasing is caught", () => {
  for (const sentence of [
    "Von Reisen in den Norden wird abgeraten.",
    "Das Auswärtige Amt rät von Reisen in die Region ab.",
    "Vor Reisen in das Grenzgebiet wird gewarnt.",
    "Es besteht eine Teilreisewarnung für die Provinz X.",
    "Meiden Sie die Grenzregion.",
    "Reisen in die Provinz sollten vermieden werden.",
    "Verzichten Sie auf Reisen in den Süden.",
    "Reisen in das Gebiet sollten unterbleiben.",
    "Deutsche Staatsangehörige werden aufgefordert, das Land zu verlassen.",
    "Die Region sollte nicht aufgesucht werden.",
  ]) {
    assert.deepEqual(travel(`<p>${sentence}</p>`), [sentence], sentence);
  }
  // No phrasing, no sentence: this is the only case an all-false country is "advice only".
  assert.deepEqual(adviceSentences("<h2>Sicherheit</h2><p>Die Kriminalitätsrate ist niedrig. Reisen Sie entspannt.</p>"), []);
});

test("advice: the advice to leave („sollten … ausreisen“) and „sehen … ab“ are caught (bug 6)", () => {
  // Israel, live on 2026-10-21 (all four flags false): said four times, printed by none.
  const israel = "Deutsche Staatsangehörige, die sich derzeit im Gazastreifen oder im Westjordanland aufhalten, sollten – sofern möglich - ausreisen.";
  assert.deepEqual(adviceSentences(`<p>${israel}</p>`).map((s) => s.text), [israel]);
  for (const sentence of [
    "Deutsche sollten das Land verlassen.",
    "Sehen Sie von Reisen in die Grenzregion ab.",
    "Sehen Sie vom Baden und Schwimmen in Binnengewässern ab.",
    "Sehen Sie vom Baden in Süßwassergewässern konsequent ab, solange die Warnung gilt.",
    "Von Reisen in den Norden ist abzusehen.",
    "Reisende sollten von Fahrten in die Region absehen.",
  ]) {
    assert.equal(adviceSentences(`<p>${sentence}</p>`).length, 1, sentence);
  }
  // „ab" as a preposition, „abgesehen von", „nicht abzusehen" (not foreseeable) are no advice.
  for (const sentence of [
    "Sehen Sie ab 18 Uhr die Lichter der Stadt.",
    "Abgesehen von den Grenzgebieten ist die Lage ruhig.",
    "Ein Ende der Kämpfe ist nicht abzusehen.",
  ]) {
    assert.deepEqual(adviceSentences(`<p>${sentence}</p>`), [], sentence);
  }
});

test("advice: entities are decoded, soft hyphens dropped, odd input gives []", () => {
  assert.deepEqual(travel("<p>Von Reisen in die Grenz&shy;region wird &quot;dringend&quot; abgeraten.</p>"), [
    'Von Reisen in die Grenzregion wird "dringend" abgeraten.',
  ]);
  assert.deepEqual(adviceSentences(""), []);
  assert.deepEqual(adviceSentences(undefined as never), []);
});

test("advice: a long sentence without a full stop is scanned in linear time, not quadratic (bug 4)", () => {
  // „nicht … reisen" and „rät … ab" have a gap between two words; a sentence of 192 KB with
  // 32 000 „nicht" and no „reisen" took 9 s (each „nicht" rescanned the rest of the sentence),
  // and --timeout did not bound it. 400 KB took over half a minute; it now takes milliseconds.
  for (const word of ["nicht ", "rät ", "Rät ", "sollten ", "sehen von ", "von "]) {
    const html = `<p>${word.repeat(Math.ceil(400_000 / word.length))}</p>`;
    const started = performance.now();
    assert.deepEqual(adviceSentences(html), []);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${JSON.stringify(word)}: ${Math.round(ms)} ms`);
  }
  // The gap still spans the sentence: the second word may stand anywhere after the first.
  const far = `Die Region sollte ${"weit ".repeat(20_000)}nicht ${"sehr ".repeat(20_000)}besucht werden.`;
  assert.equal(adviceSentences(`<p>${far}</p>`).length, 1);
});

test("advice: odd HTML, long words and abbreviations are read in linear time too", () => {
  // Found while fixing bug 4: an unclosed tag or comment rescanned the rest of the advisory from
  // every "<", and the word before each full stop was found by rescanning the sentence so far
  // („z. B. " 20 000 times: 6 s; a 40 000-character word: 3 s).
  for (const [label, html] of [
    ["unclosed tags", `<p>${"<a ".repeat(60_000)}`],
    ["unclosed comments", `<p>${"<!--".repeat(60_000)}`],
    ["a long word", `<p>${"x".repeat(200_000)} y. Z</p>`],
    ["abbreviations", `<p>${"z. B. ".repeat(40_000)}Ende.</p>`],
  ] as const) {
    const started = performance.now();
    adviceSentences(html);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${label}: ${Math.round(ms)} ms`);
  }
  // The tokens are what they were: an unclosed tag or comment is text, a tag name ends at a non-word character.
  assert.deepEqual(travel("<p>Von Reisen in die Region 3<4 wird abgeraten.</p>"), ["Von Reisen in die Region 3<4 wird abgeraten."]);
  assert.deepEqual(travel("<p>Von Reisen <!-- x --> in die Region wird abgeraten.<!-- offen</p>"), [
    "Von Reisen in die Region wird abgeraten.<!-- offen",
  ]);
  assert.deepEqual(travel("<p>Von Reisen in die <span_x>Region</span_x> wird abgeraten.</p>"), [
    "Von Reisen in die <span_x>Region</span_x> wird abgeraten.",
  ]);
});

test("splitSentences keeps abbreviations and ordinals inside a sentence", () => {
  assert.deepEqual(splitSentences("Seit dem 5. Oktober gilt u. a. dies. Zum Beispiel z.B. hier. Ende 2015. Neu."), [
    "Seit dem 5. Oktober gilt u. a. dies.",
    "Zum Beispiel z.B. hier.",
    "Ende 2015.",
    "Neu.",
  ]);
});

function entry(content?: string): unknown {
  return {
    response: {
      "201962": {
        countryName: "Türkei",
        countryCode: "TR",
        iso3CountryCode: "TUR",
        warning: false,
        partialWarning: false,
        situationWarning: false,
        situationPartWarning: false,
        effective: 1759000000,
        lastModified: 1759000001,
        ...(content === undefined ? {} : { content }),
      },
    },
  };
}

test("client.advice returns the flags and the sentences; no content is a parse error", async () => {
  const mt = makeMockTransport(() => jsonResponse(entry(TUERKEI)));
  const advice = await new ReisewarnungenClient({ transport: mt.transport }).advice("201962");
  assert.equal(new URL(mt.last().url).pathname, "/opendata/travelwarning/201962");
  assert.equal(advice.id, "201962");
  assert.equal(advice.countryName, "Türkei");
  assert.equal(advice.warning, false);
  assert.equal(advice.effective, 1759000000);
  assert.ok(advice.sentences.some((s) => s.travel && s.text.startsWith("Vermeiden Sie")));
  assert.equal("content" in advice, false);
  const empty = makeMockTransport(() => jsonResponse(entry()));
  await assert.rejects(new ReisewarnungenClient({ transport: empty.transport }).advice("201962"), ReiseParseError);
  const none = makeMockTransport(() => jsonResponse({ response: {} }));
  await assert.rejects(new ReisewarnungenClient({ transport: none.transport }).advice("201962"), ReiseNotFoundError);
});

test("advice <id> prints the result; a bad id is a usage error; not found exits 4", async () => {
  const out: string[] = [];
  const err: string[] = [];
  let body: unknown = entry(ANGOLA);
  const mt = makeMockTransport(() => jsonResponse(body));
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new ReisewarnungenClient({ ...opts, transport: mt.transport }),
  };
  assert.equal(await run(["advice", "201962", "--compact"], deps), 0);
  const printed = JSON.parse(out.join("\n")) as { id: string; sentences: Array<{ travel: boolean }> };
  assert.equal(printed.id, "201962");
  assert.equal(printed.sentences.filter((s) => s.travel).length, 1);
  assert.equal(await run(["advice", "Türkei"], deps), 1);
  assert.equal(mt.calls.length, 1);
  body = { response: {} };
  assert.equal(await run(["advice", "201962"], deps), 4);
});
