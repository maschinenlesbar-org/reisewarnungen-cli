import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { ReisewarnungenClient } from "../src/client/client.js";
import { ReiseNetworkError } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const listBody = {
  response: {
    lastModified: 1700000000,
    "100": { countryName: "Atlantis", warning: true },
    "200": { countryName: "Bukovia", warning: false },
  },
};

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      // Model the real exclusive-write semantics: without --force, a second write
      // to an existing path throws an EEXIST error just as writeFileSync("wx") does.
      writeFile: (p, d, force) => {
        if (!force && files.has(p)) {
          const err = new Error(`EEXIST: file already exists, open '${p}'`) as Error & { code: string };
          err.code = "EEXIST";
          throw err;
        }
        files.set(p, d);
      },
    },
    createClient: (opts) => new ReisewarnungenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, files, mt };
}

test("list hits the travelwarning path", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["list"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/opendata/travelwarning");
});

test("countries prints a flattened array", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  await run(["--compact", "countries"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { id: string }[];
  assert.equal(parsed.length, 2);
});

test("countries --warned-only filters to warnings in force", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  await run(["--compact", "countries", "--warned-only"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { countryName: string }[];
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.countryName, "Atlantis");
});

// Each of the four warning flags must independently satisfy --warned-only, so a
// regression dropping any single OR term would be caught here.
for (const flag of ["warning", "partialWarning", "situationWarning", "situationPartWarning"]) {
  test(`countries --warned-only keeps a country warned only via ${flag}`, async () => {
    const body = {
      response: {
        lastModified: 1,
        "100": { countryName: "Flagged", [flag]: true },
        "200": { countryName: "Clear", warning: false },
      },
    };
    const cli = makeCli(() => jsonResponse(body));
    await run(["--compact", "countries", "--warned-only"], cli.deps);
    const parsed = JSON.parse(cli.out.join("\n")) as { countryName: string }[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.countryName, "Flagged");
  });
}

test("countries pretty-prints (multi-line) without --compact", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  await run(["countries"], cli.deps);
  const text = cli.out.join("\n");
  assert.ok(text.includes("\n"), "pretty output should span multiple lines");
  assert.ok(text.includes("  "), "pretty output should be indented");
});

test("get builds the per-id path", async () => {
  const cli = makeCli(() =>
    jsonResponse({ response: { lastModified: 1, "226768": { countryName: "X" } } }),
  );
  await run(["get", "226768"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, "/opendata/travelwarning/226768");
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["get", "999999"], cli.deps);
  assert.equal(code, 4);
});

test("a 404 on list/countries is exit 1 (the endpoint is missing), not 4 (country not found)", async () => {
  for (const command of ["list", "countries"]) {
    const cli = makeCli(() => jsonResponse({}, 404));
    const code = await run([command], cli.deps);
    assert.equal(code, 1, command);
    assert.equal(
      cli.err.join("\n"),
      "Error: HTTP 404 for GET https://www.auswaertiges-amt.de/opendata/travelwarning " +
        "(the travel-warning list itself was not found: a wrong --base-url, or the API moved)",
    );
  }
});

test("get on a 200-but-empty envelope maps to exit code 4 (not-found)", async () => {
  const cli = makeCli(() => jsonResponse({ response: { lastModified: 1 } }));
  const code = await run(["get", "226768"], cli.deps);
  assert.equal(code, 4);
  assert.ok(cli.err.join("\n").includes("226768"));
});

test("get on a body without the response envelope is a parse error (exit 1), not exit 4", async () => {
  for (const body of [null, {}, { data: { items: [] } }]) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(["get", "100"], cli.deps);
    assert.equal(code, 1, JSON.stringify(body));
    assert.equal(
      cli.err.join("\n"),
      'Error: Unexpected response shape from /opendata/travelwarning/100: expected a JSON object with a "response" object.',
    );
  }
});

test("get on an envelope keyed by another id exits 1 and prints no country", async () => {
  const cli = makeCli(() =>
    jsonResponse({ response: { "999": { countryName: "OtherCountry" }, contentList: ["999"] } }),
  );
  const code = await run(["get", "100"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /expected the entry for content id "100"/);
});

test("a network failure maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new ReiseNetworkError("connection reset");
  });
  const code = await run(["list"], cli.deps);
  assert.equal(code, 1);
  assert.ok(cli.err.join("\n").startsWith("Error:"));
});

test("a malformed JSON success body maps to exit code 1 (parse error)", async () => {
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from("{ not json"),
  }));
  const code = await run(["list"], cli.deps);
  assert.equal(code, 1);
  assert.ok(cli.err.join("\n").startsWith("Error:"));
});

test("no command prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0); // never touched the network
  assert.equal(cli.err.length, 0); // help went to stdout, not stderr
  assert.match(cli.out.join("\n"), /Usage: reisewarnungen/);
});

