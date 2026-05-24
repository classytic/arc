/**
 * Boot diagnostics for silent-drop misconfigurations.
 *
 * A resource can declare features that depend on optional plugins:
 *   - `cache.invalidateOn` → requires `queryCachePlugin`
 *   - `audit: true` → requires `auditPlugin` (in `perResource` mode)
 *
 * Pre-fix, a host that forgot to register the plugin saw the feature flag
 * silently do nothing — "why isn't my cache invalidating?" / "why aren't
 * audit events being recorded?" became hours-long debugging sessions.
 *
 * Post-fix, `buildResourcePlugin` warns at first mount with an actionable
 * hint naming the missing plugin and the literal config to either add it or
 * remove the dead flag.
 */
import type { StandardRepo } from "@classytic/repo-core/repository";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { AnyRecord, DataAdapter } from "../../src/types/index.js";

function createTestAdapter(repo: StandardRepo): DataAdapter {
  return { repository: repo, type: "custom", name: "test-adapter" };
}

class StubRepo implements StandardRepo {
  async getAll() {
    return [];
  }
  async getById() {
    return null;
  }
  async create(data: AnyRecord) {
    return { _id: "1", ...data };
  }
  async update(id: string, data: AnyRecord) {
    return { _id: id, ...data };
  }
  async delete() {
    return true;
  }
}

function makeFastifyWithWarnSpy(): {
  app: FastifyInstance;
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const warnSpy = vi.fn();
  const app = Fastify({ logger: false });
  Object.defineProperty(app, "log", {
    value: {
      warn: warnSpy,
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child() {
        return app.log;
      },
    },
    writable: false,
    configurable: true,
  });
  return { app, warnSpy };
}

describe("buildResourcePlugin — cache.invalidateOn without queryCachePlugin", () => {
  let app: FastifyInstance;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const built = makeFastifyWithWarnSpy();
    app = built.app;
    warnSpy = built.warnSpy;
  });

  afterEach(async () => {
    await app.close();
  });

  it("warns when cache.invalidateOn is declared but queryCachePlugin is absent", async () => {
    const resource = defineResource({
      name: "thing",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      cache: { invalidateOn: { "thing.created": ["thing-list"] } },
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          /cache\.invalidateOn/.test(m) && /queryCachePlugin/.test(m) && /silently ignored/.test(m),
      ),
    ).toBe(true);
  });

  it("does NOT warn when queryCachePlugin IS registered (the rule is registered, not dropped)", async () => {
    // Register a fake decorator that mimics queryCachePlugin's contract.
    const ruleSpy = vi.fn();
    app.decorate("registerCacheInvalidationRule", ruleSpy);

    const resource = defineResource({
      name: "thing",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      cache: { invalidateOn: { "thing.created": ["thing-list"] } },
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /cache\.invalidateOn/.test(m))).toBe(false);
    // The rule was actually registered through the plugin's contract.
    expect(ruleSpy).toHaveBeenCalledWith({
      pattern: "thing.created",
      tags: ["thing-list"],
    });
  });
});

describe("buildResourcePlugin — audit: true without auditPlugin", () => {
  let app: FastifyInstance;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const built = makeFastifyWithWarnSpy();
    app = built.app;
    warnSpy = built.warnSpy;
  });

  afterEach(async () => {
    await app.close();
  });

  it("warns when audit:true is declared but auditPlugin is absent", async () => {
    const resource = defineResource({
      name: "order",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      audit: true,
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some((m) => /audit/.test(m) && /auditPlugin/.test(m) && /NOT be recorded/.test(m)),
    ).toBe(true);
  });

  it("warns when audit decorator is the noop logger (host passed enabled:false)", async () => {
    // Mirror the shape auditPlugin installs when `enabled: false` — the
    // detection logic looks for the `_noop: true` marker, not full plugin
    // registration, so we can test the logic in isolation.
    app.decorate("audit", {
      create: async () => {},
      update: async () => {},
      delete: async () => {},
      restore: async () => {},
      custom: async () => {},
      query: async () => [],
      purge: async () => 0,
      _noop: true,
    });

    const resource = defineResource({
      name: "order",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      audit: true,
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /audit/.test(m) && /NOT be recorded/.test(m))).toBe(true);
  });

  it("does NOT warn when audit decorator is a real logger", async () => {
    // Same shape as the noop, minus the `_noop` marker — represents a real
    // audit logger backed by an actual store.
    app.decorate("audit", {
      create: async () => {},
      update: async () => {},
      delete: async () => {},
      restore: async () => {},
      custom: async () => {},
      query: async () => [],
      purge: async () => 0,
    });

    const resource = defineResource({
      name: "order",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      audit: true,
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /NOT be recorded/.test(m))).toBe(false);
  });

  it("does NOT warn when the resource doesn't declare audit", async () => {
    const resource = defineResource({
      name: "untracked",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /NOT be recorded/.test(m))).toBe(false);
  });
});
