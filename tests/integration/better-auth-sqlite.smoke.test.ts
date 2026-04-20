/**
 * Integration — Real better-auth + SQLite (drizzle-adapter) + arc.
 *
 * Parity canary for `tests/smoke/better-auth-mongo.smoke.test.ts`: if arc's
 * `createBetterAuthAdapter` is truly provider-agnostic, swapping BA's
 * mongodb-adapter for drizzle-adapter/sqlite must leave the HTTP contract
 * byte-identical.
 *
 * Provider choice: in-memory better-sqlite3 via drizzle-orm, spun up per
 * test so each run is isolated. Covers the vanilla email+password flow
 * (sign-up → cookie → authenticated whoami). Organization plugin parity
 * is already proven by the mongo smoke.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBetterAuthAdapter } from "../../src/auth/betterAuth.js";
import type { RequestScope } from "../../src/scope/types.js";

// ──────────────────────────────────────────────────────────────────────
// Drizzle schema — the four tables better-auth's core needs
// ──────────────────────────────────────────────────────────────────────

const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  name: text("name"),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  password: text("password"),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  idToken: text("idToken"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const DDL = [
  `CREATE TABLE user (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    image TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expiresAt INTEGER NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  `CREATE TABLE account (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    password TEXT,
    accessToken TEXT,
    refreshToken TEXT,
    accessTokenExpiresAt INTEGER,
    refreshTokenExpiresAt INTEGER,
    scope TEXT,
    idToken TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  `CREATE TABLE verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
];

// ──────────────────────────────────────────────────────────────────────

function extractCookies(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

describe("real better-auth + sqlite (drizzle-adapter) smoke — arc adapter alignment", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = new Database(":memory:");
    for (const stmt of DDL) db.exec(stmt);
    const orm = drizzle(db, { schema: { user, session, account, verification } });

    const auth = betterAuth({
      database: drizzleAdapter(orm, {
        provider: "sqlite",
        schema: { user, session, account, verification },
      }),
      baseURL: "http://localhost",
      basePath: "/api/auth",
      secret: "sqlite-smoke-secret-please-ignore-0123456789",
      emailAndPassword: {
        enabled: true,
        autoSignIn: true,
      },
    });

    app = Fastify({ logger: false });
    const { plugin, authenticate } = createBetterAuthAdapter({
      auth: auth as unknown as Parameters<typeof createBetterAuthAdapter>[0]["auth"],
    });
    await app.register(plugin);
    app.get("/whoami", { preHandler: [authenticate] }, async (request) => ({
      user: request.user,
      scope: (request as unknown as { scope: RequestScope }).scope,
    }));
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it("signs up a user and resolves session via arc adapter (scope: authenticated)", async () => {
    const signUpRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "alice@example.com",
        password: "supersecure-password-123",
        name: "Alice",
      },
    });
    expect(signUpRes.statusCode).toBe(200);

    const cookies = extractCookies(signUpRes);
    expect(cookies).toContain("better-auth.session_token");

    const meRes = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookies },
    });
    expect(meRes.statusCode).toBe(200);
    const body = meRes.json() as { user: Record<string, unknown>; scope: RequestScope };
    expect(body.user.email).toBe("alice@example.com");
    expect(body.scope.kind).toBe("authenticated");
    expect((body.scope as { userId?: string }).userId).toBeTruthy();
  }, 30_000);

  it("sign-in after sign-up produces a fresh session cookie", async () => {
    // First sign up (with autoSignIn: true, we get a session)
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "bob@example.com",
        password: "supersecure-password-456",
        name: "Bob",
      },
    });

    // Now hit the sign-in endpoint explicitly (the primary flow for returning users)
    const signInRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "bob@example.com",
        password: "supersecure-password-456",
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const cookies = extractCookies(signInRes);
    expect(cookies).toContain("better-auth.session_token");

    const meRes = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookies },
    });
    expect(meRes.statusCode).toBe(200);
    expect((meRes.json() as { user: { email: string } }).user.email).toBe("bob@example.com");
  }, 30_000);

  it("wrong password on sign-in yields a failed response and no session cookie", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "carol@example.com",
        password: "correct-password-abcd",
        name: "Carol",
      },
    });

    const badRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "carol@example.com",
        password: "wrong-password",
      },
    });
    // BA returns 4xx for invalid credentials — exact code varies but a 2xx would be wrong
    expect(badRes.statusCode).toBeGreaterThanOrEqual(400);
    const cookies = extractCookies(badRes);
    expect(cookies).not.toContain("better-auth.session_token");
  }, 30_000);

  it("unauthenticated /whoami returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/whoami" });
    expect(res.statusCode).toBe(401);
  });

  it("rows for a signed-up user actually land in the sqlite `user` table", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "dave@example.com",
        password: "supersecure-password-789",
        name: "Dave",
      },
    });
    const row = db.prepare("SELECT email, name FROM user WHERE email = ?").get("dave@example.com") as
      | { email: string; name: string }
      | undefined;
    expect(row?.email).toBe("dave@example.com");
    expect(row?.name).toBe("Dave");
    // Session row should exist too — proves auto-sign-in wrote to both tables atomically
    const sessionRow = db
      .prepare("SELECT COUNT(*) as c FROM session WHERE userId IN (SELECT id FROM user WHERE email = ?)")
      .get("dave@example.com") as { c: number };
    expect(sessionRow.c).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
