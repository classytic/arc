/**
 * mcpPlugin speaks MCP 2026-07-28 only: a modern client connects and tools see
 * arc's identity; a 2025-era client is refused with the SDK's
 * unsupported-protocol-version error; GET / DELETE answer 405; a 401 carries
 * the OAuth challenge under Better Auth.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "../../../src/integrations/mcp/index.js";
import { mcpPlugin } from "../../../src/integrations/mcp/mcpPlugin.js";
import type { BetterAuthHandler } from "../../../src/integrations/mcp/types.js";

const whoami = defineTool("whoami", {
  description: "Echo the caller",
  handler: async (_input, ctx) => {
    const http = (ctx.extra as { http?: { authInfo?: { clientId?: string } } }).http;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            user: ctx.session?.userId,
            sdkClientId: http?.authInfo?.clientId,
          }),
        },
      ],
    };
  },
});

let app: FastifyInstance | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await app?.close();
  app = undefined;
});

async function listen(): Promise<URL> {
  app = Fastify({ logger: false });
  await app.register(mcpPlugin, {
    resources: [],
    extraTools: [whoami],
    auth: (headers) =>
      headers["x-who"] ? { userId: headers["x-who"], clientId: `${headers["x-who"]}-app` } : null,
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return new URL(`${address}/mcp`);
}

function transport(url: URL) {
  return new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-who": "alice" } } });
}

describe("mcpPlugin — protocol 2026-07-28 only", () => {
  it("a negotiating client lands on 2026-07-28 and the tool sees arc's identity", async () => {
    const client = new Client(
      { name: "modern", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    clients.push(client);
    await client.connect(transport(await listen()));
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

    const result = await client.callTool({ name: "whoami", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    // `session` is arc's identity; `http.authInfo` is the SDK pass-through.
    expect(JSON.parse(text)).toEqual({ user: "alice", sdkClientId: "alice-app" });
  });

  it("a 2025-era client is refused with the supported-version error", async () => {
    const client = new Client({ name: "legacy", version: "1.0.0" });
    await expect(client.connect(transport(await listen()))).rejects.toThrow(
      /Unsupported protocol version: 2025-.*"supported":\["2026-07-28"\]/,
    );
  });

  it("a raw 2025 `initialize` answers 400 / -32022 naming 2026-07-28", async () => {
    await listen();
    const res = await app?.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "x-who": "alice",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      },
    });
    expect(res?.statusCode).toBe(400);
    expect(res?.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32022, data: { supported: ["2026-07-28"], requested: "2025-06-18" } },
    });
  });

  it("GET and DELETE answer 405 with Allow: POST", async () => {
    await listen();
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app?.inject({ method, url: "/mcp", headers: { "x-who": "alice" } });
      expect(res?.statusCode).toBe(405);
      expect(res?.headers.allow).toBe("POST");
    }
  });

  it("health names the protocol revision", async () => {
    await listen();
    const res = await app?.inject({ method: "GET", url: "/mcp/health" });
    expect(res?.json()).toEqual({ status: "ok", protocolVersion: "2026-07-28" });
  });
});

describe("mcpPlugin — 401 challenge", () => {
  const discover = {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "server/discover",
  };

  it("Better Auth: points the client at the protected-resource metadata", async () => {
    const betterAuth: BetterAuthHandler = {
      api: { getMcpSession: async () => null },
      handler: async () => new Response("{}"),
    };
    app = Fastify({ logger: false });
    await app.register(mcpPlugin, { resources: [], auth: betterAuth });
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, host: "api.example.com" },
      payload: discover,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="http://api.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("custom resolver: 401 without a Bearer challenge (may be an API-key gate)", async () => {
    app = Fastify({ logger: false });
    await app.register(mcpPlugin, { resources: [], auth: () => null });
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: discover });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});
