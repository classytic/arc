/**
 * MCP execution parity — hooks, events, scope projection, server accessor,
 * and idempotent execution on the non-HTTP surface.
 *
 * The controller pipeline reads its wiring from the REQUEST context
 * (`metadata.arc.hooks`, `ctx.server`, `ctx.scope`) — stamped by the arc
 * decorator on HTTP. Before this suite's feature landed, MCP's synthetic
 * context carried none of it, so resource hooks (and through the
 * arcCorePlugin after-hook, ALL `<resource>.<op>d` event publishing)
 * silently no-oped on MCP calls: an agent could create records without
 * realtime feeds, webhooks, or event subscribers ever hearing about it.
 * These tests pin the parity restored by `McpExecutionWiring`.
 */

import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { HookSystem } from "../../../src/hooks/HookSystem.js";
import { MemoryIdempotencyStore } from "../../../src/idempotency/stores/index.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type {
  CallToolResult,
  McpAuthResult,
  McpExecutionWiring,
} from "../../../src/integrations/mcp/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────

function makeRepo() {
  let seq = 0;
  return {
    getAll: vi.fn(async () => []),
    getById: vi.fn(async (id: string) => ({ _id: id, name: "existing" })),
    create: vi.fn(async (data: Record<string, unknown>) => ({ _id: `r${++seq}`, ...data })),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => ({ _id: id, ...data })),
    delete: vi.fn(async () => ({ acknowledged: true, deletedCount: 1 })),
  };
}

function makeResource(
  repo: ReturnType<typeof makeRepo>,
  overrides?: Partial<ResourceDefinition>,
): ResourceDefinition {
  return {
    name: "task",
    displayName: "Task",
    tag: "Task",
    prefix: "/tasks",
    adapter: { repository: repo },
    schemaOptions: {},
    permissions: {},
    routes: [],
    middlewares: {},
    disableDefaultRoutes: false,
    disabledRoutes: [],
    customSchemas: {},
    events: {},
    _appliedPresets: [],
    _pendingHooks: [],
    ...overrides,
  } as unknown as ResourceDefinition;
}

function session(overrides?: Partial<McpAuthResult>): McpAuthResult {
  return { userId: "u1", roles: [], ...overrides } as McpAuthResult;
}

