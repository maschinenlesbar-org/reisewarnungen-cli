# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `reisewarnungen`, eines pro Skill: eine
Anfrage, die `reisewarnungen`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `reisewarnungen` 0.0.7 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [reisewarnungen-trip-check](#reisewarnungen-trip-check) · [reisewarnungen-warned-overview](#reisewarnungen-warned-overview) · [reisewarnungen-watch](#reisewarnungen-watch)

## reisewarnungen-trip-check

> Im Oktober geht es nach Jordanien und Saudi-Arabien. Was sagt das Auswärtige Amt dazu?

```bash
reisewarnungen countries --compact      # aufgelöst über iso3CountryCode: JOR → 218008, SAU → 202298
reisewarnungen get 202298 --compact
reisewarnungen get 218008 --compact
```

Die Länder wurden über `iso3CountryCode` aufgelöst, das funktioniert auch bei englischen
Anfragen. Bei Jordanien stehen alle vier Flags auf `false`, der Hinweistext rät aber trotzdem von
nicht notwendigen Reisen ab. Der Skill hat deshalb die Sicherheitsabschnitte gelesen, statt bei
den Flags stehen zu bleiben, und Jordanien nicht als unbedenklich eingestuft.

```
Saudi-Arabien (SA · 202298)   Teilreisewarnung
Auswärtiges Amt, gültig seit 11.09.2026. Letzte Änderung: Aktuelles – Sicherheitslage in der
Region; Sicherheit – Teilreisewarnung; redaktionelle Änderungen.
  • Reisewarnung für den 30-km-Streifen an der Grenze zu Jemen in Nadschran, Asir und Dschaizan.
  • Von Reisen bis etwa 100 km an diese Grenze heran, einschließlich Abha und Khamis Muschait,
    wird dringend abgeraten.
  • Die Lage in der Region bleibt nach der Absichtserklärung zwischen den USA und Iran vom Juni
    2026 volatil: Weiter Angriffe, Kämpfe können sich ausweiten, Luftraumsperrungen sind möglich,
    erhöhte Terrorgefahr. US-Einrichtungen und militärische Liegenschaften weiträumig meiden.
  • Fotografieren und Filmen im Zusammenhang mit den Kampfhandlungen ist streng verboten.
  • Kriminalität vergleichsweise niedrig, Telefonbetrug weit verbreitet.

Jordanien (JO · 218008)   Keine Warnung gesetzt, aber Sicherheitshinweis
Gültig seit 27.08.2026. Letzte Änderung: Aktuelles; Sicherheit – Sicherheitshinweis; redaktionell.
  • Von Reisen ins syrisch-jordanische Grenzgebiet, in den Nordosten und in die Grenzregion zu
    Irak wird dringend abgeraten, von nicht notwendigen Reisen in andere Landesteile abgeraten.
  • Militärische Schläge gegen Ziele in der Region, auch gegen Stützpunkte in Jordanien, bleiben
    möglich, Luftraumsperrungen ebenso. US-nahe Einrichtungen und Demonstrationen meiden.
  • Grenzübergänge Israel–Jordanien (King-Hussein-/Allenby-Brücke) können kurzfristig anders öffnen oder schließen.
  • Im Herbst und Winter drohen Sturzfluten in Wadis (2025 wurden Reisende aus der Schlucht von Petra evakuiert).

Gesamt: Für Saudi-Arabien gilt eine Teilreisewarnung für das Grenzgebiet zu Jemen. Für Jordanien
gibt es keine formelle Warnung, das Auswärtige Amt rät derzeit aber von nicht notwendigen Reisen ab.
Vollständige Hinweise: reisewarnungen get 202298 · reisewarnungen get 218008
```

## reisewarnungen-warned-overview

> Für welche Länder in Afrika warnt das Auswärtige Amt derzeit vor Reisen?

```bash
reisewarnungen countries --warned-only --compact
```

Weltweit sind 46 Länder betroffen (18 Reisewarnungen, 28 Teilreisewarnungen). Kein Land hat ein
`situation*`-Flag. Die Daten enthalten kein Regionsfeld, also hat der Skill Afrika über
`countryCode` zugeordnet und Ägypten (`EG`) mitgezählt.

```
Reisewarnungen für Afrika – 23 von 46 Ländern mit Warnung (7 Reisewarnungen, 16 Teilreisewarnungen)
Quelle: Auswärtiges Amt, Stand 15.09.2026.

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

Aktualisiert seit 08.09.: Mali, Südsudan, Burkina Faso, Togo (alle 14.09.), Kamerun (08.09.).
Außerhalb Afrikas: 11 Reisewarnungen (Afghanistan, Belarus, Haiti, Irak, Iran, Jemen, Myanmar,
Palästinensische Gebiete*, Russische Föderation, Syrien, Ukraine) und 12 Teilreisewarnungen.
```

Als Nächstes angeboten: Details zu einzelnen Ländern (`reisewarnungen get <id>` oder
reisewarnungen-trip-check) und reisewarnungen-watch, um Änderungen zu verfolgen.

## reisewarnungen-watch

> Welche Reisehinweise haben sich in der letzten Woche geändert? Und das künftig im Blick behalten.

```bash
reisewarnungen countries --compact -o reisewarnungen-2026-09-15.json    # Ausgangsstand, 200 Länder
reisewarnungen countries --compact -o reisewarnungen-2026-09-15.json    # Exit 1: überschreibt nicht ohne --force
reisewarnungen countries --compact | jq -r 'sort_by(-.lastModified) | .[:15][] | …'
```

Einen früheren Snapshot gab es nicht, also auch nichts zu vergleichen. Der Skill nutzte die
Aktualitätsansicht über das `lastModified` je Land (Unix-Sekunden), gefiltert auf
`> "2026-09-08T00:00:00Z"`, und behielt die heutige Datei als Ausgangsstand. Ein einzelner
Snapshot zeigt, welche Hinweise bearbeitet wurden, nicht aber, ob sich eine Stufe geändert hat.

```
Aktualisierte Reisehinweise seit 08.09.2026 – 27 von 200 Ländern (Stand 15.09.2026)
Kein früherer Snapshot, neue oder aufgehobene Warnungen lassen sich noch nicht zeigen.

Länder mit Warnung und aktualisiertem Hinweis (Stufe heute)
  15.09.  Palästinensische Gebiete* (PS · 203674)   Reisewarnung
  14.09.  Südsudan (SS · 244250)                    Reisewarnung
  14.09.  Mali (ML · 208258)                        Reisewarnung
  14.09.  Togo (TG · 213850)                        Teilreisewarnung
  14.09.  Burkina Faso (BF · 212336)                Teilreisewarnung
  11.09.  Saudi-Arabien (SA · 202298)               Teilreisewarnung
  10.09.  Thailand (TH · 201558)                    Teilreisewarnung
  09.09.  Jemen (YE · 202260)                       Reisewarnung
  09.09.  Ukraine (UA · 201946)                     Reisewarnung
  08.09.  Kamerun (CM · 208874)                     Teilreisewarnung

Länder ohne Warnung mit aktualisiertem Hinweis (17)
  15.09. Ecuador, Australien, Israel, Kirgisistan · 14.09. Timor-Leste, Senegal, Marokko,
  Guinea, Malawi · 11.09. Kosovo, Niederlande · 10.09. Gambia, USA · 09.09. Brasilien ·
  08.09. Nepal, Indonesien, Nicaragua

Ausgangsstand gespeichert: reisewarnungen-2026-09-15.json (200 Länder, 56.038 Bytes).
```

Als Nächstes angeboten: nächste Woche einen neuen Snapshot speichern und ihn per `id` mit diesem vergleichen.
