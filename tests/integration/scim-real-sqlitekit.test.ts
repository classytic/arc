/**
 * Integration — SCIM 2.0 plugin against a REAL `@classytic/sqlitekit`
 * `SqliteRepository` (better-sqlite3 + drizzle, in-memory).
 *
 * No mocks. arc's SCIM plugin calls `repo.bulkWrite([{ replaceOne }])`
 * for PUT and `repo.findOneAndUpdate(filter, ops)` for PATCH; sqlitekit
 * 0.4+ ships both. This test is the kit-conformance proof that arc's
 * SCIM call shapes match sqlitekit's actual op signatures end-to-end.
 *
 * Each test scenario reuses one fresh in-memory DB. After every test
 * we close Fastify and the SQLite handle so iterations don't leak.
 */

import { randomUUID } from "node:crypto";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scimPlugin } from "../../src/scim/index.js";

// ──────────────────────────────────────────────────────────────────────
// Drizzle schema — minimal users table tuned to exercise SCIM mappings
// ──────────────────────────────────────────────────────────────────────

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  isActive: integer("isActive", { mode: "boolean" }),
  // Nullable column — used to prove PUT (full replace) writes explicit
  // NULL when the SCIM payload omits it.
  department: text("department"),
  // JSON-ish text column — used for the $push rejection test.
  tags: text("tags"),
});

const DDL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    isActive INTEGER,
    department TEXT,
    tags TEXT
  );
