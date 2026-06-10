# reisewarnungen-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
Germany's official travel and safety advice, all powered by the
**[reisewarnungen](README.md)** CLI over the open
[Auswärtiges Amt travel-warning API](https://www.auswaertiges-amt.de/opendata/travelwarning)
(`auswaertiges-amt.de`).

Each skill teaches Claude how to drive the `reisewarnungen` CLI to answer a specific,
real-world question — "is it safe to travel to Thailand?", "which countries does Germany
warn against?", "what travel warnings changed since last week?" — and to report the answer
with the level and evidence rather than guesswork. They encode the parts that are easy to
get wrong (German country names, seconds-not-milliseconds timestamps, the HTML advisory
body, the `id`-less `get` result) so Claude doesn't rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **reisewarnungen-trip-check** | Resolves a country name to its content id, classifies the warning level, and distils the long HTML advisory into a plain-language briefing. | "is it safe to travel to Thailand?", "travel warning for Egypt?", "I'm going to Kenya and Tanzania — any warnings?" |
| **reisewarnungen-warned-overview** | Pulls every warned country and ranks/groups it by severity (full → regional), optionally filtered to a region. | "which countries have a travel warning?", "list all full travel warnings", "warned countries in Africa" |
| **reisewarnungen-watch** | Saves dated snapshots and diffs two to surface newly-warned, lifted, and freshly-updated countries; or a freshness view from one snapshot. | "what warnings changed since last week?", "which advisories were updated recently?", "diff today against this snapshot" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `reisewarnungen` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/reisewarnungen-cli   # installs the `reisewarnungen` bin
  ```
  No API key is required — the Auswärtiges Amt travel-warning API is free, open, and
  read-only.
- **[`jq`](https://jqlang.github.io/jq/)** for the filtering/diff recipes the skills use.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/reisewarnungen-cli
/plugin install reisewarnungen@reisewarnungen-skills
```

The first command registers the marketplace; the second installs the `reisewarnungen`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/reisewarnungen-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/reisewarnungen-trip-check/SKILL.md`. Start a new Claude Code session and the
skills are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Is it safe to travel to Thailand right now? What does the Foreign Office say?

> List every country Germany currently has a full travel warning for.

> Which travel advisories were updated in the last week?

You can also invoke a skill explicitly with its slash command, e.g.
`/reisewarnungen-trip-check`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`reisewarnungen` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this API, for example:

- **timestamps are Unix *seconds***, not milliseconds — older docs say ms, but a value
  like `1780665504` is June 2026, so `(.lastModified|todate)` works directly and JS code
  must multiply by 1000;
- **`get` results carry no `id` field** — unlike `countries`/`list` entries; the id is the
  key you queried by, so the skill remembers it itself;
- **country names are German** (`Ägypten`, `Russische Föderation`, `Côte d'Ivoire`) — match
  on `countryCode`/`iso3CountryCode` for English requests, and never hard-code a content id
  (ids can change as the catalogue updates);
- the `content` field is a **40–60 KB HTML** advisory — extract its German section headings
  (`Aktuelles`, `Sicherheit`, `Terrorismus`, …) and summarise rather than dumping it;
- only **`warning` and `partialWarning`** are set in current data; the `situation*` flags
  exist in the schema but are presently all `false` — don't claim a level the flags don't
  support, and read "all flags false" as advice-only, not "no data";
- `list`'s top-level `lastModified` is a **stale dataset-level** value (≈ Nov 2024); for
  change-tracking use the **per-country** `lastModified` instead;
- a missing country makes `get` exit **`4`** (`HTTP 404`) — that's a wrong id, not a safe
  country; an empty `--warned-only` array (exit `0`) means no warnings are in force.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
