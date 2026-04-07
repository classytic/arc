/**
 * Tracing Plugin Tests
 *
 * Tests the OpenTelemetry tracing plugin behavior:
 * - No-op when OTel packages not installed (graceful degradation)
 * - createSpan utility (no-op without tracing, executes fn)
 * - traced decorator (no-op without tracing context)
 * - isTracingAvailable() reports correct state
 *
 * Note: We do NOT install @opentelemetry/* in test deps (they're optional peer deps).
 * Tests verify the graceful degradation path — the "OTel not available" codepath
 * that ALL users hit unless they explicitly install OTel packages.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import tracingPlugin, {
  createSpan,
  isTracingAvailable,
  traced,
} from "../../src/plugins/tracing.js";

// ============================================================================
// isTracingAvailable — reports OTel availability
// ============================================================================

describe("isTracingAvailable", () => {
  it("should return false when @opentelemetry packages are not installed", () => {
    // In test environment, OTel is not installed (optional peer dep)
    expect(isTracingAvailable()).toBe(false);
  });
});

// ============================================================================
// tracingPlugin — graceful no-op when OTel not installed
// ============================================================================

describe("tracingPlugin — no-op mode", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should register successfully without OTel packages", async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin, {
      serviceName: "test-service",
      exporterUrl: "http://localhost:4318/v1/traces",
    });
    await app.ready();

    // Plugin registered without error
    expect(app).toBeDefined();
  });

  it("should not decorate request.tracer when OTel not available", async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin);

    let tracerValue: unknown = "NOT_CHECKED";
    app.get("/test", async (request) => {
      tracerValue = (request as any).tracer;
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    // tracer should not be set (plugin is no-op)
    expect(tracerValue).toBeUndefined();
  });

  it("should handle all tracing options without error", async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin, {
      serviceName: "full-options-test",
      exporterUrl: "http://otel-collector:4318/v1/traces",
      autoInstrumentation: true,
      sampleRate: 0.5,
    });
    await app.ready();

    expect(app).toBeDefined();
  });

  it("should handle zero sample rate", async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin, {
      sampleRate: 0.0,
    });
    await app.ready();

    expect(app).toBeDefined();
  });
});

// ============================================================================
// createSpan — utility for custom spans
// ============================================================================

describe("createSpan — no-op mode", () => {
  it("should execute the function even without tracing", async () => {
    const mockRequest = {} as any; // No tracer property

    const result = await createSpan(mockRequest, "test-span", async (span) => {
      // span is null when tracing is not available
      expect(span).toBeNull();
      return "computed-value";
    });

    expect(result).toBe("computed-value");
  });

  it("should propagate errors from the wrapped function", async () => {
    const mockRequest = {} as any;

    await expect(
      createSpan(mockRequest, "failing-span", async () => {
        throw new Error("computation failed");
      }),
    ).rejects.toThrow("computation failed");
  });

  it("should pass attributes parameter without error", async () => {
    const mockRequest = {} as any;

    const result = await createSpan(mockRequest, "attributed-span", async () => "done", {
      "custom.key": "value",
      "db.operation": "findOne",
    });

    expect(result).toBe("done");
  });

  it("should handle async operations correctly", async () => {
    const mockRequest = {} as any;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const result = await createSpan(mockRequest, "async-span", async () => {
      await delay(10);
      return 42;
    });

    expect(result).toBe(42);
  });
});

// ============================================================================
// traced — decorator for repository methods
// ============================================================================

describe("traced decorator — no-op mode (applied manually)", () => {
  // The `traced()` decorator uses legacy PropertyDescriptor syntax.
  // Apply it manually to avoid TC39 decorator compat issues in TS 6.

  it("should execute the original method when no tracing context", async () => {
    class TestRepo {
      async findActive() {
        return [{ id: "1", active: true }];
      }
    }

    // Apply decorator manually
    const descriptor = Object.getOwnPropertyDescriptor(TestRepo.prototype, "findActive")!;
    traced()(TestRepo.prototype, "findActive", descriptor);
    Object.defineProperty(TestRepo.prototype, "findActive", descriptor);

    const repo = new TestRepo();
    const result = await repo.findActive();
    expect(result).toEqual([{ id: "1", active: true }]);
  });

  it("should execute with custom span name", async () => {
    class TestRepo {
      async findById(id: string) {
        return { id, name: "Test" };
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(TestRepo.prototype, "findById")!;
    traced("custom.findById")(TestRepo.prototype, "findById", descriptor);
    Object.defineProperty(TestRepo.prototype, "findById", descriptor);

    const repo = new TestRepo();
    const result = await repo.findById("123");
    expect(result).toEqual({ id: "123", name: "Test" });
  });

  it("should propagate errors from decorated methods", async () => {
    class TestRepo {
      async failingMethod() {
        throw new Error("DB connection lost");
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(TestRepo.prototype, "failingMethod")!;
    traced()(TestRepo.prototype, "failingMethod", descriptor);
    Object.defineProperty(TestRepo.prototype, "failingMethod", descriptor);

    const repo = new TestRepo();
    await expect(repo.failingMethod()).rejects.toThrow("DB connection lost");
  });

  it("should pass arguments through correctly", async () => {
    class TestRepo {
      async search(query: string, limit: number) {
        return { query, limit, results: [] };
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(TestRepo.prototype, "search")!;
    traced()(TestRepo.prototype, "search", descriptor);
    Object.defineProperty(TestRepo.prototype, "search", descriptor);

    const repo = new TestRepo();
    const result = await repo.search("test", 10);
    expect(result).toEqual({ query: "test", limit: 10, results: [] });
  });
});
