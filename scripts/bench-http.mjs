#!/usr/bin/env node
/**
 * HTTP overhead benchmark — what arc's pipeline costs per request on top of
 * Fastify, over real sockets, with the SAME in-memory data behind both.
 *
 *   node --expose-gc scripts/bench-http.mjs [seconds=5] [connections=50] [rounds=3]
 *
 * Both servers answer `GET /items?limit=20` with the same 20 rows. The bare
 * route is the floor (routing + serialization); the arc route adds query
 * parsing, the permission chain, scope, the controller and the list envelope.
 * Also reports heap before/after the arc run — sustained load must not
 * ratchet memory. No third-party load generator: Node's own keep-alive agent.
 */

import http from "node:http";
import Fastify from "fastify";

const SECONDS = Number(process.argv[2] ?? 5);
const CONNECTIONS = Number(process.argv[3] ?? 50);

const { createApp } = await import("../dist/factory/index.mjs");
const { defineResource, allowPublic } = await import("../dist/index.mjs");

const rows = Array.from({ length: 20 }, (_, i) => ({
  _id: `id-${i}`,
  name: `item ${i}`,
  price: i * 10,
  tags: ["a", "b"],
}));

const repo = {
  getAll: async () => ({ method: "offset", data: rows, page: 1, limit: 20, total: 20, pages: 1 }),
  getById: async (id) => rows.find((r) => r._id === id) ?? null,
  create: async (d) => d,
  update: async () => null,
  delete: async () => ({ success: true }),
};

async function bareFastify() {
  const app = Fastify({ logger: false });
  app.get("/items", async () => ({ method: "offset", data: rows, page: 1, limit: 20, total: 20 }));
  return app;
}

async function arcApp() {
  return createApp({
    preset: "testing",
    auth: false,
    logger: false,
    resources: [
      defineResource({
        name: "item",
        adapter: { repository: repo, type: "custom" },
        permissions: { list: allowPublic(), get: allowPublic() },
        disabledRoutes: ["create", "update", "delete"],
      }),
    ],
  });
}

async function load(port, path) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS });
  const deadline = performance.now() + SECONDS * 1000;
  const latencies = [];
  let errors = 0;
  const once = () =>
    new Promise((resolve) => {
      const t = performance.now();
      http
        .get({ host: "127.0.0.1", port, path, agent }, (res) => {
          if (res.statusCode !== 200) errors++;
          res.resume();
          res.on("end", () => {
            latencies.push(performance.now() - t);
            resolve();
          });
        })
        .on("error", () => {
          errors++;
          resolve();
        });
    });
  const worker = async () => {
    while (performance.now() < deadline) await once();
  };
  await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  agent.destroy();
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.floor(latencies.length * p)]?.toFixed(2);
  return { rps: Math.round(latencies.length / SECONDS), p50: pct(0.5), p99: pct(0.99), errors };
}

// Targets run INTERLEAVED over several rounds and each reports its median, so
// a noisy neighbour (a build, a test run) skews every target alike instead of
// whichever happened to run during it.
const ROUNDS = Number(process.argv[4] ?? 3);
const targets = [
  { label: "fastify (floor)", build: bareFastify, path: "/items?limit=20" },
  { label: "arc list", build: arcApp, path: "/items?limit=20" },
  { label: "arc get", build: arcApp, path: "/items/id-7" },
];
const mb = (b) => (b / 1024 / 1024).toFixed(1);
for (const t of targets) {
  t.app = await t.build();
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  t.port = t.app.server.address().port;
  await load(t.port, t.path); // warm-up
  t.runs = [];
  globalThis.gc?.();
  t.heapBefore = process.memoryUsage().heapUsed;
}
for (let round = 0; round < ROUNDS; round++) {
  for (const t of targets) t.runs.push(await load(t.port, t.path));
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const t of targets) {
  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  await t.app.close();
  t.rps = median(t.runs.map((r) => r.rps));
  const errors = t.runs.reduce((s, r) => s + r.errors, 0);
  console.log(
    `${t.label.padEnd(16)} ${String(t.rps).padStart(7)} req/s  p50 ${median(t.runs.map((r) => Number(r.p50)))}ms  p99 ${median(t.runs.map((r) => Number(r.p99)))}ms  errors ${errors}  heap ${mb(t.heapBefore)}→${mb(heapAfter)} MB`,
  );
}
const [floor, list, get] = targets;
console.log(
  `vs bare fastify: arc list ${((list.rps / floor.rps) * 100).toFixed(0)}%, arc get ${((get.rps / floor.rps) * 100).toFixed(0)}%`,
);
