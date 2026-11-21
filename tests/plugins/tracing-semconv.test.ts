/**
 * Tracing — optional packages load one by one (real SDK, mocked loader).
 *
 * `node:module`'s `createRequire` is wrapped so the plugin's loader resolves the REAL
 * api / sdk-trace / resources / semantic-conventions, a recording fake for
 * `instrumentation-http`, and MODULE_NOT_FOUND for the meta auto-instrumentations
 * package, `instrumentation-mongodb` and the OTLP exporter. Pinned: each missing optional
 * package is named once, the installed instrumentation still starts, and request spans
 * are still produced.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = vi.hoisted(() => [] as string[]);

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const MISSING = new Set([
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/instrumentation-mongodb",
    "@opentelemetry/exporter-trace-otlp-http",
  ]);
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url);
      return (id: string) => {
        if (MISSING.has(id)) {
          throw Object.assign(new Error(`Cannot find module '${id}'`), {
            code: "MODULE_NOT_FOUND",
          });
        }
        if (id === "@opentelemetry/instrumentation-http") {
          return {
            HttpInstrumentation: class {
              enable() {
                enabled.push("http");
              }
            },
          };
        }
        return real(id);
      };
    },
  };
});

const { default: tracingPlugin, isTracingAvailable } = await import("../../src/plugins/tracing.js");

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("tracing with optional packages missing", () => {
  let app: FastifyInstance | undefined;
  const logs: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    logs.length = 0;
    exporter.reset();
  });

  async function boot(): Promise<FastifyInstance> {
    app = Fastify({
      logger: { level: "debug", stream: { write: (line: string) => void logs.push(line) } },
    });
    await app.register(tracingPlugin, { serviceName: "t", sampleRate: 1 });
    app.get("/items/:id", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it("names each missing optional package once and keeps tracing", async () => {
    expect(isTracingAvailable()).toBe(true);
    const a = await boot();

    for (const pkg of [
      "@opentelemetry/instrumentation-mongodb",
      "@opentelemetry/auto-instrumentations-node",
      "@opentelemetry/exporter-trace-otlp-http",
    ]) {
      expect(logs.filter((l) => l.includes(pkg))).toHaveLength(1);
    }
    expect(enabled).toContain("http");
    expect(logs.some((l) => l.includes("Tracing disabled"))).toBe(false);

    await a.inject({ method: "GET", url: "/items/1?q=2" });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("GET /items/:id");
  });
});
