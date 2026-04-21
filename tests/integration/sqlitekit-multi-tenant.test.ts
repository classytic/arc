/**
 * Integration test — Arc BaseController + sqlitekit `multi-tenant` plugin with
 * seeded cross-tenant data.
 *
 * Parallel to `mongokit-multi-tenant.test.ts`. Proves arc's tenant
 * threading (v2.10.5) is kit-agnostic — the same `tenantRepoOptions()`
 * helper satisfies sqlitekit's plugin, whose `resolveTenantId(context)`
 * callback reads from the top-level repo context that arc now stamps.
 *
 * Requires `@classytic/sqlitekit` >= 0.1.1 (the version that added
 * `allowDataInjection` + the full `resolveTenantId` API surface).
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import { multiTenantPlugin } from "@classytic/sqlitekit/plugins/multi-tenant";
import { timestampPlugin } from "@classytic/sqlitekit/plugins/timestamp";
import { allowPublic, defineResource } from "../../src/index.js";
import type { DataAdapter } from "../../src/adapters/index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixture — `invoices` table with an `organizationId` column
// ──────────────────────────────────────────────────────────────────────

const invoicesTable = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId").notNull(),
  number: text("number").notNull(),
  amount: integer("amount").notNull(),
  status: text("status", { enum: ["draft", "sent", "paid"] as const })
    .notNull()
    .default("draft"),
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
});
void eq; // silence drizzle's unused-export helper when not filtering

type InvoiceDoc = {
  id: string;
  organizationId: string;
  number: string;
  amount: number;
  status: "draft" | "sent" | "paid";
  createdAt?: string;
  updatedAt?: string;
};

const ORG_A = "org_alpha_001";
const ORG_B = "org_beta_002";

/**
 * Stub auth preHandler — arc's `fastifyAdapter` maps `request.scope`
 * into `metadata._scope`, where `BaseController.tenantRepoOptions`
 * reads from. Identical to the mongokit variant so the two tests
 * stay in lockstep.
 */
function fakeScopePreHandler(orgHeader: string = "x-org") {
  return async (request: {
    headers: Record<string, string | string[] | undefined>;
    user?: unknown;
    scope?: unknown;
  }): Promise<void> => {
    const orgId = request.headers[orgHeader];
    if (typeof orgId !== "string") return;
    request.user = { id: "user_test", roles: ["member"], organizationId: orgId };
    request.scope = {
      kind: "member",
      userId: "user_test",
      roles: ["member"],
      organizationId: orgId,
      organizationRole: "member",
    };
  };
}

describe("Arc + sqlitekit multiTenantPlugin — end-to-end", () => {
  let db: Database.Database;
  let repo: SqliteRepository<InvoiceDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp(seed = true): Promise<ReturnType<typeof Fastify>> {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY,
        organizationId TEXT NOT NULL,
        number TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    const drizzleDb = drizzle(db);

    repo = new SqliteRepository<InvoiceDoc>({
      db: drizzleDb,
      table: invoicesTable,
      plugins: [
        timestampPlugin(),
        multiTenantPlugin({
          tenantField: "organizationId",
          // Read tenant from top-level repo context — this is what arc now
          // stamps via `tenantRepoOptions()`. Before 2.10.5 the callback
          // would return undefined and the plugin would throw on writes.
          resolveTenantId: (ctx) => {
            const val = (ctx as { organizationId?: string }).organizationId;
            return typeof val === "string" ? val : undefined;
          },
          requireOnWrite: true,
        }),
      ],
    });

    if (seed) {
      // Seed cross-tenant data directly through the driver (bypass arc/repo) —
      // mirrors the mongokit test's Invoice.insertMany pattern.
      const seedStmt = db.prepare(
        "INSERT INTO invoices (id, organizationId, number, amount, status) VALUES (?, ?, ?, ?, ?)",
      );
      seedStmt.run("inv-a-1", ORG_A, "INV-A-001", 100, "paid");
      seedStmt.run("inv-a-2", ORG_A, "INV-A-002", 200, "draft");
      seedStmt.run("inv-b-1", ORG_B, "INV-B-001", 999, "paid");
    }

    const adapter: DataAdapter<InvoiceDoc> = {
      repository: repo as unknown as DataAdapter<InvoiceDoc>["repository"],
      type: "drizzle",
      name: "invoice-drizzle",
    };

    const invoiceResource = defineResource<InvoiceDoc>({
      name: "invoice",
      idField: "id",
      adapter,
      tenantField: "organizationId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      middlewares: {
        list: [fakeScopePreHandler() as never],
        get: [fakeScopePreHandler() as never],
        create: [fakeScopePreHandler() as never],
        update: [fakeScopePreHandler() as never],
        delete: [fakeScopePreHandler() as never],
      },
    });

    const fastify = Fastify({ logger: { level: "error" } });
    await fastify.register(invoiceResource.toPlugin());
    return fastify;
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  // ──────────────────────────────────────────────────────────────────
  // Same scenarios as the mongokit test — kit-agnostic
  // ──────────────────────────────────────────────────────────────────

  it("create threads organizationId to the sqlitekit plugin (no throw)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: { "x-org": ORG_A },
      payload: { id: "inv-a-3", number: "INV-A-003", amount: 300, status: "draft" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.organizationId).toBe(ORG_A);
    expect(doc.number).toBe("INV-A-003");
  });

  it("list scopes results by caller's organizationId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/invoices",
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    const payload = body.data ?? body;
    const docs = Array.isArray(payload) ? payload : (payload.docs ?? []);
    expect(docs.length).toBe(2);
    expect(docs.every((d: InvoiceDoc) => d.organizationId === ORG_A)).toBe(true);
  });

  it("get by id returns 404 for a doc owned by a different tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/invoices/inv-b-1",
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(404);
  });

  it("get by id succeeds when caller owns the doc", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/invoices/inv-a-1",
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.number).toBe("INV-A-001");
  });

  it("update threads tenant and scopes the fetch-before-write", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/invoices/inv-a-2",
      headers: { "x-org": ORG_A },
      payload: { status: "sent", amount: 250 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.status).toBe("sent");
    expect(doc.amount).toBe(250);
  });

  it("update returns 404 when target belongs to another tenant (no leak)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/invoices/inv-b-1",
      headers: { "x-org": ORG_A },
      payload: { status: "sent" },
    });
    expect(res.statusCode).toBe(404);

    // ORG_B's row is untouched
    const row = db.prepare("SELECT status FROM invoices WHERE id = ?").get("inv-b-1") as
      | { status: string }
      | undefined;
    expect(row?.status).toBe("paid");
  });

  it("delete threads tenant and succeeds on owned doc", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/invoices/inv-a-1",
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(200);

    const row = db.prepare("SELECT id FROM invoices WHERE id = ?").get("inv-a-1");
    expect(row).toBeUndefined();
  });

  it("delete is 404 (not cross-tenant delete) when target belongs to another tenant", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/invoices/inv-b-1",
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(404);

    const row = db.prepare("SELECT id FROM invoices WHERE id = ?").get("inv-b-1");
    expect(row).toBeDefined();
  });
});
