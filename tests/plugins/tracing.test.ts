/**
 * Tracing Plugin Tests — registration and the no-tracer paths, with the real SDK installed.
 *
 * - isTracingAvailable() reports the core packages (installed as devDependencies)
 * - the plugin registers its own provider when the host has none, and flushes it on close
 * - createSpan / traced run the wrapped function unchanged when a request has no tracer
 *   (sampled out, or tracing never registered)
 *
 * The "package missing" paths are covered by tracing-semconv.test.ts (mocked loader);
 * span content by tracing-otel.test.ts.
 */

import { context, propagation, trace } from "@opentelemetry/api";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import tracingPlugin, {
  createSpan,
  isTracingAvailable,
  traced,
} from "../../src/plugins/tracing.js";

function descriptorOf(target: object, key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) throw new Error(`no descriptor for ${key}`);
  return descriptor;
}

afterAll(() => {
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("isTracingAvailable", () => {
  it("is true when api, sdk-trace, resources and semantic-conventions load", () => {
    expect(isTracingAvailable()).toBe(true);
  });
});

describe("tracingPlugin — registration", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("registers with all options and closes cleanly", async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin, {
      serviceName: "full-options-test",
      serviceVersion: "1.2.3",
      exporterUrl: "http://127.0.0.1:4318/v1/traces",
      autoInstrumentation: false,
      sampleRate: 0.5,
    });
    await app.ready();
    expect(app.hasRequestDecorator("tracer")).toBe(true);
  });

  it("sampleRate 0 leaves request.tracer unset", async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin, { sampleRate: 0, autoInstrumentation: false });

    let tracerValue: unknown = "NOT_CHECKED";
    app.get("/test", async (request) => {
      tracerValue = request.tracer;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(tracerValue).toBeUndefined();
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
    const descriptor = descriptorOf(TestRepo.prototype, "findActive");
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

    const descriptor = descriptorOf(TestRepo.prototype, "findById");
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

    const descriptor = descriptorOf(TestRepo.prototype, "failingMethod");
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

    const descriptor = descriptorOf(TestRepo.prototype, "search");
    traced()(TestRepo.prototype, "search", descriptor);
    Object.defineProperty(TestRepo.prototype, "search", descriptor);

    const repo = new TestRepo();
    const result = await repo.search("test", 10);
    expect(result).toEqual({ query: "test", limit: 10, results: [] });
  });
});
