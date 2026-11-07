/**
 * Forged and tampered JWTs are refused by `authPlugin`: an unsigned (`alg: none`) token, a token
 * signed with another secret, a valid token with its payload edited, and an expired one.
 */

import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authPlugin } from "../../src/auth/authPlugin.js";

const SECRET = "a-secure-secret-that-is-at-least-32-chars-long!!";
const OTHER_SECRET = "another-secret-that-is-also-at-least-32-chars!!";

const b64 = (value: object | Buffer) =>
  Buffer.from(value instanceof Buffer ? value : JSON.stringify(value)).toString("base64url");

/** A compact JWS with an explicit header, so the algorithm is the attacker's choice. */
function token(header: object, payload: object, secret?: string): string {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = secret
    ? createHmac("sha256", secret).update(signingInput).digest()
    : Buffer.alloc(0);
  return `${signingInput}.${b64(signature)}`;
}

const claims = (extra: object = {}) => ({
  id: "u1",
  type: "access",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
  ...extra,
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});

async function build() {
  const instance = Fastify({ logger: false });
  await instance.register(authPlugin, { jwt: { secret: SECRET } });
  instance.get("/protected", { preHandler: [instance.authenticate] }, async () => ({ ok: true }));
  await instance.ready();
  app = instance;
  return instance;
}

const call = (instance: FastifyInstance, bearer: string) =>
  instance
    .inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${bearer}` } })
    .then((r) => r.statusCode);

describe("authPlugin JWT verification", () => {
  it("accepts a correctly signed token (control)", async () => {
    const instance = await build();
    expect(await call(instance, token({ alg: "HS256", typ: "JWT" }, claims(), SECRET))).toBe(200);
  });

  it.each(["none", "None", "NONE"])("refuses an unsigned token with alg %s", async (alg) => {
    const instance = await build();
    expect(await call(instance, token({ alg, typ: "JWT" }, claims()))).toBe(401);
  });

  it("refuses a token signed with a different secret", async () => {
    const instance = await build();
    expect(await call(instance, token({ alg: "HS256", typ: "JWT" }, claims(), OTHER_SECRET))).toBe(
      401,
    );
  });

  it("refuses a valid token whose payload was edited after signing", async () => {
    const instance = await build();
    const [header, , signature] = token({ alg: "HS256", typ: "JWT" }, claims(), SECRET).split(".");
    expect(await call(instance, `${header}.${b64(claims({ id: "admin" }))}.${signature}`)).toBe(
      401,
    );
  });

  it("refuses an expired token", async () => {
    const instance = await build();
    const expired = claims({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await call(instance, token({ alg: "HS256", typ: "JWT" }, expired, SECRET))).toBe(401);
  });
});
