import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: [
    // Core
    'src/index.ts',
    'src/core/index.ts',
    'src/types/index.ts',
    'src/adapters/index.ts',
    'src/permissions/index.ts',
    'src/presets/index.ts',
    'src/presets/multiTenant.ts',

    // Auth & Org
    'src/auth/index.ts',
    'src/org/index.ts',
    'src/org/types.ts',

    // Hooks, Registry, Utils
    'src/hooks/index.ts',
    'src/registry/index.ts',
    'src/utils/index.ts',

    // Factory
    'src/factory/index.ts',

    // Auth — dedicated Redis session store subpath
    'src/auth/redis-session.ts',

    // Plugins — barrel + dedicated heavy-dep subpaths
    'src/plugins/index.ts',
    'src/plugins/tracing-entry.ts',
    'src/plugins/response-cache.ts',

    // Events — barrel (memory-only) + dedicated transport subpaths
    'src/events/index.ts',
    'src/events/transports/redis.ts',
    'src/events/transports/redis-stream-entry.ts',

    // Audit — barrel (memory-only) + dedicated MongoDB subpath
    'src/audit/index.ts',
    'src/audit/mongodb.ts',

    // Idempotency — barrel (memory-only) + dedicated Redis/MongoDB subpaths
    'src/idempotency/index.ts',
    'src/idempotency/redis.ts',
    'src/idempotency/mongodb.ts',

    // Docs
    'src/docs/index.ts',

    // Testing
    'src/testing/index.ts',

    // Policies
    'src/policies/index.ts',

    // Schemas (TypeBox)
    'src/schemas/index.ts',

    // Migrations
    'src/migrations/index.ts',

    // CLI
    'src/cli/index.ts',
    'src/cli/commands/describe.ts',
    'src/cli/commands/docs.ts',
    'src/cli/commands/generate.ts',
    'src/cli/commands/introspect.ts',
    'src/cli/commands/init.ts',

    // Integrations — each is opt-in, separate entry point
    'src/integrations/index.ts',
    'src/integrations/streamline.ts',
    'src/integrations/websocket.ts',
    'src/integrations/jobs.ts',

    // Discovery — auto-discovery plugin
    'src/discovery/index.ts',
  ],
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'node20',
  outDir: 'dist',
  define: {
    __ARC_VERSION__: JSON.stringify(version),
  },
  external: [
    // Core
    'fastify',
    'fastify-plugin',

    // Database
    'mongoose',
    '@classytic/mongokit',

    // Fastify plugins (all optional peer deps)
    '@fastify/jwt',
    '@fastify/cors',
    '@fastify/helmet',
    '@fastify/rate-limit',
    '@fastify/compress',
    '@fastify/type-provider-typebox',
    '@fastify/under-pressure',
    '@fastify/sensible',
    '@fastify/multipart',
    '@fastify/websocket',
    'fastify-raw-body',

    // Schema
    '@sinclair/typebox',

    // Auth
    'better-auth',

    // Redis
    'ioredis',

    // Observability
    '@opentelemetry/api',
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-mongodb',
    '@opentelemetry/auto-instrumentations-node',
    'pino-pretty',

    // Job queue
    'bullmq',

    // Workflow
    '@classytic/streamline',

    // Testing (dev only)
    'vitest',
    'mongodb-memory-server',
    'mongodb-memory-server-core',

    // Serverless
    '@fastify/aws-lambda',
  ],
});
