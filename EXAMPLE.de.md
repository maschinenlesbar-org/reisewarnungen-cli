# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `reisewarnungen`, eines pro Skill: eine
Anfrage, die `reisewarnungen`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `reisewarnungen` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [reisewarnungen-trip-check](#reisewarnungen-trip-check) · [reisewarnungen-warned-overview](#reisewarnungen-warned-overview) · [reisewarnungen-watch](#reisewarnungen-watch)

## reisewarnungen-trip-check

> Im Oktober geht es nach Jordanien und Saudi-Arabien. Was sagt das Auswärtige Amt dazu?

```bash
reisewarnungen countries --compact      # aufgelöst über iso3CountryCode: JOR → 218008, SAU → 202298
reisewarnungen advice 202298 --compact
reisewarnungen advice 218008 --compact
reisewarnungen get 202298 --compact
reisewarnungen get 218008 --compact
```

Die Länder wurden über `iso3CountryCode` aufgelöst, das funktioniert auch bei englischen
Anfragen. Saudi-Arabien hat `partialWarning`, bei Jordanien stehen alle vier Flags auf `false`.
`advice` lieferte 20 und 17 Sätze, davon 9 und 10 mit `travel`. Bei Jordanien ist darunter „Von
Reisen in das unmittelbare syrisch-jordanische Grenzgebiet … wird dringend abgeraten", also hat
der Skill das Land als „rät von Reisen ab" eingestuft, nicht als unbedenklich; die übrigen
`travel`-Sätze (Fahrten bei Dunkelheit, Papiere für Minderjährige, Terrorgefahr) wurden zu
Stichpunkten oder blieben weg. Den Rest der Übersicht lieferten die vollständigen Hinweise (`get`).

```
Saudi-Arabien (SA · 202298)   Teilreisewarnung
Auswärtiges Amt, gültig seit 22.09.2026. Letzte Änderung: Aktuelles – Sicherheitslage in der
Region; Sicherheit – Teilreisewarnung; redaktionelle Änderungen.
  • Reisewarnung für den 30-km-Streifen an der Grenze zu Jemen in Nadschran, Asir und Dschazan.
  • Von Reisen bis etwa 100 km an diese Grenze heran, einschließlich Abha und Khamis Muschait,
    wird dringend abgeraten, von nicht notwendigen Reisen in alle weiteren Regionen abgeraten.
  • Seit Anfang September 2026 greifen die Huthi mit Drohnen und Raketen an, vor allem in
    Al-Baha, Asir, Dschazan, Medina, Mekka, Nadschran und Tabuk, meist Öl- und Militäranlagen,
    mit Toten und Verletzten. Weitere Schläge und Störungen des Flugverkehrs sind zu erwarten.
    US-, Militär- und kritische Infrastruktur weiträumig meiden, Menschenansammlungen meiden,
    bei Luftalarm den Anweisungen folgen.
  • Einschläge, Brände, Raketenabschüsse, Trümmer oder Militäranlagen nicht fotografieren oder filmen.
  • Kriminalität vergleichsweise niedrig, Telefonbetrug weit verbreitet.

Jordanien (JO · 218008)   Rät von Reisen ab (keine formelle Warnung)
Gültig seit 27.08.2026. Letzte Änderung: Aktuelles; Sicherheit – Sicherheitshinweis; redaktionell.
  • Von Reisen ins syrisch-jordanische Grenzgebiet, in den Nordosten und in die Grenzregion zu
    Irak wird dringend abgeraten, von nicht notwendigen Reisen in andere Landesteile abgeraten.
  • Militärische Schläge gegen Ziele in der Region, auch gegen Stützpunkte in Jordanien, bleiben
    möglich, Sperrungen des Flugverkehrs ebenso. US-nahe und militärische Einrichtungen sowie
    alle Demonstrationen meiden.
  • Grenzübergänge Israel–Jordanien (King-Hussein-/Allenby-Brücke) können kurzfristig anders
    öffnen oder schließen; in Grenznähe, auch auf dem Dead Sea Highway, drohen Sperrungen und Kontrollen.
  • Von Überlandfahrten nach Einbruch der Dunkelheit wird abgeraten.
  • Im Herbst und Winter drohen Sturzfluten in Wadis (2025 wurden Reisende aus der Schlucht von Petra evakuiert).

Gesamt: Für Saudi-Arabien gilt eine Teilreisewarnung für das Grenzgebiet zu Jemen, von nicht
notwendigen Reisen in den Rest des Landes wird abgeraten. Für Jordanien gibt es keine formelle
Warnung, das Auswärtige Amt rät aber von Reisen in die Grenzregionen und von nicht notwendigen
Reisen in den Rest des Landes ab.
Vollständige Hinweise: reisewarnungen get 202298 · reisewarnungen get 218008
```

## reisewarnungen-warned-overview

> Für welche Länder in Afrika warnt das Auswärtige Amt derzeit vor Reisen?

```bash
reisewarnungen countries --warned-only --compact
```

Weltweit tragen 46 Länder ein Warn-Flag (18 Reisewarnungen, 28 Teilreisewarnungen). Kein Land
hat ein `situation*`-Flag. Die Daten enthalten kein Regionsfeld, also hat der Skill Afrika über
`countryCode` zugeordnet und Ägypten (`EG`) mitgezählt.

```
Reisewarnungen für Afrika – 23 von 46 Ländern mit Warnung (7 Reisewarnungen, 16 Teilreisewarnungen)
Quelle: Auswärtiges Amt, Stand 06.10.2026. Nur formelle Warnungen: Wo ohne Flag von Reisen
abgeraten wird, steht das im Hinweistext (dafür einen Reise-Check zum Land anfragen).

Reisewarnung – 7
  Libyen (LY · 219624)        Mali (ML · 208258)          Niger (NE · 226384)
  Somalia (SO · 203132)       Sudan (SD · 203266)         Südsudan (SS · 244250)
  Zentralafrikanische Republik (CF · 226450)

Teilreisewarnung – 16, gilt jeweils nur für Teile des Landes
  Ägypten (EG · 212622)       Algerien (DZ · 219044)      Äthiopien (ET · 209504)
  Benin (BJ · 208984)         Burkina Faso (BF · 212336)  Côte d'Ivoire (CI · 209460)
  Demokratische Republik Kongo (CD · 203202)              Eritrea (ER · 226176)
  Ghana (GH · 203372)         Kamerun (CM · 208874)       Kenia (KE · 208058)
  Mauretanien (MR · 219190)   Mosambik (MZ · 221782)      Nigeria (NG · 205788)
  Togo (TG · 213850)          Tschad (TD · 225774)

Aktualisiert seit 29.09.: Kenia (05.10.), Äthiopien (01.10.), Nigeria, Ägypten (beide 29.09.).
Außerhalb Afrikas: 11 Reisewarnungen (Afghanistan, Belarus, Haiti, Irak, Iran, Jemen, Myanmar,
Palästinensische Gebiete*, Russische Föderation, Syrien, Ukraine) und 12 Teilreisewarnungen.
```

Als Nächstes angeboten: Details zu einzelnen Ländern (`reisewarnungen advice <id>`, `get <id>`
oder reisewarnungen-trip-check) und reisewarnungen-watch, um Änderungen zu verfolgen.

## reisewarnungen-watch

> Welche Reisehinweise haben sich in der letzten Woche geändert? Und das künftig im Blick behalten.

```bash
reisewarnungen countries --compact -o reisewarnungen-2026-10-06.json    # Ausgangsstand, 200 Länder
reisewarnungen countries --compact -o reisewarnungen-2026-10-06.json    # Exit 1: überschreibt nicht ohne --force
jq -r 'sort_by(-.lastModified) | .[] | select(.lastModified > ("2026-09-29T00:00:00Z"|fromdate)) | …' reisewarnungen-2026-10-06.json
```

Einen früheren Snapshot gab es nicht, also auch nichts zu vergleichen. Der Skill nutzte die
Aktualitätsansicht über das `lastModified` je Land (Unix-Sekunden), gefiltert auf
`> "2026-09-29T00:00:00Z"`, und las sie aus dem gerade gespeicherten Snapshot, statt die Liste
noch einmal abzurufen. Ein einzelner Snapshot zeigt, welche Hinweise bearbeitet wurden, nicht
aber, ob sich eine Stufe geändert hat.

```
Aktualisierte Reisehinweise seit 29.09.2026 – 21 von 200 Ländern (Stand 06.10.2026)
Kein früherer Snapshot, neue oder aufgehobene Warnungen lassen sich noch nicht zeigen.

Länder mit Warnung und aktualisiertem Hinweis (Stufe heute)
  05.10.  Kenia (KE · 208058)                       Teilreisewarnung
  01.10.  Äthiopien (ET · 209504)                   Teilreisewarnung
  29.09.  Pakistan (PK · 204974)                    Teilreisewarnung
  29.09.  Nigeria (NG · 205788)                     Teilreisewarnung
  29.09.  Ägypten (EG · 212622)                     Teilreisewarnung

Länder ohne Warn-Flag mit aktualisiertem Hinweis (16) – kein Flag heißt nicht „unbedenklich";
für jedes davon ist ein Reise-Check möglich
  05.10. Taiwan*, Zypern, Spanien, Kroatien, Griechenland · 02.10. Guinea-Bissau, Malediven ·
  01.10. Nordmazedonien, Bosnien und Herzegowina, Brasilien, Ecuador · 30.09. Tansania,
  Vereinigte Arabische Emirate, Mexiko · 29.09. Dänemark, Schweden

Ausgangsstand gespeichert: reisewarnungen-2026-10-06.json (200 Länder, 56.038 Bytes).
```

Als Nächstes angeboten: nächste Woche einen neuen Snapshot speichern und ihn per `id` mit diesem vergleichen.
