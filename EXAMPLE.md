# Examples

Real examples for the Claude Code skills of the `reisewarnungen` plugin, one per skill: a request,
the `reisewarnungen` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `reisewarnungen` 0.2.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [reisewarnungen-trip-check](#reisewarnungen-trip-check) · [reisewarnungen-warned-overview](#reisewarnungen-warned-overview) · [reisewarnungen-watch](#reisewarnungen-watch)

## reisewarnungen-trip-check

> We're flying to Jordan and Saudi Arabia in October. What does the German Foreign Office say?

```bash
reisewarnungen countries --compact      # resolved by iso3CountryCode: JOR → 218008, SAU → 202298
reisewarnungen advice 202298 --compact
reisewarnungen advice 218008 --compact
reisewarnungen get 202298 --compact
reisewarnungen get 218008 --compact
```

The English names were matched on `iso3CountryCode`, because `countryName` is German
(`Jordanien`, `Saudi-Arabien`). Saudi Arabia has `partialWarning`; Jordan has all four flags
`false`. `advice` listed 20 and 17 sentences, 9 and 10 of them marked `travel`. Jordan's include
„Von Reisen in das unmittelbare syrisch-jordanische Grenzgebiet … wird dringend abgeraten", so
the skill classified it as advice against travel, not advice only; the other `travel` sentences
(night driving, papers for minors, the terror risk) went into the bullets or were left out. The
full advisories (`get`) supplied the rest of the briefing.

```
Saudi-Arabien (SA · 202298)   Regional warning (Teilreisewarnung)
Auswärtiges Amt, advice effective 22 Sep 2026. Last change: Aktuelles – Sicherheitslage in
der Region; Sicherheit – Teilreisewarnung; editorial changes.
  • Warning for the 30 km strip along the Yemen border in Nadschran, Asir and Dschazan.
  • Travel within about 100 km of that border, including Abha and Khamis Muschait, is strongly
    discouraged; non-essential travel to all other regions of Saudi Arabia is discouraged.
  • Since early September 2026, Houthi drone and missile attacks have hit Al-Baha, Asir,
    Dschazan, Medina, Mekka, Nadschran and Tabuk, mostly oil and military sites, with deaths
    and injuries. More strikes and flight disruptions are expected. Keep well away from US,
    military and critical-infrastructure sites, avoid crowds, follow air-raid instructions.
  • Do not photograph or film impacts, fires, missile launches, debris or military sites.
  • Crime is comparatively low; phone fraud is widespread.

Jordanien (JO · 218008)   Advice against travel (no formal warning)
Advice effective 27 Aug 2026. Last change: Aktuelles; Sicherheit – Sicherheitshinweis; editorial.
  • Travel to the Syrian border area, the north-east and the Iraqi border region is strongly
    discouraged. Non-essential travel to the rest of the country is discouraged.
  • Military strikes on targets in the region, including bases in Jordan, remain possible, and
    flights may be suspended. Avoid US-associated and military sites and all demonstrations.
  • Israel–Jordan crossings (King-Hussein-/Allenby-Brücke) may change hours or close at short
    notice; roads near the borders, the Dead Sea Highway included, may be closed or checked.
  • Overland driving after dark is discouraged.
  • In autumn and winter, flash floods hit wadis (visitors were evacuated from the Petra canyon in 2025).

Combined: Saudi-Arabien has a regional warning for the Yemen border area and advises against
non-essential travel elsewhere. Jordan has no formal warning, but the Foreign Office advises
against travel to its border regions and against non-essential travel to the rest of the country.
This is the German Auswärtiges Amt's advice, published in German.
Full advisories: reisewarnungen get 202298 · reisewarnungen get 218008
```

## reisewarnungen-warned-overview

> Where in Africa does the German Foreign Office warn against travel right now?

```bash
reisewarnungen countries --warned-only --compact
```

46 countries worldwide carry a warning flag (18 full, 28 regional). None has a `situation*`
flag. The data has no region field, so the skill mapped `countryCode` to Africa, counting Egypt
(`EG`) as African.

```
German travel warnings in Africa — 23 of 46 warned countries (7 full, 16 regional)
Source: Auswärtiges Amt, as of 6 Oct 2026. Formal warnings only: advice against travel
without a flag is in the advisory texts (ask for a trip check on a country).

Full travel warning (Reisewarnung) — 7
  Libyen (LY · 219624)        Mali (ML · 208258)          Niger (NE · 226384)
  Somalia (SO · 203132)       Sudan (SD · 203266)         Südsudan (SS · 244250)
  Zentralafrikanische Republik (CF · 226450)

Regional warning (Teilreisewarnung) — 16, covering parts of each country only
  Ägypten (EG · 212622)       Algerien (DZ · 219044)      Äthiopien (ET · 209504)
  Benin (BJ · 208984)         Burkina Faso (BF · 212336)  Côte d'Ivoire (CI · 209460)
  Demokratische Republik Kongo (CD · 203202)              Eritrea (ER · 226176)
  Ghana (GH · 203372)         Kamerun (CM · 208874)       Kenia (KE · 208058)
  Mauretanien (MR · 219190)   Mosambik (MZ · 221782)      Nigeria (NG · 205788)
  Togo (TG · 213850)          Tschad (TD · 225774)

Updated since 29.09.: Kenia (05.10.), Äthiopien (01.10.), Nigeria, Ägypten (both 29.09.).
Outside Africa: 11 full warnings (Afghanistan, Belarus, Haiti, Irak, Iran, Jemen, Myanmar,
Palästinensische Gebiete*, Russische Föderation, Syrien, Ukraine) and 12 regional.
```

Next steps offered: details on any country (`reisewarnungen advice <id>`, `get <id>` or
reisewarnungen-trip-check), and reisewarnungen-watch to track changes.

## reisewarnungen-watch

> Which travel advisories changed in the past week? And start tracking them for me.

```bash
reisewarnungen countries --compact -o reisewarnungen-2026-10-06.json    # baseline, 200 countries
reisewarnungen countries --compact -o reisewarnungen-2026-10-06.json    # exit 1: won't overwrite without --force
jq -r 'sort_by(-.lastModified) | .[] | select(.lastModified > ("2026-09-29T00:00:00Z"|fromdate)) | …' reisewarnungen-2026-10-06.json
```

No earlier snapshot existed, so there was nothing to diff. The skill used the freshness view on
per-country `lastModified` (Unix seconds), filtered to `> "2026-09-29T00:00:00Z"`, and read it
from the snapshot it had just saved rather than fetching the list again. A single snapshot shows
which advisories were edited, not whether a level changed.

```
Advisory updates since 29.09.2026 — 21 of 200 countries (as of 06.10.2026)
No earlier snapshot, so new or lifted warnings can't be shown yet.

Warned countries with an updated advisory (level today)
  05.10.  Kenia (KE · 208058)                       regional warning
  01.10.  Äthiopien (ET · 209504)                   regional warning
  29.09.  Pakistan (PK · 204974)                    regional warning
  29.09.  Nigeria (NG · 205788)                     regional warning
  29.09.  Ägypten (EG · 212622)                     regional warning

Countries without a warning flag, advisory updated (16) — no flag is not "all clear";
ask for a trip check on any of them
  05.10. Taiwan*, Zypern, Spanien, Kroatien, Griechenland · 02.10. Guinea-Bissau, Malediven ·
  01.10. Nordmazedonien, Bosnien und Herzegowina, Brasilien, Ecuador · 30.09. Tansania,
  Vereinigte Arabische Emirate, Mexiko · 29.09. Dänemark, Schweden

Baseline saved: reisewarnungen-2026-10-06.json (200 countries, 56,038 bytes).
```

Next steps offered: save a new snapshot next week and diff it against this one by `id`.
