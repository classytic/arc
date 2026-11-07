/**
 * Sensitive-session routes re-read the session from Better Auth's store (`disableCookieCache`),
 * so a revoked or banned session is refused at once instead of riding the cookie cache.
 * Real `betterAuth()` on the memory adapter, cookie cache on, `admin()` + `bearer()`.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BetterAuthAdapterOptions,
  type BetterAuthHandler,
  createBetterAuthAdapter,
} from "../../src/auth/betterAuth.js";

const ORIGIN = "http://localhost:3000";
const CACHE_MAX_AGE_S = 300;

type MemoryAdapterFactory = ReturnType<typeof memoryAdapter>;

/** Counts session-store reads: `findOne` on the `session` model. */
function countingAdapter(): { factory: MemoryAdapterFactory; sessionReads: () => number } {
  let reads = 0;
  const base = memoryAdapter({ user: [], session: [], account: [], verification: [] });
  const factory = ((options: Parameters<MemoryAdapterFactory>[0]) => {
    const adapter = base(options);
    return new Proxy(adapter, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "findOne" || typeof value !== "function") return value;
        return (args: { model: string }) => {
          if (args.model === "session") reads++;
          return value.call(target, args);
        };
      },
    });
  }) as MemoryAdapterFactory;
  return { factory, sessionReads: () => reads };
}

function realAuth(database: MemoryAdapterFactory) {
  return betterAuth({
    database,
    baseURL: "http://localhost:4000",
    secret: "sensitive-session-test-secret-0123456789",
    trustedOrigins: [ORIGIN],
    emailAndPassword: { enabled: true, autoSignIn: true },
    session: { cookieCache: { enabled: true, maxAge: CACHE_MAX_AGE_S } },
    plugins: [admin(), bearer()],
  });
}

type RealAuth = ReturnType<typeof realAuth>;

let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
});

async function setup(adapterOptions: Partial<BetterAuthAdapterOptions> = {}) {
  const store = countingAdapter();
  const auth = realAuth(store.factory);
  const ba = createBetterAuthAdapter({
    auth: auth as unknown as BetterAuthHandler,
    openapi: false,
    ...adapterOptions,
  });
  const instance = Fastify({ logger: false });
  await instance.register(ba.plugin);
  const ok = async () => ({ ok: true });
  instance.get("/normal", { preHandler: [ba.authenticate] }, ok);
  instance.get("/account", { preHandler: [ba.authenticate, ba.requireSensitiveSession] }, ok);
  instance.get("/admin/users/:id", { preHandler: [ba.authenticate] }, ok);
  instance.get("/administrator", { preHandler: [ba.authenticate] }, ok);
  await instance.ready();
  app = instance;

  const res = await instance.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json", origin: ORIGIN },
    payload: { email: "alice@example.com", password: "supersecure-password-123", name: "Alice" },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  expect(cookie).toContain("session_data"); // the cookie cache is in play
  const body = res.json() as { token: string; user: { id: string } };
  return {
    app: instance,
    auth,
    cookie,
    bearerToken: String(res.headers["set-auth-token"]),
    sessionToken: body.token,
    userId: body.user.id,
    sessionReads: store.sessionReads,
  };
}

const get = (instance: FastifyInstance, url: string, headers: Record<string, string>) =>
  instance.inject({ method: "GET", url, headers }).then((r) => r.statusCode);

async function revoke(auth: RealAuth, sessionToken: string) {
  await (await auth.$context).internalAdapter.deleteSession(sessionToken);
}

describe("sensitive-session routes — revocation", () => {
  it("a revoked cookie session is refused at once on a sensitive route; a normal route keeps it until the cache expires", async () => {
    const s = await setup({ sensitivePaths: ["/admin"] });
    const headers = { cookie: s.cookie };
    expect(await get(s.app, "/account", headers)).toBe(200);
    expect(await get(s.app, "/admin/users/1", headers)).toBe(200);

    await revoke(s.auth, s.sessionToken);

    expect(await get(s.app, "/account", headers)).toBe(401);
    expect(await get(s.app, "/admin/users/1", headers)).toBe(401);
    // Documented: the default path trusts Better Auth's cookie cache until `maxAge`.
    expect(await get(s.app, "/normal", headers)).toBe(200);
    expect(await get(s.app, "/administrator", headers)).toBe(200); // prefix matches on `/` only

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (CACHE_MAX_AGE_S + 1) * 1000);
    expect(await get(s.app, "/normal", headers)).toBe(401);
  });

  it("a revoked bearer session is refused on a sensitive route; a live one passes", async () => {
    const s = await setup({ sensitivePaths: ["/admin"] });
    const headers = { authorization: `Bearer ${s.bearerToken}` };
    expect(await get(s.app, "/account", headers)).toBe(200);
    expect(await get(s.app, "/admin/users/1", headers)).toBe(200);

    await revoke(s.auth, s.sessionToken);

    expect(await get(s.app, "/account", headers)).toBe(401);
    expect(await get(s.app, "/admin/users/1", headers)).toBe(401);
  });

  it("a 401 carries arc's auth contract", async () => {
    const s = await setup();
    await revoke(s.auth, s.sessionToken);
    const res = await s.app.inject({
      method: "GET",
      url: "/account",
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "arc.unauthorized", status: 401 });
  });
});

