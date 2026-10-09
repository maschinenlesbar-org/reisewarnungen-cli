# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`reisewarnungen-cli` verwendet werden. Die Fachsprache (Reisehinweise des Auswärtigen
Amts) ist deutsch; dieses Glossar nennt die deutschen Begriffe zusammen mit den
englischen Bezeichnungen, die CLI und Client verwenden, wo es solche gibt.

> **Übersetzungstabelle.** CLI und Client halten sich an diese Zuordnung:
>
> | Deutsch | Englisch / Client-Begriff |
> | --- | --- |
> | Reisewarnung | (full) travel warning |
> | Teilreisewarnung | partial / regional warning |
> | Reise- und Sicherheitshinweise | travel and safety advice |
> | Auswärtiges Amt | Federal Foreign Office |
> | Land | country |
> | Inhalt | content |

---

## Die API und ihr Herausgeber

**Auswärtiges Amt (AA).** Das deutsche Außenministerium. Es gibt die amtlichen
Reise- und Sicherheitshinweise heraus, die dieses Tool liest. Website und Datenhost:
`auswaertiges-amt.de`.

**Open-Data-API zu Reisewarnungen.** Der offene Endpoint ohne Authentifizierung, den
das AA unter `https://www.auswaertiges-amt.de/opendata/travelwarning` veröffentlicht.
Er liefert die Reise- und Sicherheitshinweise des AA je Land als JSON. Nur lesend
(`GET`); ein API-Schlüssel ist nicht nötig. Dies ist die einzige API, die das Tool
kapselt; `DEFAULT_BASE_URL` ist `https://www.auswaertiges-amt.de`, der Ressourcenpfad
ist `/opendata/travelwarning`.

**Reise- und Sicherheitshinweise.** Die länderbezogenen Hinweise des AA für Reisende:
Einreisebestimmungen, Sicherheitslage, Gesundheit und – wo die Lage es erfordert – eine
ausdrückliche Warnung. Der Hinweistext wird als HTML im Feld `content` geliefert.

---

## Endpoints / Ressourcen

**Listen-Endpoint (`GET /opendata/travelwarning`).** Liefert *alle* Länder auf einmal
als Zuordnung von Content-ID -> Länderzusammenfassung, dazu Envelope-Felder. Die
Zusammenfassungen je Land enthalten hier **nicht** den HTML-`content`. CLI: `list`
(roh) und `countries` (abgeflacht).

**Einzel-Endpoint (`GET /opendata/travelwarning/{contentId}`).** Liefert die
vollständigen Hinweise eines Landes, mit befülltem HTML-`content`. CLI: `get`.

---

## Antwortstruktur

**`response`-Envelope.** Jede API-Antwort ist in ein oberstes `response`-Objekt
eingebettet. Der Client packt es aus: `list()` liefert `response`. Eine `200`-Antwort,
deren Body kein solcher Envelope ist (`null`, `{}`, das JSON einer anderen API, ein
`response`, das kein Objekt ist), wird bei `list`, `countries` **und** `get` als
`ReiseParseError` (Exit `1`) gemeldet, statt als leerer Erfolg verschleiert oder als
„nicht gefunden“ gemeldet zu werden.

**`lastModified`.** Ein Envelope-Feld (ein Unix-Epoch-Zeitstempel in **Sekunden**),
das neben den Ländereinträgen mitgeliefert wird – dem Namen nach der Zeitpunkt der letzten
Änderung des Datenbestands, doch es hinkt den `lastModified`-Werten der Einträge weit
hinterher (`1757063288`, also 05.09.2025, bei einer Prüfung am 15.09.2026). Es ist
**kein** Land, deshalb überspringt `summaries()` es beim Abflachen.

**`contentList`.** Ein Envelope-Feld: ein Array aller Content-IDs, das die Quelle neben
den Zusammenfassungen je Land mitliefert. Ebenfalls **kein** Land, deshalb überspringt
`summaries()` es.

**TravelWarning.** Der Eintrag eines Landes. Felder, die der Client liefert: `title`,
`countryCode`, `iso3CountryCode`, `countryName`, die vier booleschen Warn-Flags
(siehe unten), `lastModified`, `effective`, `lastChanges`, `content` (HTML, nur beim
Einzel-Endpoint) und `disclaimer`.

**CountryEntry.** Ein `TravelWarning`, ergänzt um seine `id` (die Content-ID), erzeugt
von `summaries()` – die abgeflachte Array-Ansicht der Liste.

---

## Kennungen & Codes

**Content-ID (`contentId`).** Der numerische String-Schlüssel, unter dem der Eintrag
eines Landes in der `response`-Zuordnung liegt (z. B. `226768`). Er ist das Feld `id`
eines `CountryEntry` und das Pflichtargument von `get <contentId>`. Er ist *kein*
ISO-Ländercode. Alles außer ASCII-Ziffern (leer, `226768x`, `..`) wird vor jeder Anfrage
abgelehnt – von der CLI wie vom `get()` der Bibliothek –, statt an die Quelle gesendet zu
werden, die eine führende Zahl großzügig liest oder `..` zu einem anderen Pfad auflöst.

