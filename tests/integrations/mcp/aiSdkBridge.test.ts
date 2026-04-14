import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  bridgeToMcp,
  buildMcpToolsFromBridges,
  type McpBridge,
} from "../../../src/integrations/mcp/aiSdkBridge.js";
import { createTestMcpClient } from "../../../src/integrations/mcp/testing.js";
import type { ToolContext, ToolDefinition } from "../../../src/integrations/mcp/types.js";

function makeAuthedCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    user: { id: "acme", organizationId: "acme" },
    session: { userId: "acme", apiKey: "test" },
    ...overrides,
  } as unknown as ToolContext;
}

function makeAnonCtx(): ToolContext {
  return { user: null, session: null } as unknown as ToolContext;
}

/** Ctx with the MCP "anonymous" sentinel — must be treated as unauthenticated. */
function makeAnonymousSentinelCtx(): ToolContext {
  return {
    user: null,
    session: { userId: "anonymous" },
  } as unknown as ToolContext;
}

/** Invoke an MCP tool's handler directly. */
function call(
  tool: ToolDefinition,
  input: unknown,
  ctx: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return tool.handler(input as Record<string, unknown>, ctx) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

describe("bridgeToMcp", () => {
  const echoBridge: McpBridge = {
    name: "echo",
    description: "Echoes input.",
    inputSchema: { msg: z.string() },
    buildTool: () => ({
      execute: async (input) => ({ echoed: (input as { msg: string }).msg }),
    }),
  };

  it("rejects unauthenticated callers", async () => {
    const tool = bridgeToMcp(echoBridge);
    const res = await call(tool, { msg: "hi" }, makeAnonCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/auth/i);
  });

  it("invokes the built tool when authenticated", async () => {
    const tool = bridgeToMcp(echoBridge);
    const res = await call(tool, { msg: "hi" }, makeAuthedCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("echoed");
    expect(res.content[0]!.text).toContain("hi");
  });

  it("passes ctx to buildTool for per-request dep resolution", async () => {
    const buildTool = vi.fn(() => ({ execute: async () => ({ ok: true }) }));
    const tool = bridgeToMcp({ ...echoBridge, buildTool });

    const ctx = makeAuthedCtx();
    await call(tool, { msg: "x" }, ctx);
    expect(buildTool).toHaveBeenCalledWith(ctx);
  });

  it("runs custom guard and rejects with its message", async () => {
    const tool = bridgeToMcp({ ...echoBridge, guard: () => "no write scope" });
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("no write scope");
  });

  it("proceeds when guard returns null", async () => {
    const tool = bridgeToMcp({ ...echoBridge, guard: () => null });
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(res.isError).toBeFalsy();
  });

  it("converts AI SDK { error } results into MCP isError envelopes", async () => {
    const tool = bridgeToMcp({
      ...echoBridge,
      buildTool: () => ({ execute: async () => ({ error: "recoverable failure" }) }),
    });
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("recoverable failure");
  });

  it("catches thrown errors and returns them as MCP errors", async () => {
    const tool = bridgeToMcp({
      ...echoBridge,
      buildTool: () => ({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    });
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("boom");
  });

  it("serializes plain objects to pretty JSON", async () => {
    const tool = bridgeToMcp({
      ...echoBridge,
      buildTool: () => ({ execute: async () => ({ a: 1, b: [2, 3] }) }),
    });
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(res.content[0]!.text).toContain('"a": 1');
    expect(res.content[0]!.text).toContain('"b"');
  });

  it("passes through string results without extra serialization", async () => {
    const tool = bridgeToMcp({
      ...echoBridge,
      buildTool: () => ({ execute: async () => "plain string" }),
    });
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(res.content[0]!.text).toBe("plain string");
  });

  // ── Anti-regression: pin behavior we depend on ──

  it("rejects the MCP 'anonymous' sentinel session the same as null", async () => {
    // Pins the contract that isAuthenticated() treats userId==='anonymous' as
    // unauthenticated. If this flips upstream, every bridge silently becomes
    // open-to-public.
    const tool = bridgeToMcp(echoBridge);
    const res = await call(tool, { msg: "x" }, makeAnonymousSentinelCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/auth/i);
  });

  it("runs auth BEFORE custom guard (guard is never evaluated for anon)", async () => {
    // Ordering matters: a guard that throws or reads session.* should never
    // run for unauthenticated callers.
    const guard = vi.fn(() => null);
    const tool = bridgeToMcp({ ...echoBridge, guard });
    await call(tool, { msg: "x" }, makeAnonCtx());
    expect(guard).not.toHaveBeenCalled();
  });

  it("calls buildTool fresh on every invocation (no caching)", async () => {
    // Per-request deps (companyId, projectId, etc.) must be re-resolved each
    // call so stale ctx can never leak across tenants.
    const buildTool = vi.fn(() => ({ execute: async () => ({ ok: true }) }));
    const tool = bridgeToMcp({ ...echoBridge, buildTool });
    await call(tool, { msg: "x" }, makeAuthedCtx());
    await call(tool, { msg: "y" }, makeAuthedCtx());
    await call(tool, { msg: "z" }, makeAuthedCtx());
    expect(buildTool).toHaveBeenCalledTimes(3);
  });

  it("pins the MCP response envelope shape", async () => {
    // Anti-regression on the wire shape external agents parse.
    const tool = bridgeToMcp(echoBridge);
    const res = await call(tool, { msg: "x" }, makeAuthedCtx());
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0]!.type).toBe("text");
    expect(typeof res.content[0]!.text).toBe("string");
  });
});

describe("buildMcpToolsFromBridges — config-driven filtering", () => {
  const noopBridge = (name: string): McpBridge => ({
    name,
    description: "noop",
    inputSchema: {},
    buildTool: () => ({ execute: async () => ({}) }),
  });
  const all: McpBridge[] = [noopBridge("a"), noopBridge("b"), noopBridge("c")];

  it("returns all bridges by default", () => {
    expect(buildMcpToolsFromBridges(all)).toHaveLength(3);
  });

  it("include: allowlist only", () => {
    const tools = buildMcpToolsFromBridges(all, { include: ["b"] });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("b");
  });

  it("exclude: removes named bridges", () => {
    const tools = buildMcpToolsFromBridges(all, { exclude: ["a"] });
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("a");
  });

  it("unknown include names return an empty array", () => {
    expect(buildMcpToolsFromBridges(all, { include: ["does_not_exist"] })).toEqual([]);
  });

  it("empty bridges array returns empty", () => {
    expect(buildMcpToolsFromBridges([])).toEqual([]);
  });
});

describe("bridge registration end-to-end", () => {
  const bridges: McpBridge[] = [
    {
      name: "ping",
      description: "Ping.",
      inputSchema: {},
      buildTool: () => ({ execute: async () => "pong" }),
    },
    {
      name: "trigger_job",
      description: "Trigger a job.",
      inputSchema: { phase: z.enum(["investigate", "fix"]) },
      annotations: { destructiveHint: true },
      buildTool: () => ({
        execute: async (input) => ({ jobId: `${(input as { phase: string }).phase}-123` }),
      }),
    },
  ];

  it("registers bridges via extraTools and invokes them through InMemoryTransport", async () => {
    const client = await createTestMcpClient({
      pluginOptions: { extraTools: buildMcpToolsFromBridges(bridges) },
      auth: { userId: "u1", organizationId: "org-1" },
    });

    try {
      const tools = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("ping");
      expect(names).toContain("trigger_job");

      const ping = await client.callTool("ping", {});
      expect(ping.isError).toBeFalsy();
      expect(ping.content[0]!.text).toBe("pong");

      const job = await client.callTool("trigger_job", { phase: "fix" });
      expect(job.isError).toBeFalsy();
      expect(job.content[0]!.text).toContain("fix-123");
    } finally {
      await client.close();
    }
  });

  it("rejects invalid input through the MCP transport (zod schema enforced)", async () => {
    // Anti-regression: input validation happens at the MCP SDK layer before
    // the bridge handler runs. If this stops working, malformed input would
    // hit buildTool and break downstream.
    const client = await createTestMcpClient({
      pluginOptions: { extraTools: buildMcpToolsFromBridges(bridges) },
      auth: { userId: "u1", organizationId: "org-1" },
    });

    try {
      const res = await client.callTool("trigger_job", { phase: "not-a-valid-phase" });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("rejects anonymous callers over the MCP transport", async () => {
    // Full-roundtrip auth check using the MCP "anonymous" sentinel.
    // `createTestMcpClient` defaults to `test-user` when auth is null/undefined,
    // so to exercise the unauth path we pass the sentinel explicitly.
    const client = await createTestMcpClient({
      pluginOptions: { extraTools: buildMcpToolsFromBridges(bridges) },
      auth: { userId: "anonymous" },
    });

    try {
      const res = await client.callTool("ping", {});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/auth/i);
    } finally {
      await client.close();
    }
  });

  it("honors exclude filter at registration time", async () => {
    const client = await createTestMcpClient({
      pluginOptions: {
        extraTools: buildMcpToolsFromBridges(bridges, { exclude: ["trigger_job"] }),
      },
      auth: { userId: "u1", organizationId: "org-1" },
    });

    try {
      const names = (await client.listTools()).map((t) => t.name);
      expect(names).toContain("ping");
      expect(names).not.toContain("trigger_job");
    } finally {
      await client.close();
    }
  });
});
