/**
 * Realtime tool bridge — verifies that LiveKit Agents / Gemini Live /
 * OpenAI Realtime tool-call envelopes route through arc's MCP tool
 * registry with the same handler semantics as the MCP server.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, dispatchRealtimeToolCall } from "../../../src/integrations/mcp/index.js";

describe("dispatchRealtimeToolCall", () => {
  const weather = defineTool("get_weather", {
    description: "test",
    input: { city: z.string(), units: z.enum(["c", "f"]).default("c") },
    handler: async ({ city, units }) => ({
      content: [{ type: "text", text: JSON.stringify({ city, units, temp: 22 }) }],
    }),
  });

  const echo = defineTool("echo", {
    description: "test",
    input: { msg: z.string() },
    handler: async ({ msg }) => ({
      content: [{ type: "text", text: msg }],
    }),
  });

  it("routes a tool call to the matching MCP handler and returns the response", async () => {
    const [response] = await dispatchRealtimeToolCall(
      [weather],
      [{ id: "call-1", name: "get_weather", arguments: { city: "SF" } }],
    );
    expect(response).toBeDefined();
    expect(response?.id).toBe("call-1");
    expect(response?.name).toBe("get_weather");
    expect(response?.isError).toBeFalsy();
    expect(response?.response).toEqual({ city: "SF", units: "c", temp: 22 });
  });

  it("returns isError + error message for unknown tool names", async () => {
    const [response] = await dispatchRealtimeToolCall(
      [weather],
      [{ id: "x", name: "unknown_tool", arguments: {} }],
    );
    expect(response?.isError).toBe(true);
    expect(JSON.stringify(response?.response)).toContain("unknown tool");
  });

  it("validates input via the tool's Zod schema and surfaces field errors", async () => {
    const [response] = await dispatchRealtimeToolCall(
      [weather],
      [{ id: "x", name: "get_weather", arguments: { city: 123 } }],
    );
    expect(response?.isError).toBe(true);
    expect(JSON.stringify(response?.response)).toContain("validation failed");
  });

  it("accepts arguments_json (OpenAI Realtime tool format)", async () => {
    const [response] = await dispatchRealtimeToolCall(
      [echo],
      [{ id: "x", name: "echo", arguments_json: '{"msg":"hi"}' }],
    );
    expect(response?.isError).toBeFalsy();
    expect((response?.response as { text: string }).text).toBe("hi");
  });

  it("dispatches batched calls in parallel and preserves order", async () => {
    // Observe OVERLAP directly rather than inferring it from elapsed time.
    // "three 50ms tasks finish under 120ms" is only true on an unloaded machine —
    // it measured the runner, not the dispatcher, and a busy pool pushed a
    // genuinely-parallel run past the serial threshold (218ms observed).
    // Peak in-flight count answers the actual question and cannot be starved.
    let inFlight = 0;
    let maxInFlight = 0;

    const slow = defineTool("slow", {
      description: "test",
      input: { ms: z.number() },
      handler: async ({ ms }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight--;
        return { content: [{ type: "text", text: String(ms) }] };
      },
    });

    const responses = await dispatchRealtimeToolCall(
      [slow],
      [
        { id: "a", name: "slow", arguments: { ms: 50 } },
        { id: "b", name: "slow", arguments: { ms: 50 } },
        { id: "c", name: "slow", arguments: { ms: 50 } },
      ],
    );

    // Order is preserved even though execution overlapped.
    expect(responses.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(maxInFlight).toBe(3);
    expect(inFlight).toBe(0);
  });

  it("isolates per-call failures (one tool throwing does not break the batch)", async () => {
    const failing = defineTool("fail", {
      description: "test",
      input: { x: z.number() },
      handler: async () => {
        throw new Error("boom");
      },
    });

    const responses = await dispatchRealtimeToolCall(
      [echo, failing],
      [
        { id: "ok", name: "echo", arguments: { msg: "alive" } },
        { id: "boom", name: "fail", arguments: { x: 1 } },
      ],
    );
    expect(responses[0]?.isError).toBeFalsy();
    expect(responses[1]?.isError).toBe(true);
    expect(JSON.stringify(responses[1]?.response)).toContain("boom");
  });

  it("passes session into the tool handler context", async () => {
    let observedSession: unknown;
    const inspecting = defineTool("inspect", {
      description: "test",
      input: {},
      handler: async (_input, ctx) => {
        observedSession = ctx.session;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    await dispatchRealtimeToolCall([inspecting], [{ id: "x", name: "inspect", arguments: {} }], {
      session: { userId: "alice", scopes: ["read"] },
    });
    expect(observedSession).toEqual({ userId: "alice", scopes: ["read"] });
  });
});
