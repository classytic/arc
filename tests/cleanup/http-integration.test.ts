/**
 * HTTP integration — the defect the direct-handler tests could not catch.
 *
 * `CleanupError` must reach the client with its own `status` + machine `code`,
 * NOT arc's generic `arc.internal_error` 500. This mounts arc's real
 * `errorHandlerPlugin` and a route that throws a `CleanupError`, then injects
 * requests and asserts the wire envelope — proving `statusCode` flows through
 * arc's classifier (step 4: numeric statusCode + separatored domain code).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type CleanupError, CleanupErrors } from "../../src/cleanup/index.js";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";

describe("cleanup HTTP error mapping", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function appThrowing(err: CleanupError): Promise<FastifyInstance> {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin, {});
    app.get("/boom", async () => {
      throw err;
    });
    await app.ready();
    return app;
  }

  const cases: Array<{ name: string; err: CleanupError; status: number; code: string }> = [
    {
      name: "plan changed",
      err: CleanupErrors.planChanged("a", "b"),
      status: 409,
      code: "CLEANUP_PLAN_CHANGED",
    },
    {
      name: "confirmation",
      err: CleanupErrors.confirmationRequired("GO"),
      status: 400,
      code: "CLEANUP_CONFIRMATION_REQUIRED",
    },
    {
      name: "run not found",
      err: CleanupErrors.runNotFound("r1"),
      status: 404,
      code: "CLEANUP_RUN_NOT_FOUND",
    },
    {
      name: "already running",
      err: CleanupErrors.alreadyRunning("r0"),
      status: 409,
      code: "CLEANUP_ALREADY_RUNNING",
    },
    {
      name: "blocked",
      err: CleanupErrors.blocked(["OPEN_TRANSFER"]),
      status: 409,
      code: "CLEANUP_BLOCKED",
    },
    {
      name: "actor required",
      err: CleanupErrors.actorRequired(),
      status: 401,
      code: "CLEANUP_ACTOR_REQUIRED",
    },
    {
      name: "unknown recipe",
      err: CleanupErrors.unknownRecipe("x"),
      status: 404,
      code: "CLEANUP_UNKNOWN_RECIPE",
    },
  ];

  for (const { name, err, status, code } of cases) {
    it(`maps ${name} to HTTP ${status} with code ${code} (not arc.internal_error)`, async () => {
      const a = await appThrowing(err);
      const res = await a.inject({ method: "GET", url: "/boom" });
      expect(res.statusCode).toBe(status);
      const body = res.json();
      expect(body.error?.code ?? body.code).toBe(code);
      // Crucially NOT the generic fallback.
      expect(JSON.stringify(body)).not.toContain("arc.internal_error");
    });
  }
});
