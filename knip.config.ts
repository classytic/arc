import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.ts"],

  // tsdown auto-detects entries from tsdown.config.ts
  tsdown: {
    config: ["tsdown.config.ts"],
  },

  vitest: {
    config: ["vitest.config.ts"],
    entry: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
  },

  // Optional peer deps — conditionally required at runtime, not statically imported
  ignoreDependencies: [
    "mongoose",
    "bullmq",
    "@fastify/cors",
    "@fastify/helmet",
    "@fastify/rate-limit",
    "@fastify/under-pressure",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-mongodb",
    "@opentelemetry/auto-instrumentations-node",
    "tsx",
    "mongodb-memory-server",
  ],

};

export default config;
