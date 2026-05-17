/**
 * Tests for the action-body validation-error formatter (v2.15.5).
 *
 * Reproduces and locks in the fix for the mentora / OpenAI-team report:
 *
 *   POST /channels/<id>/action with { action: "spawn_post", data: {...} }
 *   used to return `details: [{ path: "note", code: "required",
 *   message: "must have required property 'note'" }]` — pointing at a
 *   property from an UNRELATED action's schema because AJV iterates every
 *   `oneOf` branch and Fastify's error renderer picks the last one.
 *
 * Contract this file locks in:
 *  - `arc.invalid_action` (400) when the submitted `action` isn't in the
 *    enum or is missing entirely. The error lists the valid actions and
 *    the value the client sent, so developers can fix the call in one
 *    pass instead of guessing.
 *  - `arc.validation_error` (400) with details scoped to the matching
 *    action's branch when the action is valid but its body fields are
 *    wrong. Unrelated branches' errors stay out of `details`.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

interface ErrorBody {
  code?: string;
  message?: string;
  status?: number;
  details?: Array<{ path?: string; code?: string; message?: string }>;
  meta?: Record<string, unknown>;
  validActions?: string[];
  submitted?: string;
  action?: string;
}

async function buildApp(name: string): Promise<FastifyInstance> {
  const Model = createMockModel(`ActionValidation_${name}`);
  const repo = createMockRepository(Model);
  const [doc] = await Model.create([{ name: "fixture" }]);
  const docId = String(doc._id);

  const resource = defineResource({
    name: `actionvalid-${name}`,
    prefix: `/actionvalid-${name}`,
    adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    actions: {
      // `spawn_post` requires a `brief` body field.
      spawn_post: {
        handler: async (id, data) => ({ id, ...data }),
        permissions: allowPublic(),
        schema: z.object({ brief: z.string() }) as unknown as Record<string, unknown>,
      },
      // `note` requires its own `note` body field — the unrelated branch the
      // pre-2.15.5 error renderer used to mis-attribute the validation
      // failure to.
      note: {
        handler: async (id, data) => ({ id, ...data }),
        permissions: allowPublic(),
        schema: z.object({ note: z.string() }) as unknown as Record<string, unknown>,
      },
      // No-arg action for the "valid action but missing required" boundary.
      ping: {
        handler: async (id) => ({ id, pong: true }),
        permissions: allowPublic(),
      },
    },
  });

  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(resource.toPlugin());
  await app.ready();

  // Helper to call the action endpoint
  (app as unknown as { docId: string }).docId = docId;
  return app;
}

describe("action body validation — error scope (mentora report)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("reports `arc.invalid_action` when the action isn't in the enum", async () => {
    app = await buildApp("unknown");
    const docId = (app as unknown as { docId: string }).docId;

    const res = await app.inject({
      method: "POST",
      url: `/actionvalid-unknown/${docId}/action`,
      headers: { "content-type": "application/json" },
      payload: { action: "does_not_exist", brief: "x" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as ErrorBody;
    expect(body.code).toBe("arc.invalid_action");
    expect(body.message).toContain("Unknown action 'does_not_exist'");
    // The error lists every valid action so the next call fixes itself
    // without forcing the developer to grep the resource definition.
    expect(body.meta?.validActions).toEqual(expect.arrayContaining(["spawn_post", "note", "ping"]));
    expect(body.meta?.submitted).toBe("does_not_exist");
  });

  it("reports `arc.invalid_action` when `action` is missing entirely", async () => {
    app = await buildApp("missing");
    const docId = (app as unknown as { docId: string }).docId;

    const res = await app.inject({
      method: "POST",
      url: `/actionvalid-missing/${docId}/action`,
      headers: { "content-type": "application/json" },
      payload: { brief: "no action key" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as ErrorBody;
    expect(body.code).toBe("arc.invalid_action");
    expect(body.message).toMatch(/Missing 'action' field/);
  });

  it("scopes validation errors to the SUBMITTED action's branch (mentora repro)", async () => {
    // The exact mentora scenario: action=spawn_post but body uses a `data`
    // envelope instead of the flat `{action, brief}` the schema expects.
    // Pre-fix: details reported `note` (from another action's branch).
    // Post-fix: details say `brief` (the actually-required field for
    // spawn_post) and the message names the action.
    app = await buildApp("scoped");
    const docId = (app as unknown as { docId: string }).docId;

    const res = await app.inject({
      method: "POST",
      url: `/actionvalid-scoped/${docId}/action`,
      headers: { "content-type": "application/json" },
      payload: { action: "spawn_post", data: { brief: "wrapped wrong" } },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as ErrorBody;
    expect(body.code).toBe("arc.validation_error");
    expect(body.message).toContain("spawn_post");
    expect(body.meta?.action).toBe("spawn_post");

    // CRITICAL: details point at spawn_post's own branch (`brief` or
    // `additionalProperties` strict reject of `data`), never at `note`
    // (an unrelated action's required field). Either signal is acceptable
    // — the bug was attribution to a non-matching action's field.
    const detailFields = (body.details ?? []).map((d) => d.path).filter(Boolean);
    const detailMessages = (body.details ?? []).map((d) => d.message).join(" ");
    const allDetail = `${detailFields.join(" ")} ${detailMessages}`.toLowerCase();
    expect(allDetail).toMatch(/data|brief/);
    expect(detailMessages).not.toContain("note");
    expect(detailFields).not.toContain("note");
  });

  it("succeeds when the body matches the submitted action's branch", async () => {
    // Sanity: the formatter only fires on validation failure. A correct
    // call to spawn_post still reaches the handler and returns the result.
    app = await buildApp("ok");
    const docId = (app as unknown as { docId: string }).docId;

    const res = await app.inject({
      method: "POST",
      url: `/actionvalid-ok/${docId}/action`,
      headers: { "content-type": "application/json" },
      payload: { action: "spawn_post", brief: "publish this draft" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { brief?: string };
    expect(body.brief).toBe("publish this draft");
  });
});