async function call(
  tools: ReturnType<typeof resourceToTools>,
  name: string,
  input: Record<string, unknown>,
  auth: McpAuthResult | null = session(),
): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not generated (have: ${tools.map((t) => t.name)})`);
  // biome-ignore lint/suspicious/noExplicitAny: minimal ToolContext for direct handler invocation
  return tool.handler(input, { session: auth } as any);
}

function parse(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

// ── Hooks parity ────────────────────────────────────────────────────────

describe("MCP execution parity — resource hooks", () => {
  it("runs before/after create hooks registered on the shared HookSystem", async () => {
    const hooks = new HookSystem();
    const beforeCreate = vi.fn(async (ctx: { data: Record<string, unknown> }) => ({
      ...ctx.data,
      slug: "from-before-hook",
    }));
    const afterCreate = vi.fn();
    hooks.before("task", "create", beforeCreate);
    hooks.after("task", "create", afterCreate);

    const repo = makeRepo();
    const tools = resourceToTools(makeResource(repo), { wiring: { hooks } });

    const result = await call(tools, "create_task", { name: "write tests" });
    expect(result.isError).not.toBe(true);

    // Before-hook transformed the payload BEFORE the repository saw it.
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(repo.create.mock.calls[0][0]).toMatchObject({
      name: "write tests",
      slug: "from-before-hook",
    });
    expect(afterCreate).toHaveBeenCalledTimes(1);
  });

  it("skips hooks when no wiring is passed (legacy dispatch-only behavior)", async () => {
    const hooks = new HookSystem();
    const beforeCreate = vi.fn(async (ctx: { data: Record<string, unknown> }) => ctx.data);
    hooks.before("task", "create", beforeCreate);

    const repo = makeRepo();
    const tools = resourceToTools(makeResource(repo)); // no wiring
    await call(tools, "create_task", { name: "x" });
    expect(beforeCreate).not.toHaveBeenCalled();
  });

  it("publishes CRUD events through a wildcard after-hook (arcCorePlugin glue shape)", async () => {
    // Same registration arcCorePlugin performs at boot: after('*', op) →
    // events.publish(`${resource}.${op}d`). With hooks now reachable from
    // MCP, this glue fires for MCP mutations — realtime feeds, webhooks,
    // and subscribers see agent-originated changes.
    const hooks = new HookSystem();
    const publish = vi.fn(async () => {});
    hooks.after("*", "create", async (ctx) => {
      await publish(`${ctx.resource}.created`, { data: ctx.result });
    });

    const repo = makeRepo();
    const tools = resourceToTools(makeResource(repo), {
      wiring: { hooks, events: { publish } },
    });

    await call(tools, "create_task", { name: "emit me" });
    expect(publish).toHaveBeenCalledWith(
      "task.created",
      expect.objectContaining({ data: expect.objectContaining({ name: "emit me" }) }),
    );
  });
});

// ── Scope projection + server accessor ──────────────────────────────────

describe("MCP execution parity — context shape", () => {
  it("threads the first-class scope projection into handlers", async () => {
    let seen: unknown;
    const resource = makeResource(makeRepo(), {
      routes: [
        {
          method: "GET",
          path: "/whoami",
          operation: "whoami",
          handler: async (ctx: { scope?: { organizationId?: string; userId?: string } }) => {
            seen = ctx.scope;
            return { data: { ok: true } };
          },
        },
      ],
    } as unknown as Partial<ResourceDefinition>);
    const tools = resourceToTools(resource, { wiring: {} });

    await call(tools, "whoami_task", {}, session({ organizationId: "org9", orgRoles: ["admin"] }));
    expect(seen).toMatchObject({ organizationId: "org9", userId: "u1" });
  });

  it("exposes ctx.server.events to handlers when wiring carries an event bus", async () => {
    const publish = vi.fn(async () => {});
    let serverSeen: unknown;
    const resource = makeResource(makeRepo(), {
      routes: [
        {
          method: "POST",
          path: "/announce",
          operation: "announce",
          handler: async (ctx: {
            server?: { events?: { publish: (...a: unknown[]) => Promise<void> } };
          }) => {
            serverSeen = ctx.server;
            await ctx.server?.events?.publish("task.announced", { loud: true });
            return { data: { ok: true } };
          },
        },
      ],
    } as unknown as Partial<ResourceDefinition>);
    const tools = resourceToTools(resource, { wiring: { events: { publish } } });

    const result = await call(tools, "announce_task", {});
    expect(result.isError).not.toBe(true);
    expect(serverSeen).toBeDefined();
    expect(publish).toHaveBeenCalledWith("task.announced", { loud: true });
  });
});

// ── Idempotent execution ────────────────────────────────────────────────

describe("MCP execution parity — idempotency", () => {
  it("advertises _idempotencyKey on mutating tools only when a store is wired", () => {
    const repo = makeRepo();
    const withStore = resourceToTools(makeResource(repo), {
      wiring: { idempotencyStore: new MemoryIdempotencyStore({ ttlMs: 60_000 }) },
    });
    const withoutStore = resourceToTools(makeResource(repo));

    const inputKeys = (tools: typeof withStore, name: string) =>
      Object.keys(
        (tools.find((t) => t.name === name)?.inputSchema ?? {}) as Record<string, unknown>,
      );

    expect(inputKeys(withStore, "create_task")).toContain("_idempotencyKey");
    expect(inputKeys(withStore, "update_task")).toContain("_idempotencyKey");
    expect(inputKeys(withStore, "delete_task")).toContain("_idempotencyKey");
    expect(inputKeys(withStore, "list_tasks")).not.toContain("_idempotencyKey");
    expect(inputKeys(withoutStore, "create_task")).not.toContain("_idempotencyKey");
  });

  it("replays the first successful result instead of re-executing", async () => {
    const repo = makeRepo();
    const store = new MemoryIdempotencyStore({ ttlMs: 60_000 });
    const tools = resourceToTools(makeResource(repo), {
      wiring: { idempotencyStore: store },
    });

    const first = await call(tools, "create_task", { name: "once", _idempotencyKey: "k1" });
    const second = await call(tools, "create_task", { name: "once", _idempotencyKey: "k1" });

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(parse(second)).toEqual(parse(first)); // byte-identical replay
  });

  it("treats the same key with DIFFERENT input as a fresh execution", async () => {
    const repo = makeRepo();
    const store = new MemoryIdempotencyStore({ ttlMs: 60_000 });
    const tools = resourceToTools(makeResource(repo), {
      wiring: { idempotencyStore: store },
    });

    await call(tools, "create_task", { name: "a", _idempotencyKey: "k1" });
    await call(tools, "create_task", { name: "b", _idempotencyKey: "k1" });
    expect(repo.create).toHaveBeenCalledTimes(2);
  });

  it("scopes replay to caller identity", async () => {
    const repo = makeRepo();
    const store = new MemoryIdempotencyStore({ ttlMs: 60_000 });
    const tools = resourceToTools(makeResource(repo), {
      wiring: { idempotencyStore: store },
    });

    await call(tools, "create_task", { name: "x", _idempotencyKey: "k1" }, session());
    await call(
      tools,
      "create_task",
      { name: "x", _idempotencyKey: "k1" },
      session({ userId: "u2" }),
    );
    expect(repo.create).toHaveBeenCalledTimes(2);
  });

  it("does not cache error results — a retry re-executes", async () => {
    const repo = makeRepo();
    repo.create
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ _id: "r1", name: "ok" });
    const store = new MemoryIdempotencyStore({ ttlMs: 60_000 });
    const tools = resourceToTools(makeResource(repo), {
      wiring: { idempotencyStore: store },
    });

    const first = await call(tools, "create_task", { name: "ok", _idempotencyKey: "k1" });
    expect(first.isError).toBe(true);
    const second = await call(tools, "create_task", { name: "ok", _idempotencyKey: "k1" });
    expect(second.isError).not.toBe(true);
    expect(repo.create).toHaveBeenCalledTimes(2);
  });

  it("never leaks _idempotencyKey into the created document", async () => {
    const repo = makeRepo();
    const store = new MemoryIdempotencyStore({ ttlMs: 60_000 });
    const tools = resourceToTools(makeResource(repo), {
      wiring: { idempotencyStore: store },
    });

    await call(tools, "create_task", { name: "clean", _idempotencyKey: "k1" });
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty("_idempotencyKey");
  });

  it("ignores the key entirely when no store is wired (strips, no crash)", async () => {
    const repo = makeRepo();
    const tools = resourceToTools(makeResource(repo)); // no wiring
    const result = await call(tools, "create_task", { name: "x", _idempotencyKey: "k1" });
    expect(result.isError).not.toBe(true);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty("_idempotencyKey");
  });
});

// ── Wiring interplay with masking (both features at once) ──────────────

describe("MCP execution parity — wiring + field masking compose", () => {
  it("masks hook-transformed documents on the way out", async () => {
    const hooks = new HookSystem();
    hooks.before("task", "create", async (ctx: { data: Record<string, unknown> }) => ({
      ...ctx.data,
      secret: "internal-only",
    }));

    const { fields } = await import("../../../src/permissions/fields.js");
    const repo = makeRepo();
    const resource = makeResource(repo, {
      fields: { secret: fields.hidden() },
    } as unknown as Partial<ResourceDefinition>);
    const tools = resourceToTools(resource, { wiring: { hooks } });

    const result = await call(tools, "create_task", { name: "compose" });
    const doc = parse(result);
    // Hook ran (repo saw the secret) …
    expect(repo.create.mock.calls[0][0]).toMatchObject({ secret: "internal-only" });
    // … but the wire never shows it.
    expect(doc).not.toHaveProperty("secret");
  });
});
