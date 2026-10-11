// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/reisewarnungen-client/internal/http";
import type { CliDeps } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/reisewarnungen-client/test/helpers";

export * from "@maschinenlesbar.org/reisewarnungen-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [reisewarnungen.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

// ---- CLI <-> library parity ---------------------------------------------------

/** What the CLI did with one input: exit code, captured output and requests. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, and requests. */
export type LibOutcome =
  | { ok: true; value: unknown; requests: HttpRequest[] }
  | { ok: false; error: unknown; requests: HttpRequest[] };

/**
 * Send one input through the CLI (`run(argv)` with the real client factory, on the
 * mock transport) and through a library call (`call(transport)`, e.g.
 * `(t) => new ReisewarnungenClient({ transport: t }).summaries()`), both on ONE
 * recording mock transport. Returns both outcomes with the requests each side made,
 * so a test can assert the same outcome: both reject with no request, or both send
 * the identical request. A synchronous throw from the library call (constructor
 * validation) is captured like a rejection. Files the CLI writes stay in memory.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse({}),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {},
    },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cliRequests = mt.calls.slice();
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliRequests };

  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(cliRequests.length) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(cliRequests.length) };
  }
  return { cli, lib };
}
