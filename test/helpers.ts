// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import type { CliDeps } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

/** A 3xx redirect response pointing at `location`. */
export function redirectResponse(location: string, status = 302): HttpResponse {
  return {
    status,
    headers: { location },
    body: Buffer.alloc(0),
  };
}

/** A 3xx redirect response with no Location header (malformed). */
export function redirectWithoutLocation(status = 302): HttpResponse {
  return {
    status,
    headers: {},
    body: Buffer.alloc(0),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
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
  const cli: CliOutcome = { code, out: out.join("\n"), err: err.join("\n"), requests: cliRequests };

  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(cliRequests.length) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(cliRequests.length) };
  }
  return { cli, lib };
}
