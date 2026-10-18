#!/usr/bin/env node
/**
 * SSE delivery micro-benchmark — filter-all vs keyed `audience` routing.
 *
 *   npm run build && node scripts/bench-sse-audience.mjs [connections=1000] [events=2000]
 *
 * Opens N real SSE connections (one user each) against dist/, publishes events
 * addressed to 2 participants, and reports publish time per event and filter
 * calls. Informational only — never a gate.
 */

import http from "node:http";
import Fastify from "fastify";

const CONNECTIONS = Number(process.argv[2] ?? 1000);
const EVENTS = Number(process.argv[3] ?? 2000);

const { eventPlugin } = await import("../dist/events/index.mjs");
const { ssePlugin } = await import("../dist/plugins/index.mjs");

async function run(mode) {
  let filterCalls = 0;
  const filter = (event, request) => {
    filterCalls++;
    const ids = event.payload?.participantIds;
    return Array.isArray(ids) && ids.includes(request.headers["x-user"]);
  };
  const app = Fastify({ logger: false });
  await app.register(eventPlugin, { singleProcess: true });
  app.addHook("onRequest", async (request) => {
    request.scope = { kind: "authenticated", userId: request.headers["x-user"] };
  });
  await app.register(ssePlugin, {
    requireAuth: false,
    heartbeat: 600_000,
    filter,
    ...(mode === "audience" ? { audience: (e) => e.payload.participantIds } : {}),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();

  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  let received = 0;
  const reqs = [];
  // Connect in batches: a burst of 1,000 overflows the listen backlog on Windows.
  for (let i = 0; i < CONNECTIONS; i++) {
    if (i % 100 === 0) {
      while (app.sseStats().connections < i) await new Promise((r) => setTimeout(r, 10));
    }
    const req = http.get(
      { host: "127.0.0.1", port, path: "/events/stream", agent, headers: { "x-user": `u${i}` } },
      (res) =>
        res.on("data", (c) => {
          received += c.toString().split("event: comms.").length - 1;
        }),
    );
    req.on("error", () => {});
    reqs.push(req);
  }
  while (app.sseStats().connections < CONNECTIONS) await new Promise((r) => setTimeout(r, 20));

  const expected = EVENTS * 2;
  filterCalls = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < EVENTS; i++) {
    const a = `u${i % CONNECTIONS}`;
    const b = `u${(i * 7 + 1) % CONNECTIONS}`;
    await app.events.publish("comms.message.sent", { participantIds: [a, b], seq: i });
  }
  const publishMs = Number(process.hrtime.bigint() - start) / 1e6;
  const deadline = Date.now() + 30_000;
  while (received < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

  for (const r of reqs) r.destroy();
  agent.destroy();
  await app.close();
  return { mode, publishMs, usPerEvent: (publishMs * 1000) / EVENTS, filterCalls, received, expected };
}

const results = [];
for (const mode of ["filter-all", "audience", "filter-all", "audience"]) results.push(await run(mode));
const last = results.slice(2);
console.table(
  last.map((r) => ({
    mode: r.mode,
    connections: CONNECTIONS,
    events: EVENTS,
    "publish ms": r.publishMs.toFixed(1),
    "µs/event": r.usPerEvent.toFixed(1),
    "filter calls": r.filterCalls,
    delivered: `${r.received}/${r.expected}`,
  })),
);
console.log(`speedup: ${(last[0].publishMs / last[1].publishMs).toFixed(1)}x (warm run)`);
