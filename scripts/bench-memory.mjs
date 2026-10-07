#!/usr/bin/env node
/**
 * Memory plateau benchmark — does create → ready → close retain anything?
 *
 *   node --expose-gc scripts/bench-memory.mjs [cycles=1500] [arc|fastify|both]
 *
 * Runs in a FRESH process against dist/ (what consumers load), with bare
 * Fastify as the baseline. Reports heapUsed / external / RSS at checkpoints
 * and the least-squares slope of heapUsed over the second half of the run —
 * a plateau is a slope indistinguishable from the baseline's, not "below a
 * generous cap". Exits 1 when arc's steady-state slope exceeds the baseline's
 * by more than SLOPE_MARGIN_KB per cycle.
 */

import Fastify from "fastify";

if (typeof globalThis.gc !== "function") {
  console.error("run with: node --expose-gc scripts/bench-memory.mjs");
  process.exit(2);
}

const CYCLES = Number(process.argv[2] ?? 1500);
const WHICH = process.argv[3] ?? "both";
const CHECKPOINTS = 10;
const SLOPE_MARGIN_KB = 2;

const { createApp, defineModule } = await import("../dist/factory/index.mjs");
const { defineResource, allowPublic } = await import("../dist/index.mjs");

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await new Promise((r) => setImmediate(r));
  }
};

const repo = {
  getAll: async () => ({ method: "offset", data: [], page: 1, limit: 20, total: 0, pages: 0 }),
  getById: async () => null,
  create: async (d) => d,
  update: async () => null,
  delete: async () => ({ success: true }),
};

async function arcCycle(i) {
  const app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    modules: [
      defineModule({ name: "base", bootstrap: () => ({ i }), onClose: () => {} }),
      defineModule({ name: "leaf", dependsOn: ["base"], bootstrap: () => ({ i }) }),
    ],
    resources: [
      defineResource({
        name: "item",
        adapter: { repository: repo, type: "custom" },
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      }),
    ],
  });
  await app.ready();
  await app.inject({ method: "GET", url: "/items" });
  await app.close();
}

async function fastifyCycle() {
  const app = Fastify({ logger: false });
  app.get("/items", async () => ({ data: [] }));
  await app.ready();
  await app.inject({ method: "GET", url: "/items" });
  await app.close();
}

function slopeKB(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den / 1024;
}

async function run(label, cycle) {
  for (let i = 0; i < 50; i++) await cycle(i); // JIT + lazy module caches
  await settle();
  const every = Math.max(1, Math.floor(CYCLES / CHECKPOINTS));
  const samples = [];
  const start = performance.now();
  for (let i = 1; i <= CYCLES; i++) {
    await cycle(i);
    if (i % every === 0) {
      await settle();
      const m = process.memoryUsage();
      samples.push({ x: i, y: m.heapUsed, ext: m.external, rss: m.rss });
    }
  }
  const ms = performance.now() - start;
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  const steady = samples.slice(Math.floor(samples.length / 2));
  const slope = slopeKB(steady.map((s) => ({ x: s.x, y: s.y })));
  console.log(
    `${label.padEnd(8)} ${(ms / CYCLES).toFixed(2)}ms/cycle  heap ${samples.map((s) => mb(s.y)).join(" ")} MB`,
  );
  console.log(
    `${"".padEnd(8)} external ${mb(samples.at(-1).ext)} MB  rss ${mb(samples.at(-1).rss)} MB  steady-state slope ${slope.toFixed(2)} KB/cycle`,
  );
  return slope;
}

const results = {};
if (WHICH !== "arc") results.fastify = await run("fastify", fastifyCycle);
if (WHICH !== "fastify") results.arc = await run("arc", arcCycle);

if (results.arc !== undefined && results.fastify !== undefined) {
  const excess = results.arc - results.fastify;
  console.log(`arc excess slope over bare fastify: ${excess.toFixed(2)} KB/cycle`);
  if (excess > SLOPE_MARGIN_KB) process.exit(1);
}
