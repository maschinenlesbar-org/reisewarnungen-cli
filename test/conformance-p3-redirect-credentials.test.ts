// Conformance test P3 (fix plan 2026-10-06): the base URL's credentials go to its own origin
// only, on every hop. A same-origin redirect keeps them (relative or absolute Location), a
// redirect to another origin drops them (and so do credentials a server writes into its
// Location), a transport that followed a redirect to another origin itself is rejected, and a
// 401/403 after an http→https redirect says the redirect dropped them. Written in
// reisewarnungen-cli (the first redirect-following repo to get P3); shared across the repos
// that follow redirects; only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { ReisewarnungenClient as Client } from "../src/client/client.js";
import { ReiseApiError as ApiError, ReiseNetworkError as NetworkError } from "../src/client/errors.js";
/** One call that makes a single GET and needs no arguments. */
const call = (client: Client): Promise<unknown> => client.summaries();
/** The path that call requests, below the base URL. */
const CALL_PATH = "/opendata/travelwarning";
/** A 2xx body the call accepts. */
const okBody = { response: { lastModified: 1, contentList: ["1"], "1": { countryName: "Atlantis", warning: false, partialWarning: false } } };
// --------------------------------------------------------------------------------------

const BASIC = `Basic ${Buffer.from("alice:s3cret-pw").toString("base64")}`;

interface Seen { port: number; path: string; authorization: string | undefined }

/** Two local servers: A redirects by path prefix, B (and A's /ok) answer okBody. */
async function servers(): Promise<{ a: number; b: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const ports: number[] = [];
  const make = (index: number) =>
    http.createServer((req, res) => {
      const path = req.url ?? "/";
      seen.push({ port: ports[index]!, path, authorization: req.headers.authorization });
      const to = (where: string) => {
        res.writeHead(302, { location: where });
        res.end();
      };
      if (path.startsWith("/cross/")) return to(`http://127.0.0.1:${ports[1]}/ok${CALL_PATH}`);
      if (path.startsWith("/crosscreds/")) return to(`http://mallory:stolen@127.0.0.1:${ports[1]}/ok${CALL_PATH}`);
      if (path.startsWith("/sameabs/")) return to(`http://127.0.0.1:${ports[0]}/ok${CALL_PATH}`);
      if (path.startsWith("/samerel/")) return to(`/ok${CALL_PATH}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(okBody));
    });
  const list = [make(0), make(1)];
  for (const server of list) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    ports.push((server.address() as AddressInfo).port);
  }
  return { a: ports[0]!, b: ports[1]!, seen, close: () => list.forEach((s) => s.close()) };
}

test("P3: a redirect to another origin never carries the base URL's credentials", async () => {
  const s = await servers();
  try {
    for (const prefix of ["cross", "crosscreds"]) {
      s.seen.length = 0;
      await call(new Client({ baseUrl: `http://alice:s3cret-pw@127.0.0.1:${s.a}/${prefix}` }));
      const atB = s.seen.filter((x) => x.port === s.b);
      assert.equal(atB.length, 1, prefix);
      assert.equal(atB[0]!.authorization, undefined, `${prefix}: B got ${atB[0]!.authorization}`);
      // A got them on the first hop.
      assert.equal(s.seen.find((x) => x.port === s.a)?.authorization, BASIC);
    }
  } finally {
    s.close();
  }
});

test("P3: a same-origin redirect keeps the credentials, relative or absolute", async () => {
  const s = await servers();
  try {
    for (const prefix of ["samerel", "sameabs"]) {
      s.seen.length = 0;
      await call(new Client({ baseUrl: `http://alice:s3cret-pw@127.0.0.1:${s.a}/${prefix}` }));
      assert.equal(s.seen.length, 2, prefix);
      for (const hop of s.seen) assert.equal(hop.authorization, BASIC, `${prefix} ${hop.path}`);
    }
  } finally {
    s.close();
  }
});

test("P3: a transport never sees userinfo in a URL and is told not to follow redirects", async () => {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  };
  await call(new Client({ baseUrl: "https://alice:s3cret-pw@mirror.example", transport }));
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0]!.url, /s3cret|alice/);
  assert.equal(requests[0]!.headers?.["Authorization"], BASIC);
  assert.equal(requests[0]!.redirect, "manual");
});

test("P3: a transport that followed a redirect to another origin is rejected", async () => {
  const transport = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
    url: "https://elsewhere.example/x",
  });
  await assert.rejects(call(new Client({ baseUrl: "https://mirror.example", transport })), NetworkError);
  // The same origin (another path) is fine.
  const same = async (): Promise<HttpResponse> => ({ ...(await transport()), url: `https://mirror.example${CALL_PATH}` });
  await assert.doesNotReject(call(new Client({ baseUrl: "https://mirror.example", transport: same })));
});

test("P3: a 401 after an http→https redirect says the redirect dropped the credentials", async () => {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    if (req.url.startsWith("http:")) {
      return { status: 301, headers: { location: req.url.replace("http:", "https:") }, body: Buffer.alloc(0) };
    }
    return { status: 401, headers: {}, body: Buffer.from("{}") };
  };
  await assert.rejects(
    call(new Client({ baseUrl: "http://alice:s3cret-pw@mirror.example", transport, maxRetries: 0 })),
    (e: unknown) => e instanceof ApiError && /https base URL/.test(e.message) && !e.message.includes("s3cret"),
  );
  assert.equal(requests[1]!.headers?.["Authorization"], undefined);
});
