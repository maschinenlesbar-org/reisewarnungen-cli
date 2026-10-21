// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings, and the runtime rule they describe (an option given as undefined is omitted).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReisewarnungenClient } from "../src/index.js";
import { constantJson } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "reisewarnungen-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { ReisewarnungenClient, type EngineOptions, type SummariesOptions } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const summaries: SummariesOptions = allUndefined<SummariesOptions>();",
        "export const client = new ReisewarnungenClient({ baseUrl: process.env.REISEWARNUNGEN_BASE_URL, timeoutMs: 15_000 });",
        "export const ids = async (): Promise<string[]> => (await client.summaries({ warnedOnly: process.env.X === undefined ? undefined : true })).map((c) => c.id);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const entry = { countryName: "A", warning: true, partialWarning: false };
  const mt = constantJson({ response: { "1": entry, "2": { ...entry, warning: false } } });
  const client = new ReisewarnungenClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  // warnedOnly undefined is the default (every country), not a filter.
  assert.equal((await client.summaries({ warnedOnly: undefined })).length, 2);
  assert.equal(mt.last().url, "https://www.auswaertiges-amt.de/opendata/travelwarning");
  assert.equal(mt.last().headers?.["User-Agent"], "reisewarnungen-cli");
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});
