/**
 * Boot diagnostic: `events: {...}` declared without `eventPlugin`.
 *
 * `arcCorePlugin`'s post-hook already short-circuits emission with
 * `if (!hasEvents(fastify)) return` — so a resource that declares
 * `events: { created: {} }` silently never emits anything when the host
 * forgot to register `eventPlugin`. Downstream subscribers (analytics,
 * webhook fan-out, audit) get nothing and the host has no signal.
 *
 * Post-fix, `buildResourcePlugin` warns at first mount with the literal
 * event names and a hint to either register `eventPlugin` or remove the
 * declaration.
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

describe("buildResourcePlugin — events without eventPlugin", () => {
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

  it("warns when events:{...} is declared but eventPlugin is absent", async () => {
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
      events: {
        created: {},
        updated: {},
      },
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          /Resource 'order'/.test(m) &&
          /events/.test(m) &&
          /eventPlugin/.test(m) &&
          /silently NOT be emitted/.test(m),
      ),
    ).toBe(true);
  });

  it("includes the declared event names in the warning", async () => {
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
      events: { created: {}, updated: {}, deleted: {} },
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    const match = messages.find((m) => /silently NOT be emitted/.test(m));
    expect(match).toContain("created");
    expect(match).toContain("updated");
    expect(match).toContain("deleted");
  });

  it("does NOT warn when eventPlugin IS registered (events.publish exists)", async () => {
    // Mimic eventPlugin's contract by decorating fastify.events with a publish fn.
    app.decorate("events", {
      publish: async () => {},
      subscribe: async () => {},
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
      events: { created: {} },
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /silently NOT be emitted/.test(m))).toBe(false);
  });

  it("does NOT warn when the resource doesn't declare events", async () => {
    const resource = defineResource({
      name: "untouched",
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
    expect(messages.some((m) => /silently NOT be emitted/.test(m))).toBe(false);
  });

  it("does NOT warn when events is declared but empty", async () => {
    const resource = defineResource({
      name: "noevents",
      adapter: createTestAdapter(new StubRepo()),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      events: {},
    });

    await app.register(resource.toPlugin(), { prefix: "/api" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /silently NOT be emitted/.test(m))).toBe(false);
  });
});