test("a global flag without a command still shows help on stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["--compact"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: reisewarnungen/);
});

test("an unknown command still errors on stderr with exit 1", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["boguscmd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /unknown command 'boguscmd'/);
});

test("get rejects a non-numeric content id as a usage error (exit 1)", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["get", "199124x"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0); // rejected before any request
  assert.match(cli.err.join("\n"), /Invalid contentId "199124x"/);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    response: {
      lastModified: 1,
      "226768": { countryName: `Atlantis${controls}`, title: String.fromCharCode(0x1b) + "[31m" },
    },
  };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "list"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Atlantis\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served.response);
  }
});

test("--output writes the file and confirms on stderr (stdout stays clean)", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["--compact", "-o", "out.json", "countries"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.length, 0); // nothing on stdout
  assert.ok(cli.files.has("out.json"));
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to out\.json/);
});

test("--output refuses to overwrite an existing file without --force (exit 1)", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  cli.files.set("out.json", Buffer.from("existing"));
  const code = await run(["-o", "out.json", "countries"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Refusing to overwrite existing file out\.json.*--force/);
  // The pre-existing file is left untouched.
  assert.equal(cli.files.get("out.json")?.toString(), "existing");
});

test("--output with --force overwrites an existing file", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  cli.files.set("out.json", Buffer.from("existing"));
  const code = await run(["--force", "-o", "out.json", "countries"], cli.deps);
  assert.equal(code, 0);
  assert.notEqual(cli.files.get("out.json")?.toString(), "existing");
});

test("-o pointing at a directory says so (exit 1), not 'pass --force'", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultIO } = await import("../src/cli/io.js");
  const dir = mkdtempSync(join(tmpdir(), "reisewarnungen-cli-"));
  try {
    const cli = makeCli(() => jsonResponse(listBody));
    cli.deps.io.writeFile = defaultIO.writeFile;
    const code = await run(["-o", dir, "list"], cli.deps);
    assert.equal(code, 1);
    assert.equal(cli.err.join("\n"), `Error: "${dir}" is a directory; give a file path to --output.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed --output write surfaces a clean error (exit 1), not 'Unexpected error'", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  cli.deps.io.writeFile = () => {
    throw new Error("EACCES: permission denied, open 'out.json'");
  };
  const code = await run(["-o", "out.json", "countries"], cli.deps);
  assert.equal(code, 1);
  const errText = cli.err.join("\n");
  assert.match(errText, /Error: Could not write to out\.json/);
  assert.doesNotMatch(errText, /Unexpected error/);
});

test("--base-url rejects a non-http(s) scheme at parse time, never fetching", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["--base-url", "ftp://evil.test", "list"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0); // rejected before any request
  assert.match(cli.err.join("\n"), /base URLs are supported|is invalid/);
});

test("--base-url rejects a query or fragment at parse time", async () => {
  for (const url of ["http://127.0.0.1:1/ok#frag", "http://127.0.0.1:1/ok?x=1", "http://h/?"]) {
    const cli = makeCli(() => jsonResponse(listBody));
    const code = await run(["--base-url", url, "list"], cli.deps);
    assert.equal(code, 1, url);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /A base URL cannot have a query \(\?\) or fragment \(#\)\./);
  }
  // a path prefix (a mirror) still works
  const ok = makeCli(() => jsonResponse(listBody));
  assert.equal(await run(["--base-url", "http://mirror.test/aa/", "list"], ok.deps), 0);
  assert.equal(ok.mt.last().url, "http://mirror.test/aa/opendata/travelwarning");
});

test("--base-url rejects a malformed URL at parse time", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["--base-url", "notaurl", "list"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  assert.equal(await run(["--timeout", "2147483647", "list"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(listBody));
  assert.equal(await run(["--timeout", "2147483648", "list"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0); // rejected before any request
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("--max-retries is bounded to 0..10", async () => {
  const ok = makeCli(() => jsonResponse(listBody));
  assert.equal(await run(["--max-retries", "10", "list"], ok.deps), 0);
  const over = makeCli(() => jsonResponse(listBody));
  assert.equal(await run(["--max-retries", "11", "list"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 10/);
});

test("--max-redirects is parsed and passed through to the client", async () => {
  let seen: number | undefined;
  const deps: CliDeps = {
    io: { out: () => {}, err: () => {}, writeFile: () => {} },
    createClient: (opts) => {
      seen = opts.maxRedirects;
      return new ReisewarnungenClient({ ...opts, transport: makeMockTransport(() => jsonResponse(listBody)).transport });
    },
  };
  const code = await run(["--max-redirects", "0", "list"], deps);
  assert.equal(code, 0);
  assert.equal(seen, 0);
});
