/**
 * Refusals that know when to come back say so.
 *
 * Two errors carried a retry hint and neither reached the wire:
 *   - `RateLimitError.retryAfter` was stored in `details` and never became a
 *     `Retry-After` header, so clients retried on their own schedule;
 *   - `CircuitBreakerError` extended plain `Error`, so an open circuit was
 *     classified `arc.internal_error` — a 500, logged at error level with a
 *     stack, once per fast-failed call. A breaker exists to make refusal CHEAP;
 *     it had made it the loudest failure in the logs.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";
import { CircuitBreaker, CircuitBreakerError, CircuitState } from "../../src/utils/circuitBreaker.js";
import { ArcError, RateLimitError } from "../../src/utils/errors.js";

let app: FastifyInstance;
const logs: Array<{ level: number; msg?: string }> = [];

async function appThrowing(error: () => unknown): Promise<FastifyInstance> {
  logs.length = 0;
  app = Fastify({
    logger: {
      level: "warn",
      stream: { write: (line: string) => void logs.push(JSON.parse(line)) },
    },
  });
  await app.register(errorHandlerPlugin, { includeStack: false });
  app.get("/x", async () => {
    throw error();
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe("CircuitBreakerError reaches the client as a 503", () => {
  it("is an ArcError with status 503 and code arc.circuit_open", () => {
    const err = new CircuitBreakerError("open", CircuitState.OPEN, 12);
    expect(err).toBeInstanceOf(ArcError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("arc.circuit_open");
    // Existing consumers read these — kept.
    expect(err.name).toBe("CircuitBreakerError");
    expect(err.state).toBe(CircuitState.OPEN);
  });

  it("a real open circuit → 503 + Retry-After, not a 500", async () => {
    const breaker = new CircuitBreaker(
      async () => {
        throw new Error("downstream down");
      },
      { name: "payments", failureThreshold: 1, resetTimeout: 30_000 },
    );
    await breaker.call().catch(() => {}); // trips it

    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin, { includeStack: false });
    app.get("/pay", async () => breaker.call());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/pay" });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("arc.circuit_open");
    // Next probe is ~30s out: the client is told to wait that long, not less.
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(29);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });

  it("is logged at WARN, not as a server error with a stack", async () => {
    await appThrowing(() => new CircuitBreakerError("open", CircuitState.OPEN, 5));
    await app.inject({ method: "GET", url: "/x" });

    expect(logs.some((l) => l.level >= 50)).toBe(false); // no error-level line
    expect(logs.some((l) => l.level === 40 && l.msg === "Service unavailable")).toBe(true);
  });

  it("an UNCLASSIFIED 5xx is still logged at error level — only declared 503s are demoted", async () => {
    await appThrowing(() => new Error("driver exploded"));
    await app.inject({ method: "GET", url: "/x" });
    expect(logs.some((l) => l.level >= 50)).toBe(true);
  });
});

describe("Retry-After", () => {
  it("RateLimitError finally sets the header it always carried", async () => {
    await appThrowing(() => new RateLimitError("slow down", 42));
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
  });

  it("rounds UP and never sends 0 — `Retry-After: 0` is a stampede instruction", async () => {
    await appThrowing(() => new RateLimitError("slow down", 0.2));
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("is omitted when the error has no hint", async () => {
    await appThrowing(() => new RateLimitError("slow down"));
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("is never attached to other statuses", async () => {
    await appThrowing(() =>
      Object.assign(new ArcError("gone", { statusCode: 410, code: "x.gone" }), { retryAfter: 9 }),
    );
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});
