// The CLI logs each retry as one WARN record of `reisewarnungen.http`; stdout is the same as
// without the retry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { ReisewarnungenClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";
import { jsonResponse, untimed } from "./helpers.js";

const body = { response: { lastModified: 1700000000, "100": { countryName: "Atlantis", warning: true, partialWarning: false } } };

async function exercise(extra: string[], failures: number, retryAfter?: string) {
  const out: string[] = [];
  const err: string[] = [];
  let n = 0;
  const transport = async (): Promise<HttpResponse> =>
    n++ < failures
      ? { status: 503, headers: retryAfter ? { "retry-after": retryAfter } : {}, body: Buffer.from("{}") }
      : jsonResponse(body);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {} },
    now: () => new Date("2026-01-02T03:04:05.678Z"),
    createClient: (opts) => new ReisewarnungenClient({ ...opts, transport, sleep: async () => {} }),
  };
  const code = await run([...extra, "--base-url", "https://mirror.test/opendata", "list"], deps);
  return { code, out: out.join("\n"), err };
}

test("a 503 then 200 exits 0, same stdout, and logs one WARN of reisewarnungen.http", async () => {
  const plain = await exercise([], 0);
  const retried = await exercise([], 1, "2");
  assert.equal(retried.code, 0);
  assert.equal(retried.out, plain.out);
  assert.equal(plain.err.length, 0);
  assert.deepEqual(untimed(retried.err.join("\n")).split("\n"), [
    "WARN  [reisewarnungen.http] HTTP 503 from mirror.test: retry 1 of 2 in 2 s",
  ]);
});

test("the same record in jsonl, with the delay in ms under one second", async () => {
  const r = await exercise(["--log-format", "jsonl"], 1);
  assert.equal(r.code, 0);
  assert.equal(r.err.length, 1);
  const rec = JSON.parse(r.err[0] as string) as Record<string, unknown>;
  assert.equal(rec["level"], "WARN");
  assert.equal(rec["topic"], "reisewarnungen.http");
  assert.equal(rec["msg"], "HTTP 503 from mirror.test: retry 1 of 2 in 200 ms");
});
