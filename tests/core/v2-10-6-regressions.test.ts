/**
 * Reviewer-flagged regressions against 2.10.6's auto-systemManaged fix.
 *
 * Two claims to verify:
 *
 * 1. **Elevated cross-tenant create broken.** An elevated admin with no
 *    target org used to be able to `POST /invoices { organizationId: 'org_x' }`
 *    and have that value survive through to the DB. After 2.10.6:
 *    - `defineResource` auto-injects `fieldRules[tenantField].systemManaged = true`
 *    - `BodySanitizer` strips systemManaged fields unconditionally
 *    - `BaseController.create` only re-stamps from scope when the scope has
 *      an orgId (`createOrgId` is truthy)
 *
 *    Net effect: elevated-without-org's body-supplied tenant is stripped and
 *    never restored. Result: doc is created with `organizationId = undefined`.
 *
 *    This contradicts both `createTenantInjection` in the multi-tenant preset
 *    (which explicitly SKIPS stamping for elevated-without-org, expecting the
 *    body value to survive) AND the documented semantics of cross-tenant
 *    admin writes.
 *
 * 2. **AccessControl threw a 500 on cross-tenant reads for plugin-scoped repos.**
 *    On a cross-tenant read against a mongokit repo wired with
 *    `multiTenantPlugin({ required: true })`, the 2.10.5 diagnostic path
 *    extracted `repository.getOne` without binding `this`, so the call
 *    threw `Cannot read properties of undefined (reading '_buildContext')`
 *    — a 500 response, not a clean 404. This test asserts the 500 is gone
 *    and the response is a clean 404.
 *
 *    **Documented limitation (not a bug):** the `details.code` remains
 *    `NOT_FOUND` (not `ORG_SCOPE_DENIED`) for plugin-scoped cross-tenant
 *    reads. Returning `ORG_SCOPE_DENIED` would leak "this doc exists in
 *    another tenant" to a caller who shouldn't know that. The 404 shape
 *    is end-user-correct; the ambiguity is intentional for plugin-scoped
 *    repos that enforce `required: true`. Non-plugin-scoped repos still
 *    get the full `ORG_SCOPE_DENIED` signal via the unscoped probe path.
 *
 * These tests prove claim #1's regression and claim #2's 500 are both
 * real. The fixes follow.
 */

import { multiTenantPlugin, Repository } from "@classytic/mongokit";
import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";

interface InvoiceDoc {
  _id?: string;
  organizationId?: string;
  number: string;
  amount: number;
}

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    organizationId: { type: String, index: true },
    number: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { timestamps: true },
);

const ORG_A = "org_alpha";
const ORG_B = "org_beta";

/**
 * Fake preHandler — stamps an ELEVATED scope with NO target org so we
 * hit the exact case the reviewer described.
 */
function elevatedNoTargetOrg() {
  return async (request: {
    headers: Record<string, string | string[] | undefined>;
    user?: unknown;
    scope?: unknown;
  }): Promise<void> => {
    if (request.headers["x-elevated"] !== "1") return;
    request.user = { id: "admin_1", roles: ["superadmin"] };
    request.scope = {
      kind: "elevated",
      userId: "admin_1",
      roles: ["superadmin"],
      // Note: NO organizationId — elevated admin with no pinned tenant.
      // `getOrgId(scope)` returns undefined for this shape.
    };
  };
}

function memberOf(orgHeader = "x-org") {
  return async (request: {
    headers: Record<string, string | string[] | undefined>;
    user?: unknown;
    scope?: unknown;
  }): Promise<void> => {
    const orgId = request.headers[orgHeader];
    if (typeof orgId !== "string") return;
    request.user = { id: "user_m", roles: ["member"] };
    request.scope = {
      kind: "member",
      userId: "user_m",
      roles: ["member"],
      organizationId: orgId,
      organizationRole: "member",
    };
  };
}

