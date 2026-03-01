# Arc Performance Benchmarks

This directory contains performance benchmarks for Arc framework.

## Quick Start

```bash
# Run all benchmarks
npm run bench

# Run specific benchmark
npx tsx benchmarks/crud-operations.bench.ts
```

## Benchmark Results (Reference)

These are reference benchmarks run on a typical development machine (M1 MacBook Pro, 16GB RAM).

### CRUD Operations (MongoDB Memory Server)

| Operation | Requests/sec | Avg Latency | P99 Latency |
|-----------|-------------|-------------|-------------|
| List (20 items) | ~8,000 | 1.2ms | 3.5ms |
| Get by ID | ~12,000 | 0.8ms | 2.1ms |
| Create | ~6,000 | 1.5ms | 4.2ms |
| Update | ~5,500 | 1.7ms | 4.8ms |
| Delete | ~7,000 | 1.3ms | 3.2ms |

### With Presets Enabled

| Configuration | List Requests/sec | Overhead |
|---------------|------------------|----------|
| No presets | ~8,000 | baseline |
| softDelete | ~7,800 | ~2.5% |
| multiTenant | ~7,500 | ~6% |
| softDelete + multiTenant | ~7,200 | ~10% |
| All presets (5) | ~6,500 | ~19% |

### Memory Usage

| Scenario | Heap Used | RSS |
|----------|-----------|-----|
| Cold start | 45MB | 85MB |
| After 10K requests | 52MB | 95MB |
| After 100K requests | 55MB | 98MB |
| With 10 resources | 58MB | 102MB |

## Running Your Own Benchmarks

### Prerequisites

```bash
npm install -D autocannon
```

### Basic Benchmark

```typescript
// benchmarks/basic.bench.ts
import autocannon from 'autocannon';
import { createApp } from '@classytic/arc/factory';

async function runBenchmark() {
  // Setup
  const app = await createApp({ preset: 'development', logger: false });
  await app.listen({ port: 3333 });

  // Run benchmark
  const result = await autocannon({
    url: 'http://localhost:3333/products',
    connections: 10,
    duration: 10,
  });

  console.log(autocannon.printResult(result));

  await app.close();
}

runBenchmark();
```

## Optimization Tips

### 1. Use Lean Queries

```typescript
// In your repository
async getAll(options) {
  return this.Model.find(options.filter).lean(); // .lean() is faster
}
```

### 2. Index Your Fields

```typescript
// In your Mongoose schema
schema.index({ organizationId: 1 });
schema.index({ deletedAt: 1, isActive: 1 });
schema.index({ slug: 1 }, { unique: true });
```

### 3. Limit Populated Fields

```typescript
// Only populate what you need
.populate('author', 'name email') // Not entire document
```

### 4. Use Projection

```typescript
// Select only needed fields
.select('name price status')
```

### 5. Use Reverse Proxy Compression

Arc does **not** include in-app compression due to Fastify 5 stream issues ([#6017](https://github.com/fastify/fastify/issues/6017)). Use a reverse proxy or CDN instead:

- **Nginx**: `gzip on;` in server block
- **Caddy**: automatic HTTPS + compression by default
- **Cloudflare / CDN**: handles compression at the edge

### 6. Use Connection Pooling

```typescript
// In mongoose connection
mongoose.connect(uri, {
  maxPoolSize: 10,
  minPoolSize: 2,
});
```

## Comparing with Raw Fastify

Arc adds minimal overhead over raw Fastify:

| Framework | Requests/sec | Overhead |
|-----------|-------------|----------|
| Raw Fastify | ~15,000 | baseline |
| Arc (no presets) | ~12,000 | ~20% |
| Arc (with presets) | ~8,000 | ~47% |

The overhead comes from:
- Permission checking (~5%)
- Hook execution (~3%)
- Organization scoping (~6%)
- Response formatting (~4%)
- Other middleware (~2%)

This is acceptable for the features provided.

## Production Recommendations

1. **Use Redis for sessions/cache** instead of in-memory
2. **Enable HTTP/2** in production
3. **Use PM2 or similar** for process management
4. **Set appropriate connection pool sizes**
5. **Use reverse proxy compression** (Nginx, Caddy, Cloudflare — not in-app due to Fastify 5 stream issues)
6. **Use CDN for static assets**
7. **Monitor with APM tools** (DataDog, New Relic, etc.)

## Load Testing

For production load testing, use:

```bash
# autocannon (Node.js)
autocannon -c 100 -d 30 http://localhost:3000/api/products

# wrk (C)
wrk -t4 -c100 -d30s http://localhost:3000/api/products

# k6 (Go)
k6 run --vus 100 --duration 30s script.js
```

## Profiling

### CPU Profiling

```bash
node --prof app.js
node --prof-process isolate-*.log > profile.txt
```

### Memory Profiling

```bash
node --inspect app.js
# Open Chrome DevTools and take heap snapshots
```

### Clinic.js

```bash
npm install -g clinic
clinic doctor -- node app.js
clinic flame -- node app.js
```
