/**
 * Arc CRUD Operations Benchmark
 *
 * Measures performance of basic CRUD operations with Arc + Mongoose.
 *
 * Run: npx tsx benchmarks/crud-operations.bench.ts
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/factory/createApp.js';
import { defineResource } from '../src/core/defineResource.js';
import { BaseController } from '../src/core/BaseController.js';
import { createMongooseAdapter } from '../src/adapters/mongoose.js';
import { allowPublic } from '../src/permissions/index.js';
import { Repository } from '@classytic/mongokit';
import type { FastifyInstance } from 'fastify';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  iterations: 1000,
  warmupIterations: 100,
  seedCount: 100,
};

// ============================================================================
// Setup
// ============================================================================

let app: FastifyInstance;
let mongoServer: MongoMemoryServer;

async function setup() {
  // Start MongoDB
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Create model
  const schema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      price: Number,
      isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
  );
  const BenchModel = mongoose.model('BenchProduct', schema);

  // Create repository and controller
  const repo = new Repository(BenchModel);
  const controller = new BaseController(repo);

  // Define resource
  const productResource = defineResource({
    name: 'product',
    adapter: createMongooseAdapter({ model: BenchModel, repository: repo }),
    controller,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });

  // Create app
  app = await createApp({
    preset: 'development',
    auth: { type: 'jwt', jwt: { secret: 'bench-secret-must-be-32-chars-long' } },
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(productResource.toPlugin());
    },
  });

  // Seed data
  console.log(`Seeding ${CONFIG.seedCount} products...`);
  for (let i = 0; i < CONFIG.seedCount; i++) {
    await BenchModel.create({ name: `Product ${i}`, price: Math.random() * 100 });
  }

  return app;
}

async function teardown() {
  await app?.close();
  await mongoose.disconnect();
  await mongoServer?.stop();
}

// ============================================================================
// Benchmark Utilities
// ============================================================================

interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
  p50Ms: number;
  p99Ms: number;
}

async function benchmark(
  name: string,
  fn: () => Promise<void>,
  iterations: number = CONFIG.iterations
): Promise<BenchResult> {
  const times: number[] = [];

  // Warmup
  console.log(`  Warming up ${name}...`);
  for (let i = 0; i < CONFIG.warmupIterations; i++) {
    await fn();
  }

  // Run benchmark
  console.log(`  Running ${name} (${iterations} iterations)...`);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  // Calculate stats
  times.sort((a, b) => a - b);
  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const p50Ms = times[Math.floor(iterations * 0.5)];
  const p99Ms = times[Math.floor(iterations * 0.99)];

  return {
    name,
    iterations,
    totalMs,
    avgMs,
    opsPerSec: Math.round(1000 / avgMs),
    p50Ms,
    p99Ms,
  };
}

function printResults(results: BenchResult[]) {
  console.log('\n' + '='.repeat(80));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(80));
  console.log(
    'Operation'.padEnd(25) +
      'Ops/sec'.padStart(12) +
      'Avg (ms)'.padStart(12) +
      'P50 (ms)'.padStart(12) +
      'P99 (ms)'.padStart(12)
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    console.log(
      r.name.padEnd(25) +
        r.opsPerSec.toLocaleString().padStart(12) +
        r.avgMs.toFixed(3).padStart(12) +
        r.p50Ms.toFixed(3).padStart(12) +
        r.p99Ms.toFixed(3).padStart(12)
    );
  }

  console.log('='.repeat(80));
}

// ============================================================================
// Benchmarks
// ============================================================================

async function runBenchmarks() {
  console.log('\nArc CRUD Operations Benchmark\n');

  await setup();
  const results: BenchResult[] = [];

  // Get existing product ID for single-item operations
  const listRes = await app.inject({ method: 'GET', url: '/products?limit=1' });
  const firstProduct = JSON.parse(listRes.payload).data[0];
  const productId = firstProduct._id;

  // LIST
  results.push(
    await benchmark('LIST (page 1, limit 20)', async () => {
      await app.inject({ method: 'GET', url: '/products?page=1&limit=20' });
    })
  );

  // GET by ID
  results.push(
    await benchmark('GET by ID', async () => {
      await app.inject({ method: 'GET', url: `/products/${productId}` });
    })
  );

  // CREATE
  let createCounter = 0;
  results.push(
    await benchmark('CREATE', async () => {
      await app.inject({
        method: 'POST',
        url: '/products',
        payload: { name: `Bench Product ${createCounter++}`, price: 99.99 },
      });
    })
  );

  // UPDATE
  results.push(
    await benchmark('UPDATE', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        payload: { price: Math.random() * 100 },
      });
    })
  );

  // LIST with filter
  results.push(
    await benchmark('LIST with filter', async () => {
      await app.inject({ method: 'GET', url: '/products?isActive=true&limit=20' });
    })
  );

  // LIST with sort
  results.push(
    await benchmark('LIST with sort', async () => {
      await app.inject({ method: 'GET', url: '/products?sort=-createdAt&limit=20' });
    })
  );

  printResults(results);

  await teardown();
  console.log('\nBenchmark complete.\n');
}

// Run
runBenchmarks().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
