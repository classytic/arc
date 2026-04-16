/**
 * Regression test for PR: BaseController PATCH/DELETE must honor the
 * Repository's `idField` when the user did NOT explicitly set `idField`
 * on `defineResource` — relying on auto-derivation from the adapter's
 * repository.
 *
 * The PR reporter claims GET /:slug works but PATCH/DELETE /:slug return
 * 404 in this exact shape:
 *
 *   const repo = new Repository(model, [], {}, { idField: 'slug' });
 *   const adapter = createMongooseAdapter({ model, repository: repo });
 *   defineResource({ name: 'agent', prefix: '/agents', adapter });
 *   // No explicit idField on defineResource
 *
 * If arc's auto-derive at defineResource.ts:168 works, every verb should
 * resolve by slug. This test pins the contract so it can't silently
 * regress.
 */

import { Repository } from "@classytic/mongokit";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import type { ResourceDefinition } from "../../src/types/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

interface IAgent {
  _id?: mongoose.Types.ObjectId;
  slug: string;
  name: string;
  description?: string;
}

let Model: mongoose.Model<IAgent>;
let app: Awaited<ReturnType<typeof createApp>>;
let agentResource: ResourceDefinition;

// Share the Mongo lifecycle across both describe blocks so the second one
// doesn't hit `MongoNotConnectedError` after the first's afterAll tears down.
beforeAll(async () => {
  await setupTestDatabase();
}, 30_000);

afterAll(async () => {
  await teardownTestDatabase();
});

