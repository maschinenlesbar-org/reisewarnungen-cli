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
ISO-Ländercode. Eine leere Content-ID wird als Aufruffehler abgelehnt, statt an die
Quelle gesendet zu werden.

**countryCode.** Der zweibuchstabige Ländercode nach ISO 3166-1 alpha-2, z. B. `TH`,
`JO`. Kosovo, das keinen offiziellen ISO-Code hat, trägt `XK`.

**iso3CountryCode.** Der dreibuchstabige Ländercode nach ISO 3166-1 alpha-3, z. B.
`DEU`, `FRA`.

**countryName.** Der lesbare Name des Landes (deutsch).

---

## Warn-Flags

Die vier booleschen Felder, die der Client liefert, nach zunehmender Spezifität. Ein
Land gilt als „mit Warnung“ (Filter `countries --warned-only`), wenn **eines** davon
true ist.

**warning.** Für das ganze Land gilt eine vollständige Reisewarnung – der stärkste
Rat des AA, von Reisen abzusehen.

**partialWarning.** Es gilt eine Teilreisewarnung – die Warnung betrifft bestimmte
Regionen statt des ganzen Landes.

**situationWarning.** Es gilt eine lagebezogene Warnung (verknüpft mit einem
bestimmten Ereignis oder Umstand).

**situationPartWarning.** Eine lagebezogene *Teil*warnung – lagebedingt und auf einen
Teil des Landes beschränkt.

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
automatisch wiederholt (`--max-retries`, `0`–`10`, Standard `2`). Jede Wiederholung wartet
das `Retry-After` des Servers ab (Sekunden oder ein HTTP-Datum); ohne verwertbaren Wert
wächst die Wartezeit linear (200 ms, 400 ms, …). Ein `Retry-After` über 30 s wird nicht
abgewartet: Der Fehler wird sofort gemeldet.

**Weiterleitungen.** Die Engine folgt bis zu `maxRedirects` (Standard `5`)
HTTP-Weiterleitungen (`301/302/303/307/308`) und löst `Location` relativ zur aktuellen
URL auf. Bei einer Weiterleitung auf einen **anderen Origin** entfernt sie sensible Header
(`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization`,
`WWW-Authenticate`), damit Zugangsdaten nie an einen anderen Host gelangen.

**maxResponseBytes.** Eine feste Obergrenze für die Größe des Antwortkörpers (Standard
100 MiB; `0` schaltet sie ab), bei deren Überschreiten die Anfrage abgebrochen wird – zum
Schutz vor Speichererschöpfung durch einen feindseligen oder fehlerhaften Endpoint.

**Eintragssuche bei `get`.** Der Einzel-Endpoint legt seinen einen Eintrag unter der
angefragten Content-ID ab, und `get` liefert **nur** diesen Eintrag. Ein Envelope ganz ohne
Ländereintrag gilt als **nicht gefunden** (`ReiseNotFoundError`, Exit `4`); einer, dessen
Ländereinträge unter anderen Schlüsseln stehen, ist eine fehlerhafte Antwort
(`ReiseParseError`, Exit `1`) und wird nie als das angefragte Land gelesen – ein Werkzeug
für Reisesicherheit darf nicht mit einem anderen Land antworten. (Frühere Versionen
akzeptierten einen *einzigen* Eintrag unter beliebigem Schlüssel.)

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `ReisewarnungenClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> die Eintragssuche bei `get` – finden Sie jetzt in **[DEVELOPING.md](DEVELOPING.md)** (englisch).
