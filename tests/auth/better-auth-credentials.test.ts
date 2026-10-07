/**
 * `credentials` — non-session credentials by `Authorization` scheme (a paired device, an API key).
 * A registered scheme is authenticated by its verifier ONLY, never by the session; `Bearer` stays
 * the session's.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";
import type { RequestScope } from "../../src/scope/types.js";

const getSession = vi.fn(async () => ({ user: { id: "user-1", role: "user" }, session: { id: "s1" } }));
const auth = { handler: async () => new Response("{}"), api: { getSession } } as unknown as BetterAuthHandler;
const device: RequestScope = { kind: "service", clientId: "TILL-1", organizationId: "branch-a", scopes: ["device:pos-terminal"] };
const verify = vi.fn(async (value: string) => (value === "TILL-1:good" ? device : null));

describe("createBetterAuthAdapter — credentials", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    vi.clearAllMocks();
    if (app) await app.close();
  });

  async function call(authorization: string | undefined, hook: "authenticate" | "optionalAuthenticate" = "authenticate") {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({ auth, credentials: { Device: verify } });
    await app.register(plugin);
    let scope: unknown;
    app.get("/t", { preHandler: [app[hook]] }, async (request) => {
      scope = (request as unknown as { scope: unknown }).scope;
      return {};
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/t", headers: authorization ? { authorization } : {} });
    return { status: res.statusCode, scope };
  }

  it("installs the verifier's scope for its scheme, without consulting the session", async () => {
    expect(await call("Device TILL-1:good")).toEqual({ status: 200, scope: device });
    expect(verify).toHaveBeenCalledWith("TILL-1:good", expect.anything());
    expect(getSession).not.toHaveBeenCalled();
  });

  it("an invalid credential is a 401 — it never falls back to a session", async () => {
    expect((await call("Device TILL-1:bad")).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("on a public route an invalid credential leaves the caller public", async () => {
    const { status, scope } = await call("device TILL-1:bad", "optionalAuthenticate");
    expect(status).toBe(200);
    expect(scope).not.toMatchObject({ kind: "service" });
  });

  it("other schemes still go to the session", async () => {
    await call("Bearer session-token");
    expect(getSession).toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses to register Bearer or a malformed scheme", () => {
    expect(() => createBetterAuthAdapter({ auth, credentials: { bearer: verify } })).toThrow(/session/);
    expect(() => createBetterAuthAdapter({ auth, credentials: { "Bad Scheme": verify } })).toThrow(/scheme/);
  });
});