describe("BaseController — idField auto-derive from adapter.repository", () => {
  beforeAll(async () => {
    const AgentSchema = new Schema<IAgent>({
      slug: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      description: { type: String },
    });
    Model =
      (mongoose.models.AgentAutoDerive as mongoose.Model<IAgent>) ||
      mongoose.model<IAgent>("AgentAutoDerive", AgentSchema);

    // CRITICAL: Repository configured with idField='slug'.
    // defineResource below does NOT set idField — it must be auto-derived.
    const repo = new Repository<IAgent>(Model, [], {}, { idField: "slug" });

    const adapter = createMongooseAdapter<IAgent>({
      model: Model,
      // biome-ignore lint: mongokit/arc generic variance — intentional
      repository: repo as unknown as Parameters<typeof createMongooseAdapter>[0]["repository"],
    });

    agentResource = defineResource({
      name: "agent",
      prefix: "/agents",
      adapter,
      // NOTE: intentionally NOT setting idField here. The PR asserts that
      // auto-derive from repository.idField should populate this.
      permissions: {
        list: () => ({ granted: true }),
        get: () => ({ granted: true }),
        create: () => ({ granted: true }),
        update: () => ({ granted: true }),
        delete: () => ({ granted: true }),
      },
    });

    app = await createApp({
      resources: [agentResource],
    });
  }, 30_000);

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it("auto-derives idField='slug' into the resource definition", () => {
    // ResourceDefinition.idField must reflect the repository's idField.
    // This is the load-bearing behavior that makes GET/PATCH/DELETE
    // resolve by slug without the user configuring defineResource twice.
    // Pinning this directly (rather than via an app introspection API)
    // prevents a silent regression in defineResource.ts's auto-derive path.
    expect(agentResource.idField).toBe("slug");
  });

  it("POST /agents creates a new document", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { slug: "sadman", name: "Sadman" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.slug).toBe("sadman");
    expect(body.data.name).toBe("Sadman");
  });

  it("GET /agents/:slug resolves by slug", async () => {
    await Model.create({ slug: "sadman", name: "Sadman" });

    const res = await app.inject({ method: "GET", url: "/agents/sadman" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.slug).toBe("sadman");
  });

  it("PATCH /agents/:slug resolves by slug (the PR's reported bug)", async () => {
    await Model.create({ slug: "sadman", name: "Sadman", description: "old" });

    const res = await app.inject({
      method: "PATCH",
      url: "/agents/sadman",
      payload: { description: "new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.description).toBe("new");

    // Verify the update landed in Mongo.
    const reloaded = await Model.findOne({ slug: "sadman" });
    expect(reloaded?.description).toBe("new");
  });

  it("DELETE /agents/:slug resolves by slug (the PR's reported bug)", async () => {
    await Model.create({ slug: "sadman", name: "Sadman" });

    const res = await app.inject({ method: "DELETE", url: "/agents/sadman" });
    expect(res.statusCode).toBe(200);

    // Verify the row is gone.
    const reloaded = await Model.findOne({ slug: "sadman" });
    expect(reloaded).toBeNull();
  });

  it("PATCH with a non-existent slug returns 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/agents/does-not-exist",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH with a slug that LOOKS like an ObjectId still routes as a slug", async () => {
    // Anti-regression: a 24-char hex string must not get interpreted as
    // _id when the repo's idField is 'slug'. A silent ObjectId cast here
    // was one of the suspected root causes in the PR.
    await Model.create({ slug: "69d81274a139ab970474bef8", name: "Hexy" });

    const res = await app.inject({
      method: "PATCH",
      url: "/agents/69d81274a139ab970474bef8",
      payload: { description: "matched by slug, not _id" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.description).toBe("matched by slug, not _id");
  });

  it("DELETE with a slug that does not exist returns 404 cleanly", async () => {
    const res = await app.inject({ method: "DELETE", url: "/agents/ghost" });
    expect(res.statusCode).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The sniffer-orchestrator scenario — asymmetric permissions
//
// This reproduces exactly what the PR reporter saw: GET works, PATCH 404s
// against the SAME slug. The asymmetry is NOT in idField — it's that the
// `update` permission injects a `filters` that excludes the doc, while
// `get` permission does not. `fetchWithAccessControl` merges those filters
// into the DB lookup, so PATCH's compound filter `{ slug, ...filters }`
// misses the doc and returns null → 404 "Resource not found".
//
// Arc's behavior here is correct (security-first — filtered docs must be
// invisible) but the error message is misleading: users see "Resource not
// found" and reach for "idField bug" when the real cause is their own
// permission filter.
// ────────────────────────────────────────────────────────────────────────

describe("fetchWithAccessControl — permission-filter asymmetry is the real 404", () => {
  interface ITenantAgent {
    _id?: mongoose.Types.ObjectId;
    slug: string;
    name: string;
    projectId?: string | null;
  }

  let TenantModel: mongoose.Model<ITenantAgent>;
  let tenantApp: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    const schema = new Schema<ITenantAgent>({
      slug: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      projectId: { type: String, default: null },
    });
    TenantModel =
      (mongoose.models.TenantAgent as mongoose.Model<ITenantAgent>) ||
      mongoose.model<ITenantAgent>("TenantAgent", schema);

    const repo = new Repository<ITenantAgent>(TenantModel, [], {}, { idField: "slug" });
    const adapter = createMongooseAdapter<ITenantAgent>({
      model: TenantModel,
      // biome-ignore lint: mongokit/arc generic variance
      repository: repo as unknown as Parameters<typeof createMongooseAdapter>[0]["repository"],
    });

    tenantApp = await createApp({
      resources: [
        defineResource({
          name: "tenant-agent",
          prefix: "/tenant-agents",
          adapter,
          permissions: {
            // Read = wide open. Same as the PR reporter's `allowPublic()`.
            list: () => ({ granted: true }),
            get: () => ({ granted: true }),
            // Write = granted, BUT injects a filter that excludes docs with
            // projectId set. Mimics the reporter's `requireApiKeyNoProject()`.
            create: () => ({ granted: true }),
            update: () => ({ granted: true, filters: { projectId: null } }),
            delete: () => ({ granted: true, filters: { projectId: null } }),
          },
        }),
      ],
    });
  }, 30_000);

  beforeEach(async () => {
    await TenantModel.deleteMany({});
  });

  afterAll(async () => {
    await tenantApp.close();
  });

  it("GET succeeds when the doc doesn't match the write-side filter", async () => {
    await TenantModel.create({ slug: "sadman", name: "Sadman", projectId: "proj-42" });

    const res = await tenantApp.inject({ method: "GET", url: "/tenant-agents/sadman" });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH 404s on the SAME slug because update's filter excludes the doc", async () => {
    // Doc has projectId='proj-42', but update permission requires projectId===null.
    // fetchWithAccessControl builds `{ slug: 'sadman', projectId: null }` and
    // gets null back. The 404 is correct security behavior but the message
    // is misleading — it looks like an idField bug.
    await TenantModel.create({ slug: "sadman", name: "Sadman", projectId: "proj-42" });

    const res = await tenantApp.inject({
      method: "PATCH",
      url: "/tenant-agents/sadman",
      payload: { name: "new" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH succeeds on a doc that DOES match the update filter", async () => {
    // Same resource, same codepath — only the doc's projectId differs.
    // Proves the update handler itself is healthy; only the compound
    // filter decides the outcome.
    await TenantModel.create({ slug: "sadman", name: "Sadman", projectId: null });

    const res = await tenantApp.inject({
      method: "PATCH",
      url: "/tenant-agents/sadman",
      payload: { name: "new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("new");
  });
});
