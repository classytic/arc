/**
 * `requireFreshSession` mirrors Better Auth's `freshSessionMiddleware`: a session older than
 * `session.freshAge` (default one day, `0` disables) is a 403, no session a 401.
 * Real `betterAuth()` on the memory adapter; time is moved with fake Date, never by editing rows.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

const ORIGIN = "http://localhost:3000";
const HOUR_MS = 60 * 60 * 1000;

let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
});

async function setup(freshAge?: number) {
  const auth = betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: "http://localhost:4000",
    secret: "fresh-session-test-secret-0123456789ab",
    trustedOrigins: [ORIGIN],
    emailAndPassword: { enabled: true, autoSignIn: true },
    // The session must outlive the clock moves below, or it expires before freshness is judged.
    session: { expiresIn: 60 * 60 * 24 * 30, ...(freshAge === undefined ? {} : { freshAge }) },
  });
  const ba = createBetterAuthAdapter({
    auth: auth as unknown as BetterAuthHandler,
    openapi: false,
  });
  const instance = Fastify({ logger: false });
  await instance.register(ba.plugin);
  const ok = async () => ({ ok: true });
  instance.get("/fresh", { preHandler: [ba.authenticate, ba.requireFreshSession] }, ok);
  instance.get("/no-authenticate", { preHandler: [ba.requireFreshSession] }, ok);
  await instance.ready();
  app = instance;

  const res = await instance.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json", origin: ORIGIN },
    payload: { email: "fresh@example.com", password: "supersecure-password-123", name: "Fresh" },
  });
  expect(res.statusCode).toBe(200);
  return { instance, cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

const status = (instance: FastifyInstance, url: string, cookie?: string) =>
  instance
    .inject({ method: "GET", url, headers: cookie ? { cookie } : {} })
    .then((r) => ({ code: r.statusCode, body: r.json() as { message?: string } }));

describe("requireFreshSession", () => {
  it("lets a just-created session through", async () => {
    const { instance, cookie } = await setup();
    expect((await status(instance, "/fresh", cookie)).code).toBe(200);
  });

  it("refuses a session older than the default freshAge (one day) with a 403", async () => {
    const { instance, cookie } = await setup();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 25 * HOUR_MS });
    const res = await status(instance, "/fresh", cookie);
    expect(res.code).toBe(403);
    expect(res.body.message).toBe("Session is not fresh");
  });

  it("honours a custom session.freshAge", async () => {
    const { instance, cookie } = await setup(60 * 60); // one hour
    expect((await status(instance, "/fresh", cookie)).code).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * HOUR_MS });
    expect((await status(instance, "/fresh", cookie)).code).toBe(403);
  });

  it("freshAge 0 disables the check, as Better Auth does", async () => {
    const { instance, cookie } = await setup(0);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 25 * HOUR_MS });
    expect((await status(instance, "/fresh", cookie)).code).toBe(200);
  });

  it("is a 401 with no session, and without authenticate before it", async () => {
    const { instance, cookie } = await setup();
    expect((await status(instance, "/fresh")).code).toBe(401);
    expect((await status(instance, "/no-authenticate", cookie)).code).toBe(401);
  });
});
