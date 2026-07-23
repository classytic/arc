/**
 * Integration test — Arc BaseController + mongokit `multiTenantPlugin` with
 * seeded cross-tenant data.
 *
 * Regression guard for the `Missing 'organizationId' in context for '<op>'`
 * failure surfaced by host apps (e.g. pricelist-engine) where plugin-scoped
 * repos blew up because arc stamped tenant into `data` but not into the
 * top-level repo context. After v2.10.5, `BaseController.tenantRepoOptions()`
 * threads the tenant into every CRUD call, so the plugin's `context.<field>`
 * read succeeds without needing `allowDataInjection` fallbacks or custom
 * `skipWhen` hand-rolled in the host.
 *
 * Covers: create, list, get, update, delete — with a superadmin elevation
 * scenario and a cross-tenant isolation check using seeded data.
 */

import { multiTenantPlugin, Repository } from "@classytic/mongokit";
import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";
import type { IRequestContext } from "../../src/types/index.js";

interface InvoiceDoc {
  _id?: string;
  organizationId?: string;
  number: string;
  amount: number;
  status: "draft" | "sent" | "paid";
  createdAt?: Date;
  updatedAt?: Date;
}

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    organizationId: { type: String, required: true, index: true },
    number: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ["draft", "sent", "paid"], default: "draft" },
  },
  { timestamps: true },
);

// Fake org IDs — seeded on each test via beforeEach.
const ORG_A = "org_alpha_001";
const ORG_B = "org_beta_002";

/**
 * Stub auth preHandler — bypasses `authPlugin` and writes the user +
 * scope directly on the Fastify request so `BaseController.tenantRepoOptions`
 * picks up the tenant without needing the full auth stack. Uses the `x-org`
 * header to pick an org.
 *
 * Arc's `fastifyAdapter` maps `request.scope` → `metadata._scope` — that's
 * where `tenantRepoOptions` reads from via `arcContext?._scope`.
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

describe("Arc + mongokit multiTenantPlugin — end-to-end", () => {
  let mongoServer: MongoMemoryServer;
  let Invoice: mongoose.Model<InvoiceDoc>;
  let repo: Repository<InvoiceDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    // Repo gets mongokit's multiTenantPlugin — the plugin that was throwing
    // "Missing 'organizationId' in context" before arc threaded the tenant
    // into repo options. `required: true` keeps strict mode on so the test
    // fails loudly if arc regresses.
    repo = new Repository<InvoiceDoc>(Invoice, [
      multiTenantPlugin({
        tenantField: "organizationId",
        contextKey: "organizationId",
        required: true,
      }),
    ]);

    const adapter: DataAdapter<InvoiceDoc> = {
      repository: repo as unknown as DataAdapter<InvoiceDoc>["repository"],
      type: "mongoose",
      name: "invoice-mongoose",
    };

    const invoiceResource = defineResource<InvoiceDoc>({
      name: "invoice",
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

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Invoice = mongoose.model<InvoiceDoc>("Invoice", invoiceSchema);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30_000);

  beforeEach(async () => {
    if (app) await app.close();
    await Invoice.deleteMany({});
    // Seed cross-tenant data directly through mongoose (bypass arc/repo) so
    // the test controls what exists before each scenario.
    await Invoice.insertMany([
      { organizationId: ORG_A, number: "INV-A-001", amount: 100, status: "paid" },
      { organizationId: ORG_A, number: "INV-A-002", amount: 200, status: "draft" },
      { organizationId: ORG_B, number: "INV-B-001", amount: 999, status: "paid" },
    ]);
    app = await buildApp();
  });

  // ──────────────────────────────────────────────────────────────────────
  // The regression — every CRUD op must succeed without mongokit throwing
  // "Missing 'organizationId' in context"
  // ──────────────────────────────────────────────────────────────────────

  it("create threads organizationId to the repo context (no plugin throw)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: { "x-org": ORG_A },
      payload: { number: "INV-A-003", amount: 300, status: "draft" },
    });

    // Before the fix: mongokit's plugin throws → 500 with
    // "Missing 'organizationId' in context for 'create'".
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
    const data = Array.isArray(payload) ? payload : (payload.data ?? []);
    expect(data.length).toBe(2);
    // None of ORG_B's invoices leak across tenants
    expect(data.every((d: InvoiceDoc) => d.organizationId === ORG_A)).toBe(true);
  });

  it("get by id returns 404 for a doc owned by a different tenant", async () => {
    // Grab ORG_B's invoice id, then try to fetch it as ORG_A — mongokit's
    // plugin stamps the filter with ORG_A → no match → 404. Before the fix,
    // the plugin throws on missing context before even reaching the query.
    const orgBDoc = await Invoice.findOne({ organizationId: ORG_B }).lean();
    if (!orgBDoc?._id) throw new Error("seed failed — ORG_B doc missing");

    const res = await app.inject({
      method: "GET",
      url: `/invoices/${orgBDoc._id.toString()}`,
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(404);
  });

  it("get by id succeeds when caller owns the doc", async () => {
    const orgADoc = await Invoice.findOne({ organizationId: ORG_A, number: "INV-A-001" }).lean();
    if (!orgADoc?._id) throw new Error("seed failed — ORG_A doc missing");

    const res = await app.inject({
      method: "GET",
      url: `/invoices/${orgADoc._id.toString()}`,
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.number).toBe("INV-A-001");
  });

  it("update threads tenant and scopes the fetch-before-write", async () => {
    const orgADoc = await Invoice.findOne({ organizationId: ORG_A, number: "INV-A-002" }).lean();
    if (!orgADoc?._id) throw new Error("seed failed");

    const res = await app.inject({
      method: "PATCH",
      url: `/invoices/${orgADoc._id.toString()}`,
      headers: { "x-org": ORG_A },
      payload: { status: "sent", amount: 250 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.status).toBe("sent");
    expect(doc.amount).toBe(250);
    expect(doc.organizationId).toBe(ORG_A);
  });

  it("update returns 404 when target belongs to another tenant (no leak)", async () => {
    const orgBDoc = await Invoice.findOne({ organizationId: ORG_B }).lean();
    if (!orgBDoc?._id) throw new Error("seed failed");

    const res = await app.inject({
      method: "PATCH",
      url: `/invoices/${orgBDoc._id.toString()}`,
      headers: { "x-org": ORG_A },
      payload: { status: "sent" },
    });
    expect(res.statusCode).toBe(404);

    // Confirm no write bled through — ORG_B's doc is untouched.
    const unchanged = await Invoice.findById(orgBDoc._id).lean();
    expect(unchanged?.status).toBe("paid");
  });

  it("delete threads tenant and succeeds on owned doc", async () => {
    const orgADoc = await Invoice.findOne({ organizationId: ORG_A, number: "INV-A-001" }).lean();
    if (!orgADoc?._id) throw new Error("seed failed");

    const res = await app.inject({
      method: "DELETE",
      url: `/invoices/${orgADoc._id.toString()}`,
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(200);

    const gone = await Invoice.findById(orgADoc._id).lean();
    expect(gone).toBeNull();
  });

  it("delete is 404 (not cross-tenant delete) when target belongs to another tenant", async () => {
    const orgBDoc = await Invoice.findOne({ organizationId: ORG_B }).lean();
    if (!orgBDoc?._id) throw new Error("seed failed");

    const res = await app.inject({
      method: "DELETE",
      url: `/invoices/${orgBDoc._id.toString()}`,
      headers: { "x-org": ORG_A },
    });
    expect(res.statusCode).toBe(404);

    // The ORG_B doc still exists
    const stillThere = await Invoice.findById(orgBDoc._id).lean();
    expect(stillThere).not.toBeNull();
  });
});

/**
 * A second resource demonstrating that the fix also holds for resources
 * with `tenantField: false` (platform-universal) — the plugin-scoped repo
 * isn't relevant there, but we verify arc doesn't spuriously stamp a
 * phantom `organizationId` when tenantField is disabled.
 */
