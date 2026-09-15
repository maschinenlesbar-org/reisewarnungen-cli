# Examples

Real examples for the Claude Code skills of the `reisewarnungen` plugin, one per skill: a request,
the `reisewarnungen` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `reisewarnungen` 0.0.7.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [reisewarnungen-trip-check](#reisewarnungen-trip-check) · [reisewarnungen-warned-overview](#reisewarnungen-warned-overview) · [reisewarnungen-watch](#reisewarnungen-watch)

## reisewarnungen-trip-check

> We're flying to Jordan and Saudi Arabia in October. What does the German Foreign Office say?

```bash
reisewarnungen countries --compact      # resolved by iso3CountryCode: JOR → 218008, SAU → 202298
reisewarnungen get 202298 --compact
reisewarnungen get 218008 --compact
```

The English names were matched on `iso3CountryCode`, because `countryName` is German
(`Jordanien`, `Saudi-Arabien`). Jordan has all four flags `false`, but its advisory still
advises against non-essential travel. The skill therefore read the security sections instead
of stopping at the flags, and did not call Jordan all clear.

```
Saudi-Arabien (SA · 202298)   Regional warning (Teilreisewarnung)
Auswärtiges Amt, advice effective 11 Sep 2026. Last change: Aktuelles – Sicherheitslage in
der Region; Sicherheit – Teilreisewarnung; editorial changes.
  • Warning for the 30 km strip along the Yemen border in Nadschran, Asir and Dschaizan.
  • Travel within about 100 km of that border, including Abha and Khamis Muschait, is strongly
    discouraged.
  • The region stays volatile after the June 2026 US–Iran declaration: strikes continue, and
    fighting may spread and airspace may close. The terror threat is elevated. Keep well away
    from US and military sites.
  • Photographing or filming anything linked to the fighting is strictly prohibited.
  • Crime is comparatively low; phone fraud is widespread.

Jordanien (JO · 218008)   Advice only: no warning flag, but a Sicherheitshinweis
Advice effective 27 Aug 2026. Last change: Aktuelles; Sicherheit – Sicherheitshinweis; editorial.
  • Travel to the Syrian border area, the north-east and the Iraqi border region is strongly
    discouraged. Non-essential travel to the rest of the country is discouraged.
  • Military strikes on targets in the region, including bases in Jordan, remain possible, and
    airspace may close. Avoid US-associated sites and demonstrations.
  • Israel–Jordan crossings (King-Hussein-/Allenby-Brücke) may change hours or close at short notice.
  • In autumn and winter, flash floods hit wadis (visitors were evacuated from the Petra canyon in 2025).

Combined: Saudi-Arabien has a regional warning for the Yemen border area. Jordan has no
formal warning, but the Foreign Office currently advises against non-essential travel there.
This is the German Auswärtiges Amt's advice, published in German.
Full advisories: reisewarnungen get 202298 · reisewarnungen get 218008
```

## reisewarnungen-warned-overview

> Where in Africa does the German Foreign Office warn against travel right now?

```bash
reisewarnungen countries --warned-only --compact
```

46 countries worldwide carry a warning (18 full, 28 regional). None has a `situation*` flag.
The data has no region field, so the skill mapped `countryCode` to Africa, counting Egypt
(`EG`) as African.

```
German travel warnings in Africa — 23 of 46 warned countries (7 full, 16 regional)
Source: Auswärtiges Amt, as of 15 Sep 2026.

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

Updated since 08.09.: Mali, Südsudan, Burkina Faso, Togo (all 14.09.), Kamerun (08.09.).
Outside Africa: 11 full warnings (Afghanistan, Belarus, Haiti, Irak, Iran, Jemen, Myanmar,
Palästinensische Gebiete*, Russische Föderation, Syrien, Ukraine) and 12 regional.
```

Next steps offered: details on any country (`reisewarnungen get <id>` or reisewarnungen-trip-check),
and reisewarnungen-watch to track changes.

## reisewarnungen-watch

> Which travel advisories changed in the past week? And start tracking them for me.

```bash
reisewarnungen countries --compact -o reisewarnungen-2026-09-15.json    # baseline, 200 countries
reisewarnungen countries --compact -o reisewarnungen-2026-09-15.json    # exit 1: won't overwrite without --force
reisewarnungen countries --compact | jq -r 'sort_by(-.lastModified) | .[:15][] | …'
```

No earlier snapshot existed, so there was nothing to diff. The skill used the freshness view on
per-country `lastModified` (Unix seconds), filtered to `> "2026-09-08T00:00:00Z"`, and kept
today's file as the baseline. A single snapshot shows which advisories were edited, not whether
a level changed.

```
Advisory updates since 08.09.2026 — 27 of 200 countries (as of 15.09.2026)
No earlier snapshot, so new or lifted warnings can't be shown yet.

Warned countries with an updated advisory (level today)
  15.09.  Palästinensische Gebiete* (PS · 203674)   full warning
  14.09.  Südsudan (SS · 244250)                    full warning
  14.09.  Mali (ML · 208258)                        full warning
  14.09.  Togo (TG · 213850)                        regional warning
  14.09.  Burkina Faso (BF · 212336)                regional warning
  11.09.  Saudi-Arabien (SA · 202298)               regional warning
  10.09.  Thailand (TH · 201558)                    regional warning
  09.09.  Jemen (YE · 202260)                       full warning
  09.09.  Ukraine (UA · 201946)                     full warning
  08.09.  Kamerun (CM · 208874)                     regional warning

Advice-only countries with an updated advisory (17)
  15.09. Ecuador, Australien, Israel, Kirgisistan · 14.09. Timor-Leste, Senegal, Marokko,
  Guinea, Malawi · 11.09. Kosovo, Niederlande · 10.09. Gambia, USA · 09.09. Brasilien ·
  08.09. Nepal, Indonesien, Nicaragua

Baseline saved: reisewarnungen-2026-09-15.json (200 countries, 56,038 bytes).
```

Next steps offered: save a new snapshot next week and diff it against this one by `id`.
