/**
 * Request-decorator declarations
 *
 * Every request property arc assigns per-request must be declared via
 * `decorateRequest` by the owning plugin — an undeclared write mutates the
 * request object's hidden class at runtime (V8 deopt on hot paths, per the
 * Fastify decorators guide). These tests pin the contract so a new
 * `request.foo = ...` without a matching declaration is caught.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { responseCachePlugin } from "../../src/plugins/response-cache.js";

describe("request decorator declarations", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("arcCorePlugin declares every policy/preset request field", async () => {
    app = await createApp({ preset: "testing", auth: false });
    for (const field of [
      "_policyFilters",
      "_ownershipCheck",
      "fieldMask",
      "policyMetadata",
      "document",
    ]) {
      expect(app.hasRequestDecorator(field), `missing decorateRequest("${field}")`).toBe(true);
    }
  });

  it("responseCachePlugin declares __arcCacheTTL (written by a global onRequest hook)", async () => {
    app = Fastify({ logger: false });
    await app.register(responseCachePlugin);
    await app.ready();
    expect(app.hasRequestDecorator("__arcCacheTTL")).toBe(true);
  });

  it("idempotencyPlugin declares _idempotencyFullKey in both enabled and disabled modes", async () => {
    app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, { enabled: true });
    await app.ready();
    expect(app.hasRequestDecorator("_idempotencyFullKey")).toBe(true);

    const disabled = Fastify({ logger: false });
    await disabled.register(idempotencyPlugin, { enabled: false });
    await disabled.ready();
    expect(disabled.hasRequestDecorator("_idempotencyFullKey")).toBe(true);
    await disabled.close();
  });
});