**countryCode.** Der zweibuchstabige Ländercode nach ISO 3166-1 alpha-2, z. B. `TH`,
`JO`. Kosovo, das keinen offiziellen ISO-Code hat, trägt `XK`.

**iso3CountryCode.** Der dreibuchstabige Ländercode nach ISO 3166-1 alpha-3, z. B.
`DEU`, `FRA`.

**countryName.** Der lesbare Name des Landes (deutsch).

---

## Warn-Flags

Die vier booleschen Felder, die der Client liefert, nach zunehmender Spezifität. Ein
Land gilt als „mit Warnung“ (Filter `countries --warned-only`), wenn **eines** davon
`true` ist. Die Regel gehört der Bibliothek: Sie exportiert sie als
`isWarned(entry)` und wendet sie in `summaries({ warnedOnly: true })` an, das die
CLI aufruft. Jeder Ländereintrag muss `warning` und `partialWarning` als boolesche Werte
tragen (die beiden Lage-Flags dürfen fehlen, sind aber boolesch, wenn vorhanden): Eine
Antwort mit fehlendem, umbenanntem oder nicht booleschem Flag (`"true"`, `1`, `null`)
endet mit Exit `1`, statt ein Land mit Warnung stillschweigend wegzulassen oder
hinzuzufügen.

**warning.** Für das ganze Land gilt eine vollständige Reisewarnung – der stärkste
Rat des AA, von Reisen abzusehen.

**partialWarning.** Es gilt eine Teilreisewarnung – die Warnung betrifft bestimmte
Regionen statt des ganzen Landes.

**situationWarning.** Es gilt eine lagebezogene Warnung (verknüpft mit einem
bestimmten Ereignis oder Umstand).

**situationPartWarning.** Eine lagebezogene *Teil*warnung – lagebedingt und auf einen
Teil des Landes beschränkt.

**Abraten ohne Flag.** Unterhalb der formalen Stufen rät der Text des Hinweises von
Reisen ab – ins ganze Land oder in Regionen –, ohne dass ein Flag gesetzt ist: „Von
Reisen … wird (dringend) abgeraten", „Das Auswärtige Amt rät … ab", „Vermeiden Sie …
Reisen", „Meiden Sie möglichst Reisen …", „… sollte … gemieden werden". Türkei, Angola,
Bangladesch, Jordanien und Mexiko hatten am 06.10.2026 alle vier Flags `false` und
solche Sätze im Text. „Kein Flag" heißt also „keine formale Warnung", nicht
„unbedenklich". Der Befehl `advice` (Bibliothek: `client.advice`, `adviceSentences`)
listet jeden Satz mit einer dieser Formulierungen samt Abschnitt; `travel: true`
markiert die, die außerdem Reisen, einen Aufenthalt oder einen Landesteil nennen.

---

## Weitere Felder eines Eintrags

**title.** Der Titel des Hinweisdokuments.

**effective.** Ein Unix-Epoch-Zeitstempel (**Sekunden**): seit wann die aktuellen
Hinweise gelten. Das eigene `lastModified` jedes Eintrags verwendet dieselbe Einheit.

**lastChanges.** Eine kurze, lesbare Notiz dazu, was sich in der letzten Überarbeitung
der Hinweise geändert hat.

**content.** Der vollständige Hinweistext als **HTML**. Nur beim Einzel-Endpoint
vorhanden, erscheint also in Ergebnissen von `get`, nicht bei `list` /
`countries`.

**disclaimer.** Der Standard-Haftungsausschluss des AA, der die Hinweise begleitet.

---

## API- & Transportkonzepte

**Nur lesend, ohne Authentifizierung.** Der Endpoint liefert Daten über `GET` ohne
Schlüssel, Token oder Login. Der Client liest nur; er schreibt nichts.

**Retry / Backoff.** Vorübergehende Antworten `429` (Rate-Limit) und `503` werden
automatisch wiederholt (`--max-retries` / `maxRetries`, `0`–`10` (`MAX_RETRIES`),
Standard `2`), ebenso abgebrochene Verbindungen. Die Wartezeit wächst bei `503` linear
(200 ms, 400 ms, …) und beginnt bei `429` mit 1 s, verdoppelt je Versuch (höchstens 30 s).
Ein `Retry-After` des Servers (Sekunden oder ein HTTP-Datum) kann sie verlängern, nie
verkürzen: `Retry-After: 0` wartet trotzdem. Ein `Retry-After` über 30 s wird nicht
abgewartet: Der Fehler wird sofort gemeldet und nennt die verlangte Wartezeit.

