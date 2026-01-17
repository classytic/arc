import { defineConfig } from 'tsup';

const isProduction = process.env.NODE_ENV === 'production';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'permissions/index': 'src/permissions/index.ts',
    'types/index': 'src/types/index.ts',
    'adapters/index': 'src/adapters/index.ts',
    'presets/index': 'src/presets/index.ts',
    'presets/multiTenant': 'src/presets/multiTenant.ts',
    'auth/index': 'src/auth/index.ts',
    'org/index': 'src/org/index.ts',
    'hooks/index': 'src/hooks/index.ts',
    'registry/index': 'src/registry/index.ts',
    'utils/index': 'src/utils/index.ts',
    'cli/index': 'src/cli/index.ts',
    'cli/commands/docs': 'src/cli/commands/docs.ts',
    'cli/commands/introspect': 'src/cli/commands/introspect.ts',
    'plugins/index': 'src/plugins/index.ts',
    'audit/index': 'src/audit/index.ts',
    'docs/index': 'src/docs/index.ts',
    'idempotency/index': 'src/idempotency/index.ts',
    'events/index': 'src/events/index.ts',
    'testing/index': 'src/testing/index.ts',
    'policies/index': 'src/policies/index.ts',
    'factory/index': 'src/factory/index.ts',
    'migrations/index': 'src/migrations/index.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false, // Single chunks - better for Node.js libraries
  sourcemap: false, // No sourcemaps in published package (users debug dist, not src)
  clean: true,
  treeshake: true, // Aggressive tree-shaking
  bundle: true, // Bundle dependencies for optimal tree-shaking
  minify: isProduction, // Minify in production builds
  target: 'node20',
  outDir: 'dist',
  shims: false, // Node 20+ has native ESM, no shims needed
  external: [
    'fastify',
    'mongoose',
    '@classytic/mongokit',
    '@fastify/jwt',
    '@fastify/cors',
    '@fastify/helmet',
    '@fastify/rate-limit',
    '@fastify/compress',
    '@fastify/under-pressure',
    '@fastify/sensible',
    '@fastify/multipart',
    'fastify-raw-body',
    'vitest',
  ],
  esbuildOptions(options) {
    options.platform = 'node';
    options.treeShaking = true; // Explicit tree-shaking for esbuild
    options.charset = 'utf8'; // Smaller output
  },
});
