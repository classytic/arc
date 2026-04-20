import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.ts"],

  tsdown: {
    config: ["tsdown.config.ts"],
  },

  vitest: {
    config: ["vitest.config.ts"],
    entry: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
  },

  // Optional peer deps — conditionally required at runtime, not statically imported
  ignoreDependencies: [
    "pino-pretty",
    "@classytic/streamline",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-mongodb",
    "@opentelemetry/auto-instrumentations-node",
  ],

  // Files whose exports are consumed by downstream apps / kit authors,
  // OR type-only CI-gate fixtures that intentionally have no importer.
  ignore: [
    "src/adapters/types.ts",
    // Type-level compatibility gate — verified by `tsc --noEmit`, not bundled to dist.
    "src/adapters/repo-core-compat.ts",
  ],

  // Public API exports for downstream consumers, not used in src/ itself
  ignoreExportsUsedInFile: true,
};

export default config;