**Weiterleitungen.** Die Engine folgt bis zu `maxRedirects` (Standard `5`)
HTTP-Weiterleitungen (`301/302/303/307/308`) und löst `Location` relativ zur aktuellen
URL auf. Die Zugangsdaten einer `--base-url` (`user:password@`) gehen nur an den Origin
der Basis-URL (Schema, Host und Port), bei jedem Schritt: Eine Weiterleitung auf denselben
Origin behält sie, eine auf einen anderen Host, Port oder ein anderes Schema (auch `http:`
→ `https:`) lässt sie weg, und Zugangsdaten, die ein Server in seinen `Location`-Header
schreibt, werden nie gesendet. Ein `401`/`403` nach einer solchen Weiterleitung sagt das
(bei `http:` → `https:`: eine `https`-Basis-URL verwenden). Bei einer Weiterleitung auf
einen **anderen Origin** entfernt sie außerdem sensible Header
(`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization`,
`WWW-Authenticate`), damit Zugangsdaten nie an einen anderen Host gelangen. Andere
3xx-Antworten (`300`, `304`, …), ein fehlender oder ungültiger `Location`-Header und eine
Weiterleitung über das Limit hinaus werden nicht verfolgt: Die Fehlermeldung nennt das Ziel,
z. B. `HTTP 302 for GET …: redirect to https://… not followed (stopped after 5 redirects)`
oder `redirect not followed (no Location header)` (Exit `1`).

**maxResponseBytes.** Eine feste Obergrenze für die Größe des Antwortkörpers (Standard
100 MiB; `0` schaltet sie ab), bei deren Überschreiten die Anfrage abgebrochen wird – zum
Schutz vor Speichererschöpfung durch einen feindseligen oder fehlerhaften Endpoint.

**Basis-URL.** `--base-url` / `baseUrl` muss eine absolute `http:`/`https:`-URL ohne
Query und Fragment, ohne umgebende Leerzeichen und ohne Steuerzeichen sein (ein
Pfadpräfix ist erlaubt); ein `%` in Benutzername oder Passwort muss ein Escape sein
(`%25` für ein wörtliches `%`). Die Bibliothek prüft sie beim
Erzeugen des Clients (`validateBaseUrl`) und wirft einen `ReiseValidationError`, also
einen Konfigurationsfehler und keinen Netzwerkfehler; die CLI meldet dieselbe Nachricht
als Bedienfehler (Exit `1`).

**Engine-Grenzen prüft die Bibliothek.** `timeoutMs` (`0`–`MAX_TIMEOUT_MS`),
`maxRetries` (`0`–`MAX_RETRIES`), `retryDelayMs` (`0`–`30000`) sowie `maxRedirects`
und `maxResponseBytes` (nicht negativ) müssen ganze Zahlen sein. Der Client-Konstruktor lehnt
jeden anderen Wert – negativ, gebrochen, `NaN`, `Infinity`, über der Obergrenze – vor
jeder Anfrage mit einem `ReiseValidationError` ab, sodass ein falscher Wert nie eine
Grenze abschaltet. Die Flags der CLI wenden dieselbe Regel an.

**Eine leere Liste ist ein Fehler.** Die Liste umfasst rund 200 Länder. Eine Antwort
ohne jedes Land, ein mit HTTP 200 gesendeter Fehler-Envelope oder eine `contentList`, die
IDs ohne Eintrag nennt, endet mit Exit `1` – sie wird nie als „keine Reisewarnungen"
gelesen. `countries --warned-only` mit `[]` heißt also: Die API hat ihre Liste geliefert,
und kein Land darin trägt ein Flag.

**Eintragssuche bei `get`.** Der Einzel-Endpoint legt seinen einen Eintrag unter der
angefragten Content-ID ab, und `get` liefert **nur** diesen Eintrag. Ein Envelope ganz ohne
Ländereintrag gilt als **nicht gefunden** (`ReiseNotFoundError`, Exit `4`); einer, dessen
Ländereinträge unter anderen Schlüsseln stehen, ist eine fehlerhafte Antwort
(`ReiseParseError`, Exit `1`) und wird nie als das angefragte Land gelesen – ein Werkzeug
für Reisesicherheit darf nicht mit einem anderen Land antworten. (Frühere Versionen
akzeptierten einen *einzigen* Eintrag unter beliebigem Schlüssel.)

**Log-Eintrag.** Jede Diagnosezeile, die die CLI auf stderr schreibt: ein Zeitstempel,
eine Stufe (`ERROR`, `WARN`, `INFO`) und ein Thema `reisewarnungen.<Bereich>`, als Text
(im Stil von log4j) oder mit `--log-format jsonl` als ein JSON-Objekt pro Zeile. Die
Bereiche: `cli` (Bedienfehler, Meldungen von commander, unerwartete Fehler), `api` (die
Antworten der API: ein Fehlerstatus, ein nicht gefundenes Land, eine fehlerhafte Antwort –
kein JSON, die falsche Form, ein mit HTTP 200 gesendeter Fehler-Envelope, ein unbekannter
Zeichensatz), `http` (die Verbindung, die Warnung vor unverschlüsseltem `http:` und je Wiederholung eine WARN-Zeile vor dem Warten) und
`output` (die `-o`-Datei, ein fehlgeschlagenes Schreiben auf stdout). Ein Eintrag ist
immer eine Zeile; Steuerzeichen darin werden maskiert.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `ReisewarnungenClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> die Eintragssuche bei `get` – finden Sie jetzt in **[DEVELOPING.md](DEVELOPING.md)** (englisch).
