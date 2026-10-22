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
import { stdoutWriter, type CliDeps } from "../src/cli/io.js";
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7, bug 3)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative only from Node 26) and on the
  // answer: every `list` answer has integer-like keys ("226768"), which take JSON.stringify off its
  // iterative path, so on `list` --compact failed at the same depth and the hint never helped.
  // Probed here, never assumed.
  const depth = 200_000;
  const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
  // What each command prints: get the entry, list the whole response.
  for (const [argv, body, printed] of [
    [["get", "100"], `{"response":{"100":{"warning":true,"partialWarning":false,"x":${deep}}}}`, (r: Record<string, unknown>) => r["100"]],
    [["list"], `{"response":{"lastModified":1,"100":{"warning":true,"partialWarning":false,"x":${deep}}}}`, (r: Record<string, unknown>) => r],
  ] as const) {
    let compactPrints = true;
    try {
      JSON.stringify(printed((JSON.parse(body) as { response: Record<string, unknown> }).response));
    } catch {
      compactPrints = false;
    }
    const answer = () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body) });
    const pretty = makeCli(answer);
    assert.equal(await run([...argv], pretty.deps), 1);
    assert.deepEqual(pretty.out, []);
    assert.deepEqual(pretty.err, [
      `ERROR [reisewarnungen.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
    ], argv.join(" "));
    const compact = makeCli(answer);
    assert.equal(await run(["--compact", ...argv], compact.deps), compactPrints ? 0 : 1, argv.join(" "));
    if (!compactPrints) assert.deepEqual(compact.err, ["ERROR [reisewarnungen.output] The answer is nested too deeply to print."]);
  }
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
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

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli();
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
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

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (D6)", async () => {
  await inTempDir(async (dir) => {
    const { openSync, closeSync } = await import("node:fs");
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: string[] = [];
      const fake = { fd, write: (text: string) => streamed.push(text), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream.
      stdoutWriter(fake)("x".repeat(100_000));
      assert.equal(readFileSync(path, "utf8").length, 100_000);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
    } finally {
      closeSync(fd);
    }
    // Not a file (a pipe, a terminal): the stream writes it, as before.
    const piped: string[] = [];
    stdoutWriter({ write: (text: string) => piped.push(text), emit: () => true })("data");
    assert.deepEqual(piped, ["data"]);
  });
});
