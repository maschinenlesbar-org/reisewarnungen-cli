# reisewarnungen-mcp

An [MCP](https://modelcontextprotocol.io/) server for the travel and safety advice
(Reise- und Sicherheitshinweise) of the German Federal Foreign Office (Auswärtiges Amt), from its
[open-data interface](https://www.auswaertiges-amt.de/de/service/opendata/open-data-schnittstelle-736118):
about 200 countries, each with its four warning flags and a long German advisory, as tools for AI
agents. Read-only, no API key. The data is under the Auswärtiges Amt's own terms of use, with no
open licence (see Licence).

It is the MCP side of [reisewarnungen-cli](https://github.com/maschinenlesbar-org/reisewarnungen-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/reisewarnungen-mcp
```

This installs the **`reisewarnungen-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/reisewarnungen-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add reisewarnungen -- reisewarnungen-mcp
# or with the image:
claude mcp add reisewarnungen -- docker run -i --rm ghcr.io/maschinenlesbar-org/reisewarnungen-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "reisewarnungen": { "command": "reisewarnungen-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "reisewarnungen": { "type": "stdio", "command": "reisewarnungen-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
reisewarnungen-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http reisewarnungen http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/reisewarnungen-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/reisewarnungen-cli/releases) instead of
`latest`: `…/reisewarnungen-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/reisewarnungen-mcp:<version> --repo maschinenlesbar-org/reisewarnungen-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getTravelAdvice` | One to five countries of a trip: each one's warning level and every sentence of its advisory that may advise against travel there or to a region, with the date the advice took effect and the last changes. |
| `getWarnedCountries` | Every country under a formal travel warning, full warnings (Reisewarnung) first, then regional ones (Teilreisewarnung), with the totals. |
| `getWarningChanges` | What changed since a snapshot of an earlier answer (newly warned, escalated, downgraded, lifted, other flags, text revised), or the advisories changed since a date. |
| `listCountries` | Every country with its content id, ISO codes, warning level and dates, a page at a time. |
| `getAdvisory` | One country's whole advisory as text, block by block with its section, or one section (Einreise, Visum, Gesundheit). |

Countries go by their official German short name (`Ägypten`, `Russische Föderation`, `USA`), an
ISO code (`EG`, `RUS`) or a former or everyday German name (`Russland`, `Holland`); a name several
countries share (`Kongo`, `Korea`) is answered as ambiguous, never picked. The four flags record
only the formal warnings: a country without a flag can still be advised against in its text
(Türkei's border areas), so `getTravelAdvice` says `advice-in-text` and lists the sentences, and
only an advisory without such a sentence is `advice-only`. The server keeps no state: a watch keeps
the `snapshot` string of one answer and passes it back as `previous`.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (an answer a redirect fetched from another host says so there: "… (answered by
https://other.example after a redirect)", and a WARN record names both) and the data licence. A text
over 2000 characters is cut and ends in `…[cut, N characters in all]`, and the answer says
`truncated`. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.auswaertiges-amt.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes
  equal to another stays, as `name~2`), but it is still other people's text: a model can be told
  things in it. The server can't act on that (it has no tool that writes), but other tools in the
  same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/reisewarnungen-cli/blob/main/LICENSING.md)).
Data: the travel and safety advice is the Auswärtiges Amt's, under its custom terms of use for the
open-data interface, with no open licence
([terms](https://www.auswaertiges-amt.de/de/service/opendata/open-data-schnittstelle-736118),
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/reisewarnungen-cli/blob/main/DATA_LICENSE.md)):
it must be clearly recognisable that the information comes from the Auswärtiges Amt; its texts are
to be taken over completely and kept current (a summary or extract shifts the responsibility to
whoever makes it); there is no warranty of accuracy; commercial use is not settled; the Auswärtiges
Amt can revoke access; the advisories may be copyrighted. Every result carries this note in its
`licence` field, and the advisory's dates to cite. We provide the tool, not the data: running the
server as a service for others may need the provider's permission.
