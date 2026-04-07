import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePrompt } from "../../../src/integrations/mcp/definePrompt.js";
import { defineTool } from "../../../src/integrations/mcp/defineTool.js";

describe("defineTool", () => {
  it("creates a ToolDefinition with flat input shape", () => {
    const tool = defineTool("greet", {
      description: "Say hello",
      input: { name: z.string() },
      handler: async ({ name }) => ({
        content: [{ type: "text" as const, text: `Hello ${name}` }],
      }),
    });

    expect(tool.name).toBe("greet");
    expect(tool.description).toBe("Say hello");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema?.name).toBeDefined();
  });

  it("preserves annotations", () => {
    const tool = defineTool("read", {
      description: "Read data",
      annotations: { readOnlyHint: true },
      handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    });

    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it("handles no input schema", () => {
    const tool = defineTool("ping", {
      description: "Ping",
      handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] }),
    });

    expect(tool.inputSchema).toBeUndefined();
  });

  it("preserves title and output schema", () => {
    const tool = defineTool("calc", {
      description: "Calculate",
      title: "Calculator",
      input: { a: z.number(), b: z.number() },
      output: { result: z.number() },
      handler: async ({ a, b }) => ({
        content: [{ type: "text" as const, text: String(a + b) }],
      }),
    });

    expect(tool.title).toBe("Calculator");
    expect(tool.outputSchema).toBeDefined();
  });
});

describe("definePrompt", () => {
  it("creates a PromptDefinition with flat args shape", () => {
    const prompt = definePrompt("summarize", {
      description: "Summarize content",
      args: { topic: z.string(), length: z.number().optional() },
      handler: ({ topic }) => ({
        messages: [{ role: "user", content: { type: "text", text: `Summarize ${topic}` } }],
      }),
    });

    expect(prompt.name).toBe("summarize");
    expect(prompt.description).toBe("Summarize content");
    expect(prompt.argsSchema).toBeDefined();
    expect(prompt.argsSchema?.topic).toBeDefined();
  });

  it("handles no args schema", () => {
    const prompt = definePrompt("help", {
      description: "Get help",
      handler: () => ({
        messages: [{ role: "user", content: { type: "text", text: "Help me" } }],
      }),
    });

    expect(prompt.argsSchema).toBeUndefined();
  });
});
