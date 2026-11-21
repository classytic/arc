/**
 * Tracing — a host that imports the subpath without the core OpenTelemetry packages gets
 * a no-op plugin and one warning naming them, never an import-time crash.
 */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: () => (id: string) => {
      throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
    },
  };
});

const {
  default: tracingPlugin,
  isTracingAvailable,
  createSpan,
} = await import("../../src/plugins/tracing.js");

describe("tracing without the core packages", () => {
  it("is a no-op that names the missing core packages", async () => {
    expect(isTracingAvailable()).toBe(false);
    const logs: string[] = [];
    const app = Fastify({
      logger: { level: "warn", stream: { write: (line: string) => void logs.push(line) } },
    });
    await app.register(tracingPlugin);
    let seen: unknown = "unset";
    app.get("/t", async (req) => {
      seen = req.tracer;
      return createSpan(req, "x", async (span) => ({ span }));
    });
    const res = await app.inject({ method: "GET", url: "/t" });
    expect(res.json()).toEqual({ span: null });
    expect(seen).toBeUndefined();
    const disabled = logs.find((l) => l.includes("Tracing disabled"));
    for (const pkg of ["api", "sdk-trace", "resources", "semantic-conventions"]) {
      expect(disabled).toContain(`@opentelemetry/${pkg}`);
    }
    await app.close();
  });
});
