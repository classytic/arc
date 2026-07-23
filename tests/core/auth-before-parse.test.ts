/**
 * Auth-at-onRequest — lifecycle placement (2.22)
 *
 * Arc routers register `authenticate`/`optionalAuthenticate` at the route's
 * `onRequest` stage, BEFORE Fastify parses the body and runs AJV validation
 * (both happen between onRequest and preHandler). Contract under test:
 *
 *   1. Unauthenticated + garbage body  → 401 (never a 400) — anonymous
 *      callers can't burn parse/validate CPU or probe schema shape from
 *      validation errors.
 *   2. Authenticated + invalid body    → 400 validation error — validation
 *      still runs, just gated behind auth.
 *   3. Public route + invalid body     → 400 — allowPublic routes keep
 *      full validation for anonymous callers (optionalAuthenticate never
 *      rejects).
 *   4. Authenticated + valid body      → 2xx — the happy path is intact.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

/** Stub adapter: schema generation + just enough repository for `create`. */
function stubAdapter() {
  return {
    repository: {
      create: async (data: Record<string, unknown>) => ({ _id: "doc-1", ...data }),
      find: async () => [],
    },
    generateSchemas: () => ({
      createBody: {
        type: "object",
        required: ["qty"],
        properties: { qty: { type: "number", exclusiveMinimum: 0 } },
      },
    }),
  };
}

describe("auth runs at onRequest — before body parse + validation", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function makeApp() {
    app = await createApp({
      logger: false,
      preset: "testing",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      resources: [
        defineResource({
          name: "guarded",
          adapter: stubAdapter() as never,
          permissions: { create: requireAuth() },
        }),
        defineResource({
          name: "open",
          adapter: stubAdapter() as never,
          permissions: { create: allowPublic() },
        }),
      ],
    });
    await app.ready();
    return app;
  }

  function token() {
    return (
      app as unknown as {
        auth: { issueTokens: (p: Record<string, unknown>) => { accessToken: string } };
      }
    ).auth.issueTokens({ id: "u1", role: ["user"] }).accessToken;
  }

  it("unauthenticated + malformed JSON → 401, not a parse error", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/guardeds",
      headers: { "content-type": "application/json" },
      body: "{ not json at all",
    });
    expect(res.statusCode).toBe(401);
  });

  it("unauthenticated + schema-violating body → 401, not 400 (no schema probing)", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/guardeds",
      payload: { qty: -5 },
    });
    expect(res.statusCode).toBe(401);
    // Specifically: the response must NOT leak validation details.
    expect(res.body).not.toContain("qty");
  });

  it("authenticated + schema-violating body → 400 validation error (validation intact)", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/guardeds",
      headers: { authorization: `Bearer ${token()}` },
      payload: { qty: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });

  it("public route + schema-violating body → 400 (anonymous validation still works)", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/opens",
      payload: { qty: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("authenticated + valid body → 201 (happy path intact)", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/guardeds",
      headers: { authorization: `Bearer ${token()}` },
      payload: { qty: 3 },
    });
    expect(res.statusCode).toBe(201);
  });
});
