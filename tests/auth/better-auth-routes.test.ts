/**
 * The auth catch-all registers only the verbs Better Auth routes, and hands
 * Better Auth a request it can trust (origin with port, server-set client IP).
 * Real `betterAuth()` instance on the memory adapter.
 */

import cors from "@fastify/cors";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BETTER_AUTH_CLIENT_IP_HEADER,
  type BetterAuthHandler,
  createBetterAuthAdapter,
} from "../../src/auth/betterAuth.js";
import { createApp } from "../../src/factory/createApp.js";

const ORIGIN = "http://localhost:3000";

function realAuth() {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: "http://localhost:4000",
    basePath: "/api/auth",
    secret: "routes-test-secret-please-ignore-0123456789",
    trustedOrigins: [ORIGIN],
    emailAndPassword: { enabled: true, autoSignIn: true },
  });
}

/** The real instance with its fetch handler spied, so a test can prove a verb never reached it. */
function spiedAuth() {
  const auth = realAuth();
  const handler = vi.fn((request: Request) => auth.handler(request));
  return { handler, adapterAuth: { handler, api: auth.api } as unknown as BetterAuthHandler };
}

function okHandler(capture: (request: Request) => void): BetterAuthHandler {
  return {
    handler: async (request) => {
      capture(request);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function plainApp(auth: BetterAuthHandler): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cors, { origin: [ORIGIN], credentials: true });
  await instance.register(createBetterAuthAdapter({ auth }).plugin);
  await instance.ready();
  return instance;
}

describe("auth catch-all — only the verbs Better Auth routes", () => {
  it("TRACE, QUERY and DELETE never reach Better Auth (404)", async () => {
    const { handler, adapterAuth } = spiedAuth();
    app = await plainApp(adapterAuth);

    for (const method of ["TRACE", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/auth/get-session" });
      expect(res.statusCode, method).toBe(404);
    }
    const query = await app.inject({
      method: "QUERY",
      url: "/api/auth/get-session",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(query.statusCode).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("GET and POST still work: sign-up, sign-in, get-session", async () => {
    app = await plainApp(spiedAuth().adapterAuth);
    const creds = { email: "alice@example.com", password: "supersecure-password-123" };

    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: { ...creds, name: "Alice" },
    });
    expect(signUp.statusCode).toBe(200);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: creds,
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect(cookie).toContain("better-auth.session_token");

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect((session.json() as { user: { email: string } }).user.email).toBe(creds.email);
  });

  it("a CORS preflight still answers through @fastify/cors", async () => {
    const { handler, adapterAuth } = spiedAuth();
    app = await plainApp(adapterAuth);

    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/sign-in/email",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(handler).not.toHaveBeenCalled();
  });

  it("registers a verb a Better Auth plugin endpoint declares (SCIM-style DELETE), never a SERVER_ONLY one", async () => {
    const seen: string[] = [];
    const auth = {
      ...okHandler((request) => seen.push(request.method)),
      api: {
        getSession: Object.assign(async () => null, {
          path: "/get-session",
          options: { method: "GET" },
        }),
        deleteScimUser: Object.assign(async () => null, {
          path: "/scim/v2/Users/:userId",
          options: { method: "DELETE" },
        }),
        serverOnlyPut: Object.assign(async () => null, {
          path: "/internal",
          options: { method: "PUT", metadata: { SERVER_ONLY: true } },
        }),
      },
    } as BetterAuthHandler;
    app = Fastify({ logger: false });
    await app.register(createBetterAuthAdapter({ auth, openapi: false }).plugin);
    await app.ready();

    expect(
      (await app.inject({ method: "DELETE", url: "/api/auth/scim/v2/Users/u1" })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/auth/internal" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/auth/x" })).statusCode).toBe(404);
    expect(seen).toEqual(["DELETE"]);
  });

  it("an app using arc auth boots without the CORS QUERY/TRACE warning", async () => {
    const warns: string[] = [];
    app = await createApp({
      runtime: "memory",
      auth: { type: "betterAuth", betterAuth: createBetterAuthAdapter({ auth: realAuth() }) },
      logger: {
        level: "warn",
        stream: {
          write(chunk: string) {
            try {
              const parsed = JSON.parse(chunk) as { level?: number; msg?: string };
              if (parsed.level === 40 && parsed.msg) warns.push(parsed.msg);
            } catch {
              warns.push(chunk);
            }
          },
        },
      } as never,
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { origin: true, credentials: false },
    });
    await app.ready();
    expect(warns.filter((w) => /CORS `methods` omit/.test(w))).toEqual([]);
  });
});

describe("auth catch-all — the Request handed to Better Auth", () => {
  it("keeps the Host port in the URL (Better Auth derives baseURL and trusted origins from it)", async () => {
    let url = "";
    app = await plainApp(okHandler((request) => (url = request.url)));

    await app.inject({
      method: "GET",
      url: "/api/auth/get-session?x=1",
      headers: { host: "auth.example.com:8443" },
    });
    expect(url).toBe("http://auth.example.com:8443/api/auth/get-session?x=1");
  });

  it(`sets ${BETTER_AUTH_CLIENT_IP_HEADER} to request.ip, replacing a client-sent value`, async () => {
    let ip: string | null = "unset";
    app = await plainApp(
      okHandler((request) => (ip = request.headers.get(BETTER_AUTH_CLIENT_IP_HEADER))),
    );

    await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json", [BETTER_AUTH_CLIENT_IP_HEADER]: "6.6.6.6" },
      payload: {},
      remoteAddress: "203.0.113.7",
    });
    expect(ip).toBe("203.0.113.7");
  });

  it("Better Auth rate-limits per client IP from that header, not one shared bucket", async () => {
    const auth = betterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      baseURL: "http://localhost:4000",
      secret: "routes-test-secret-please-ignore-0123456789",
      emailAndPassword: { enabled: true },
      rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: { "/get-session": { window: 60, max: 1 } },
      },
      advanced: { ipAddress: { ipAddressHeaders: [BETTER_AUTH_CLIENT_IP_HEADER] } },
    });
    const instance = await plainApp(auth as unknown as BetterAuthHandler);
    app = instance;

    const hit = (remoteAddress: string) =>
      instance.inject({ method: "GET", url: "/api/auth/get-session", remoteAddress });
    expect((await hit("198.51.100.1")).statusCode).toBe(200);
    expect((await hit("198.51.100.1")).statusCode).toBe(429);
    expect((await hit("198.51.100.2")).statusCode).toBe(200);
  });
});
