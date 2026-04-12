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
    "bullmq",
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

  // Files whose exports are consumed by downstream apps / kit authors
  ignore: ["src/adapters/types.ts"],

  // Public API exports for downstream consumers, not used in src/ itself
  ignoreExportsUsedInFile: true,
};

export default config;