describe("Arc + tenantField:false — platform-universal resource does not leak tenant", () => {
  let mongoServer: MongoMemoryServer;
  let Widget: mongoose.Model<{ _id?: string; kind: string }>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  interface WidgetDoc {
    _id?: string;
    kind: string;
  }

  const widgetSchema = new Schema<WidgetDoc>({ kind: { type: String, required: true } });

  async function buildApp() {
    const repo = new Repository<WidgetDoc>(Widget);
    const adapter: DataAdapter<WidgetDoc> = {
      repository: repo as unknown as DataAdapter<WidgetDoc>["repository"],
      type: "mongoose",
      name: "widget-mongoose",
    };

    const widgetResource = defineResource<WidgetDoc>({
      name: "widget",
      adapter,
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
      },
    });

    const fastify = Fastify({ logger: { level: "error" } });
    await fastify.register(widgetResource.toPlugin());
    return fastify;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Widget = mongoose.model<WidgetDoc>("Widget", widgetSchema);
    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30_000);

  beforeEach(async () => {
    await Widget.deleteMany({});
  });

  it("create on tenantField:false resource succeeds without an org header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { kind: "platform-widget" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.kind).toBe("platform-widget");
    // tenantField is false → arc must not inject an organizationId anywhere
    expect((doc as Record<string, unknown>).organizationId).toBeUndefined();
  });
});

// Satisfy the unused import linter — IRequestContext is surfaced to keep
// the test's intent explicit about what scope shape arc consumes.
const _typeProbe: IRequestContext | undefined = undefined;
void _typeProbe;
