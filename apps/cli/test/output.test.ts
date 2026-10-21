// The output sink (renderJson and checkOutputTarget in src/cli/shared.ts, the file seam in
// io.ts): rendering, `-o` and `--force`. The `-o` cases run through run() against real files in
// a temp dir; a write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import type { CliDeps } from "../src/cli/io.js";
import { ReisewarnungenClient } from "@maschinenlesbar.org/reisewarnungen-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/reisewarnungen-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

const ENTRY = { countryName: "Ein \u001b[31mrotes\u009b Land", warning: true, partialWarning: false };
const DETAIL = { response: { "100": ENTRY } };
const LIST = { response: { lastModified: 1, "100": ENTRY } };

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = (req) => jsonResponse(req.url.endsWith("/100") ? DETAIL : LIST)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new ReisewarnungenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "reisewarnungen-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and says so in an INFO record", async () => {
  await inTempDir(async (dir) => {
    const shown = makeCli();
    assert.equal(await run(["countries"], shown.deps), 0);
    const path = join(dir, "countries.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "countries"], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.doesNotMatch(written, /[\u001b\u009b]/, "control characters are escaped in the file too");
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [reisewarnungen.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    assert.deepEqual(readdirSync(dir), ["countries.json"], "no temporary file is left");
  });
});

test("-o - prints to stdout and creates no file", async () => {
  await inTempDir(async (dir) => {
    const cli = makeCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "countries"], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "countries"], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(cli.err, []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a refused -o target is a usage error before any request", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const cases: Array<[string[], string]> = [
      [["-o", "", "countries"], "Output path must not be empty."],
      [["-o", "  ", "countries"], "Output path must not be empty."],
      [["--force", "countries"], "--force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "countries"], `Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["-o", dangling, "countries"], `Refusing to overwrite existing file "${dangling}"; pass --force to overwrite.`],
      [["-o", sub, "countries"], `"${sub}" is a directory; give a file path to --output.`],
      [["-o", sub, "--force", "get", "100"], `"${sub}" is a directory; give a file path to --output.`],
    ];
    for (const [argv, message] of cases) {
      const cli = makeCli();
      assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.ok(cli.err.some((line) => line.startsWith("ERROR [reisewarnungen.cli]") && line.includes(message)), `${argv.join(" ")}: ${cli.err.join(" | ")}`);
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("--force replaces an existing file, keeps its mode, and writes through a symlink", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "countries"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), [{ id: "100", ...ENTRY }]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    assert.equal(await run(["--compact", "-o", link, "--force", "get", "100"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ENTRY);
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; over a dangling link it replaces the link with the file", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "countries"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), [{ id: "100", ...ENTRY }]);
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "countries"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(dangling, "utf8")), [{ id: "100", ...ENTRY }]);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json"]);
  });
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of the output area", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli(() => {
      writeFileSync(path, "theirs");
      return jsonResponse(LIST);
    });
    assert.equal(await run(["-o", path, "countries"], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [`ERROR [reisewarnungen.output] Refusing to overwrite existing file "${path}"; pass --force to overwrite.`]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, exit 1", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "missing-dir", "out.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "countries"], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, new RegExp(`^ERROR \\[reisewarnungen\\.output\\] Could not write to ".*out\\.json": ENOENT`));
  });
});

test("pretty-printing an answer nested too deeply is a clean error that suggests --compact", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't.
  const depth = 200_000;
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(`{"response":{"100":{"warning":true,"partialWarning":false,"x":${"[".repeat(depth)}${"]".repeat(depth)}}}}`),
  }));
  assert.equal(await run(["get", "100"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err, ["ERROR [reisewarnungen.output] The answer is nested too deeply to pretty-print; try --compact."]);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("printed JSON escapes DEL, C1 and the bidi controls, on stdout and in the -o file", async () => {
  // JSON.stringify leaves them raw, and a terminal acts on them: U+202E reverses the text after it.
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const name = `A\u007fB\u0085C\u009bD${String.fromCharCode(...bidi)}E`;
  const cli = makeCli(() => jsonResponse({ response: { "100": { ...ENTRY, countryName: name } } }));
  assert.equal(await run(["--compact", "get", "100"], cli.deps), 0);
  const text = cli.out.join("\n");
  assert.ok(text.includes(`"A\\u007fB\\u0085C\\u009bD${bidi.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("")}E"`), text);
  assert.doesNotMatch(text, /[\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
  assert.equal((JSON.parse(text) as { countryName: string }).countryName, name);
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    assert.equal(await run(["--compact", "-o", path, "get", "100"], makeCli(() => jsonResponse({ response: { "100": { ...ENTRY, countryName: name } } })).deps), 0);
    assert.equal(readFileSync(path, "utf8"), `${text}\n`);
  });
});
