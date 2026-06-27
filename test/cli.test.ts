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
      writeFile: (p, d) => files.set(p, d),
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

test("get on a 200-but-empty envelope maps to exit code 4 (not-found)", async () => {
  const cli = makeCli(() => jsonResponse({ response: { lastModified: 1 } }));
  const code = await run(["get", "226768"], cli.deps);
  assert.equal(code, 4);
  assert.ok(cli.err.join("\n").includes("226768"));
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

test("--output writes the file and confirms on stderr (stdout stays clean)", async () => {
  const cli = makeCli(() => jsonResponse(listBody));
  const code = await run(["--compact", "-o", "out.json", "countries"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.length, 0); // nothing on stdout
  assert.ok(cli.files.has("out.json"));
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to out\.json/);
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