`;

type UserDoc = {
  id: string;
  email: string;
  name?: string | null;
  isActive?: boolean | null;
  department?: string | null;
  tags?: string | null;
};

const TOKEN = "scim-real-test-token";
const auth = (token: string = TOKEN) => ({ authorization: `Bearer ${token}` });

interface Setup {
  app: FastifyInstance;
  db: Database.Database;
  repo: SqliteRepository<UserDoc>;
}

async function buildSetup(): Promise<Setup> {
  const db = new Database(":memory:");
  db.exec(DDL);
  const drizzleDb = drizzle(db);
  const repo = new SqliteRepository<UserDoc>({
    db: drizzleDb,
    table: users,
    idField: "id",
  });
  // SCIM POST clients don't send an `id` — auto-generate one before the
  // INSERT lands. Mirrors what hosts wire on real-world tables (BA does
  // the same via its own id generator). Stays out of arc/sqlitekit so this
  // test exercises the real call path; only the schema-default gap is patched.
  repo.useMiddleware(async (ctx) => {
    if (ctx.operation === "create") {
      const data = (ctx.context as { data?: Record<string, unknown> }).data;
      if (data && typeof data === "object" && data.id == null) {
        data.id = `u_${randomUUID()}`;
      }
    }
    return ctx.next();
  });

  const app = Fastify({ logger: false });
  await app.register(scimPlugin, {
    users: {
      resource: {
        name: "user",
        // The SCIM plugin reads `resource.adapter.repository` directly. The
        // SqliteRepository implements MinimalRepo + StandardRepo from
        // repo-core, which is exactly what arc/scim's RepositoryLike expects.
        adapter: { repository: repo as unknown as never },
      },
      mapping: {
        attributes: {
          id: "id",
          userName: "email",
          displayName: "name",
          "name.formatted": "name",
          "emails.value": "email",
          active: "isActive",
          // Pass-through: SCIM clients can address `department` and `tags`
          // by their bare attribute names.
          department: "department",
          tags: "tags",
        },
      },
    },
    bearer: TOKEN,
  });
  await app.ready();
  return { app, db, repo };
}

describe("SCIM 2.0 plugin — real @classytic/sqlitekit SqliteRepository", () => {
  let setup: Setup;

  beforeEach(async () => {
    setup = await buildSetup();
  });

  afterEach(async () => {
    await setup.app.close();
    setup.db.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. POST /scim/v2/Users — create lands in real SQLite
  // ────────────────────────────────────────────────────────────────────

  it("POST /Users persists a row that's queryable via direct SQL", async () => {
    const res = await setup.app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "alice@acme.com",
        displayName: "Alice Smith",
        active: true,
        department: "Engineering",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.userName).toBe("alice@acme.com");
    const id = body.id as string;
    expect(typeof id).toBe("string");

    // Direct DB query — bypasses the kit entirely. If the row isn't here,
    // SCIM lied about persisting it.
    const row = setup.db
      .prepare("SELECT id, email, name, isActive, department FROM users WHERE id = ?")
      .get(id) as
      | {
          id: string;
          email: string;
          name: string | null;
          isActive: number | null;
          department: string | null;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.email).toBe("alice@acme.com");
    expect(row?.name).toBe("Alice Smith");
    expect(row?.isActive).toBe(1);
    expect(row?.department).toBe("Engineering");
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. GET /scim/v2/Users with filter — userName eq "..."
  // ────────────────────────────────────────────────────────────────────

  it("GET /Users with filter narrows results to the matching row", async () => {
    await setup.repo.create({
      id: "u_alice",
      email: "alice@acme.com",
      name: "Alice",
      isActive: true,
    });
    await setup.repo.create({
      id: "u_bob",
      email: "bob@other.com",
      name: "Bob",
      isActive: true,
    });

    const res = await setup.app.inject({
      method: "GET",
      url: '/scim/v2/Users?filter=userName eq "alice@acme.com"',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalResults).toBe(1);
    expect(body.Resources).toHaveLength(1);
    expect(body.Resources[0].userName).toBe("alice@acme.com");
    expect(body.Resources[0].id).toBe("u_alice");
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. PATCH /scim/v2/Users/:id — replace op fires findOneAndUpdate
  // ────────────────────────────────────────────────────────────────────

  it("PATCH replace on displayName drives sqlitekit findOneAndUpdate", async () => {
    await setup.repo.create({
      id: "u_carol",
      email: "carol@acme.com",
      name: "Carol",
      isActive: true,
    });

    const res = await setup.app.inject({
      method: "PATCH",
      url: "/scim/v2/Users/u_carol",
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "displayName", value: "Carol Updated" }],
      },
    });
    expect(res.statusCode).toBe(200);

    const row = setup.db.prepare("SELECT name FROM users WHERE id = ?").get("u_carol") as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("Carol Updated");
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. PUT /scim/v2/Users/:id — full replace nulls omitted columns
  // ────────────────────────────────────────────────────────────────────

  it("PUT (full replace) NULLs out columns omitted from the SCIM payload", async () => {
    // Seed with department populated. PUT must wipe it because the new
    // payload omits `department`. This is the canonical SCIM 2.0 PUT
    // contract (RFC 7644 §3.5.1) — anything else is a partial overwrite.
    await setup.repo.create({
      id: "u_dave",
      email: "dave@acme.com",
      name: "Dave",
      isActive: true,
      department: "Sales",
    });

    const res = await setup.app.inject({
      method: "PUT",
      url: "/scim/v2/Users/u_dave",
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "dave@acme.com",
        displayName: "Dave Replaced",
        active: false,
        // department intentionally OMITTED — must be NULLed via replaceOne.
      },
    });
    expect(res.statusCode).toBe(200);

    const row = setup.db
      .prepare("SELECT email, name, isActive, department FROM users WHERE id = ?")
      .get("u_dave") as
      | { email: string; name: string; isActive: number; department: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.email).toBe("dave@acme.com");
    expect(row?.name).toBe("Dave Replaced");
    expect(row?.isActive).toBe(0);
    // The load-bearing assertion: omitted column is NULL after PUT.
    // If `department` is still "Sales", arc's bulkWrite([{ replaceOne }])
    // didn't translate to sqlitekit's replaceById path correctly.
    expect(row?.department).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. DELETE /scim/v2/Users/:id — row gone
  // ────────────────────────────────────────────────────────────────────

  it("DELETE /Users/:id removes the row from SQLite", async () => {
    await setup.repo.create({
      id: "u_erin",
      email: "erin@acme.com",
      name: "Erin",
      isActive: true,
    });

    const res = await setup.app.inject({
      method: "DELETE",
      url: "/scim/v2/Users/u_erin",
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);

    const row = setup.db.prepare("SELECT COUNT(*) as c FROM users WHERE id = ?").get("u_erin") as {
      c: number;
    };
    expect(row.c).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. PATCH $push on JSON column — sqlitekit must reject; SCIM 400
  // ────────────────────────────────────────────────────────────────────
  //
  // sqlitekit doesn't support $push/$pull on JSON-encoded text columns
  // through `findOneAndUpdate` (the operator-shaped path). arc's SCIM
  // plugin catches the throw and surfaces a 400 with `scimType:
  // "invalidValue"` instead of silently dropping the operation.

  it("PATCH add to a JSON-encoded column surfaces a 400 invalidValue", async () => {
    await setup.repo.create({
      id: "u_finn",
      email: "finn@acme.com",
      name: "Finn",
      isActive: true,
      tags: JSON.stringify(["alpha"]),
    });

    const res = await setup.app.inject({
      method: "PATCH",
      url: "/scim/v2/Users/u_finn",
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          // SCIM `add` on a multi-valued attribute compiles to $push in arc.
          { op: "add", path: "tags", value: ["beta"] },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    expect(body.scimType).toBe("invalidValue");
  });
});