describe("2.10.6 · regression claim #1 — elevated cross-tenant create", () => {
  let mongoServer: MongoMemoryServer;
  let Invoice: mongoose.Model<InvoiceDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    const repo = new Repository<InvoiceDoc>(Invoice, [
      multiTenantPlugin({
        tenantField: "organizationId",
        contextKey: "organizationId",
        // Non-strict so the empty tenant doesn't throw — we're testing the
        // arc-side stripping, not the mongokit plugin's requireOnWrite.
        required: false,
      }),
    ]);

    const adapter: DataAdapter<InvoiceDoc> = {
      repository: repo as unknown as DataAdapter<InvoiceDoc>["repository"],
      type: "mongoose",
      name: "invoice",
    };

    const resource = defineResource<InvoiceDoc>({
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
        create: [elevatedNoTargetOrg() as never],
        list: [elevatedNoTargetOrg() as never],
      },
    });

    const fastify = Fastify({ logger: { level: "error" } });
    await fastify.register(resource.toPlugin());
    return fastify;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Invoice = mongoose.model<InvoiceDoc>("RegressionInvoice", invoiceSchema);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30_000);

  beforeEach(async () => {
    if (app) await app.close();
    await Invoice.deleteMany({});
    app = await buildApp();
  });

  it("elevated admin with no target org CAN create into a chosen tenant via body (regression guard)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: { "x-elevated": "1" },
      payload: { organizationId: ORG_A, number: "INV-CROSS-001", amount: 500 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const doc = body.data ?? body;

    // EXPECTED: the caller-supplied tenant survives for elevated-no-org.
    // After the 2.10.6 auto-systemManaged default, the strip happens
    // unconditionally and is never restored → doc.organizationId is
    // undefined. This assertion is what will fail before the fix.
    expect(doc.organizationId).toBe(ORG_A);

    // Belt-and-suspenders: verify it landed in the DB, not just the response.
    const inDb = await Invoice.findById(doc._id).lean();
    expect(inDb?.organizationId).toBe(ORG_A);
  });
});

describe("2.10.6 · regression claim #2 — cross-tenant read diagnostic with plugin-scoped repo", () => {
  let mongoServer: MongoMemoryServer;
  let Invoice: mongoose.Model<InvoiceDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    const repo = new Repository<InvoiceDoc>(Invoice, [
      // Plugin-scoped repo: mongokit rejects unscoped `getOne()` with
      // "Missing 'organizationId' in context". This is what triggers the
      // diagnostic-loss path in AccessControl.fetchDetailed.
      multiTenantPlugin({
        tenantField: "organizationId",
        contextKey: "organizationId",
        required: true,
      }),
    ]);

    const adapter: DataAdapter<InvoiceDoc> = {
      repository: repo as unknown as DataAdapter<InvoiceDoc>["repository"],
      type: "mongoose",
      name: "invoice-scoped",
    };

    const resource = defineResource<InvoiceDoc>({
      name: "invoice-scoped",
      prefix: "/scoped-invoices",
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
        get: [memberOf() as never],
        list: [memberOf() as never],
      },
    });

    const fastify = Fastify({ logger: { level: "error" } });
    await fastify.register(resource.toPlugin());
    return fastify;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Invoice = mongoose.model<InvoiceDoc>("RegressionScopedInvoice", invoiceSchema);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30_000);

  beforeEach(async () => {
    if (app) await app.close();
    await Invoice.deleteMany({});
    await Invoice.insertMany([
      { organizationId: ORG_A, number: "INV-A-1", amount: 100 },
      { organizationId: ORG_B, number: "INV-B-1", amount: 999 },
    ]);
    app = await buildApp();
  });

  it("cross-tenant read against a plugin-scoped repo returns a clean 404 (not a 500)", async () => {
    const orgBDoc = await Invoice.findOne({ organizationId: ORG_B }).lean();
    if (!orgBDoc?._id) throw new Error("seed failed");

    const res = await app.inject({
      method: "GET",
      url: `/scoped-invoices/${orgBDoc._id.toString()}`,
      headers: { "x-org": ORG_A },
    });

    // Primary regression: before this release the diagnostic probe
    // threw `Cannot read properties of undefined (reading '_buildContext')`
    // (mongokit's method bound to `undefined`). Now it's a clean 404.
    expect(res.statusCode).toBe(404);

    // Documented limitation: for plugin-scoped repos that enforce
    // `required: true`, the diagnostic code stays `NOT_FOUND` rather
    // than `ORG_SCOPE_DENIED`. See the file-header docstring above —
    // returning `ORG_SCOPE_DENIED` would leak "exists in another tenant"
    // to a caller who shouldn't know that. Hosts that need the finer
    // signal should either drop `required: true` on the plugin or use
    // the AccessControl API directly in their controller override.
    const body = res.json();
    const code = body.details?.code ?? body.code;
    expect(code).toBe("arc.not_found");
  });
});