describe("sensitive-session routes — banned users", () => {
  it("a banned user is refused (403) on a sensitive route while the cached session still passes elsewhere", async () => {
    const s = await setup({ sensitivePaths: ["/admin"] });
    // Banned out of band (no session revocation), so only the ban rule can refuse it.
    await (await s.auth.$context).internalAdapter.updateUser(s.userId, { banned: true });

    for (const headers of [{ cookie: s.cookie }, { authorization: `Bearer ${s.bearerToken}` }]) {
      const res = await s.app.inject({ method: "GET", url: "/account", headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "arc.forbidden", status: 403 });
      expect(await get(s.app, "/admin/users/1", headers)).toBe(403);
    }
    expect(await get(s.app, "/normal", { cookie: s.cookie })).toBe(200);
  });

  it("an expired ban is not a ban (Better Auth's rule)", async () => {
    const s = await setup();
    await (await s.auth.$context).internalAdapter.updateUser(s.userId, {
      banned: true,
      banExpires: new Date(Date.now() - 1000),
    });
    expect(await get(s.app, "/account", { cookie: s.cookie })).toBe(200);
  });
});

describe("sensitive-session routes — cost and defaults", () => {
  it("costs one session-store read per sensitive request; a cookie-cache hit costs none", async () => {
    const s = await setup({ sensitivePaths: ["/admin"] });
    const headers = { cookie: s.cookie };
    const before = s.sessionReads();
    await get(s.app, "/normal", headers);
    expect(s.sessionReads() - before).toBe(0);

    const mid = s.sessionReads();
    await get(s.app, "/admin/users/1", headers); // prefix: the authenticate read itself
    expect(s.sessionReads() - mid).toBe(1);

    const end = s.sessionReads();
    await get(s.app, "/account", headers); // preHandler: authenticate (cache hit) + one store read
    expect(s.sessionReads() - end).toBe(1);

    // Bearer sessions never ride the cookie cache: the default read already hits the store.
    const bearer = { authorization: `Bearer ${s.bearerToken}` };
    const reads = async (url: string) => {
      const start = s.sessionReads();
      await get(s.app, url, bearer);
      return s.sessionReads() - start;
    };
    expect([
      await reads("/normal"),
      await reads("/admin/users/1"),
      await reads("/account"),
    ]).toEqual([1, 1, 2]);
  });

  it("default routes call getSession exactly as before (no query), with or without sensitivePaths", async () => {
    const getSession = vi.fn(async () => ({ user: { id: "u1" }, session: { id: "s1" } }));
    const ba = createBetterAuthAdapter({
      auth: { handler: async () => new Response(null), api: { getSession } },
      openapi: false,
      sensitivePaths: ["/admin"],
    });
    app = Fastify({ logger: false });
    await app.register(ba.plugin);
    app.get("/normal", { preHandler: [ba.authenticate] }, async () => ({ ok: true }));
    app.get("/admin/x", { preHandler: [ba.authenticate] }, async () => ({ ok: true }));
    await app.ready();

    expect(await get(app, "/normal", {})).toBe(200);
    expect(getSession).toHaveBeenLastCalledWith({ headers: expect.any(Headers) });
    expect(await get(app, "/admin/x", {})).toBe(200);
    expect(getSession).toHaveBeenLastCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true },
    });
  });

  it("refuses a sensitivePaths entry that is not a path", () => {
    expect(() =>
      createBetterAuthAdapter({
        auth: { handler: async () => new Response(null) },
        sensitivePaths: ["admin"],
      }),
    ).toThrow(/must start with "\/"/);
  });
});
