// Conformance test P6 (fix plan 2026-10-06): retries never burst. `Retry-After: 0` or a date
// in the past waits at least the normal backoff; a long Retry-After is capped. Shared across
// the *-cli repos; only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { ReisewarnungenClient as Client } from "../src/client/client.js";
const call = (client: Client): Promise<unknown> => client.summaries();
const okBody = { response: { lastModified: 1, contentList: ["1"], "1": { countryName: "Atlantis", warning: false, partialWarning: false } } };
/** The shortest wait before retrying a 429 / a 503 without Retry-After (the documented backoff). */
const MIN_429_MS = 1000;
const MIN_503_MS = 200;
/** The documented ceiling on one Retry-After wait. */
const RETRY_AFTER_CAP_MS = 30_000;
/**
 * What a Retry-After above the cap does: "wait-cap" (wait the cap, then retry) or "fail"
 * (no retry; the error names the requested wait). reisewarnungen fails at once.
 */
const ABOVE_CAP = "fail" as "wait-cap" | "fail";
// --------------------------------------------------------------------------------------

async function sleepsFor(status: number, retryAfter: string | undefined, retries = 3): Promise<number[]> {
  const sleeps: number[] = [];
  let n = 0;
  const transport = async (): Promise<HttpResponse> => {
    if (n++ < retries) {
      return { status, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter }, body: Buffer.from("{}") };
    }
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  };
  await call(new Client({ transport, maxRetries: retries, sleep: async (ms) => void sleeps.push(ms) }));
  return sleeps;
}

test("P6: Retry-After 0 or a past date never makes a zero-delay burst", async () => {
  for (const value of ["0", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
    for (const [status, min] of [[429, MIN_429_MS], [503, MIN_503_MS]] as const) {
      const sleeps = await sleepsFor(status, value);
      assert.equal(sleeps.length, 3);
      assert.ok(sleeps.every((ms) => ms >= min), `${status} Retry-After ${value}: ${sleeps.join(", ")}`);
    }
  }
});

test("P6: a Retry-After longer than the backoff is honoured, a huge one capped", async () => {
  assert.deepEqual(await sleepsFor(503, "5", 1), [5000]);
  if (ABOVE_CAP === "wait-cap") {
    assert.deepEqual(await sleepsFor(503, "999999", 1), [RETRY_AFTER_CAP_MS]);
  } else {
    await assert.rejects(sleepsFor(503, "999999", 1), (e: unknown) => e instanceof Error && /999999 s/.test(e.message));
  }
});
