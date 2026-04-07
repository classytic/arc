/**
 * PermissionResult.scope → tenantField isolation E2E
 *
 * Regression test for the reported issue: when a custom permission check
 * (e.g. API key auth) tries to isolate tenants via `filters`, it works for
 * `get` by ID but silently bypasses the org filter on `list` because
 * `tenantField` filtering reads from `metadata._scope`, NOT from
 * `_policyFilters`.
 *
 * The fix: `PermissionResult.scope` — the permission check returns a
 * `service` scope alongside `granted: true`, Arc writes it to `request.scope`,
 * and the full BaseController pipeline applies tenant isolation automatically.
 *
 * This test proves:
 * 1. API key for Company-A only sees Company-A items
 * 2. API key for Company-B only sees Company-B items
 * 3. Missing API key → 401
 * 4. Bad API key → 401
 * 5. Cross-tenant get by ID → 404 (not 200 with wrong org's data)
 * 6. No separate auth plugin needed — the permission check IS the auth layer
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import type { PermissionCheck } from "../../src/permissions/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();

const CLIENTS: Record<string, { clientId: string; organizationId: string }> = {
  "key-acme": { clientId: "client-1", organizationId: ORG_A },
  "key-globex": { clientId: "client-2", organizationId: ORG_B },
};

/**
 * The pattern under test: a custom API-key permission check that installs
 * a `service` scope via PermissionResult.scope. No separate auth plugin,
 * no faking a user identity, no manual tenant filter plumbing.
 */
function requireApiKey(): PermissionCheck {
  return async ({ request }) => {
    const apiKey = request.headers["x-api-key"] as string | undefined;
    if (!apiKey) return { granted: false, reason: "Missing API key" };

    const client = CLIENTS[apiKey];
    if (!client) return { granted: false, reason: "Invalid API key" };

    return {
      granted: true,
      scope: {
        kind: "service",
        clientId: client.clientId,
        organizationId: client.organizationId,
        scopes: ["jobs:read", "jobs:write"],
      },
    };
  };
}

describe("PermissionResult.scope → tenantField isolation", () => {
  let app: FastifyInstance;
  let Job: mongoose.Model<{ title: string; companyId: string }>;

  beforeAll(async () => {
    await setupTestDatabase();

    const JobSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        companyId: { type: String, required: true, index: true },
      },
      { timestamps: true },
    );
    Job =
      (mongoose.models.PermScopeJob as mongoose.Model<{ title: string; companyId: string }>) ||
      mongoose.model<{ title: string; companyId: string }>("PermScopeJob", JobSchema);

    await Job.deleteMany({});

    const jobRepo = new Repository(Job);
    const jobResource = defineResource({
      name: "job",
      adapter: createMongooseAdapter({ model: Job, repository: jobRepo }),
      controller: new BaseController(jobRepo, {
        resourceName: "job",
        queryParser: new QueryParser({ allowedFilterFields: ["title"] }),
        // NOTE: the tenant field for this resource is `companyId`, not the default `organizationId`
        tenantField: "companyId",
      }),
      // Every operation uses the same API-key check — no other auth layer at all
      permissions: {
        list: requireApiKey(),
        get: requireApiKey(),
        create: requireApiKey(),
        update: requireApiKey(),
        delete: requireApiKey(),
      },
      // The permission check sets the scope via PermissionResult.scope, so
      // BaseController.create auto-injects `companyId` via its tenant-injection path
      schemaOptions: {
        fieldRules: {
          title: { type: "string", required: true },
          // Mark companyId as system-managed so BodySanitizer strips any client-supplied value
          companyId: { type: "string", systemManaged: true },
        },
      },
    });

    app = await createApp({
      preset: "development",
      auth: false, // No auth plugin — permission check is the whole auth layer
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (f) => {
        await f.register(jobResource.toPlugin());
      },
    });
    await app.ready();

    // Seed: create one job per org using each API key
    await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { "x-api-key": "key-acme" },
      payload: { title: "Acme Job 1" },
    });
    await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { "x-api-key": "key-acme" },
      payload: { title: "Acme Job 2" },
    });
    await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { "x-api-key": "key-globex" },
      payload: { title: "Globex Job 1" },
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("POST seeds land in the correct org (companyId auto-injected from service scope)", async () => {
    const acmeJobs = await Job.find({ companyId: ORG_A }).lean();
    const globexJobs = await Job.find({ companyId: ORG_B }).lean();
    expect(acmeJobs).toHaveLength(2);
    expect(globexJobs).toHaveLength(1);
    expect(acmeJobs.map((j) => j.title).sort()).toEqual(["Acme Job 1", "Acme Job 2"]);
    expect(globexJobs[0]?.title).toBe("Globex Job 1");
  });

  it("GET /jobs with acme key returns only acme jobs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { "x-api-key": "key-acme" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { docs: Array<{ title: string; companyId: string }> };
    expect(body.docs).toHaveLength(2);
    expect(body.docs.every((j) => j.companyId === ORG_A)).toBe(true);
    expect(body.docs.map((j) => j.title).sort()).toEqual(["Acme Job 1", "Acme Job 2"]);
  });

  it("GET /jobs with globex key returns only globex jobs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { "x-api-key": "key-globex" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { docs: Array<{ title: string; companyId: string }> };
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]?.companyId).toBe(ORG_B);
    expect(body.docs[0]?.title).toBe("Globex Job 1");
  });

  it("GET /jobs with no API key → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/jobs" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /jobs with unknown API key → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { "x-api-key": "not-a-real-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /jobs/:id cross-tenant → 404 (tenant filter applied to single-doc fetch)", async () => {
    const acmeJob = await Job.findOne({ companyId: ORG_A }).lean();
    if (!acmeJob) throw new Error("seed missing");

    const res = await app.inject({
      method: "GET",
      url: `/jobs/${acmeJob._id}`,
      headers: { "x-api-key": "key-globex" }, // wrong tenant
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /jobs/:id same-tenant → 200", async () => {
    const acmeJob = await Job.findOne({ companyId: ORG_A }).lean();
    if (!acmeJob) throw new Error("seed missing");

    const res = await app.inject({
      method: "GET",
      url: `/jobs/${acmeJob._id}`,
      headers: { "x-api-key": "key-acme" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { title: string; companyId: string } };
    expect(body.data.companyId).toBe(ORG_A);
  });

  it("PATCH cross-tenant → 404", async () => {
    const acmeJob = await Job.findOne({ companyId: ORG_A }).lean();
    if (!acmeJob) throw new Error("seed missing");

    const res = await app.inject({
      method: "PATCH",
      url: `/jobs/${acmeJob._id}`,
      headers: { "x-api-key": "key-globex" },
      payload: { title: "hijacked" },
    });
    expect(res.statusCode).toBe(404);

    // Verify the acme job was NOT modified
    const fresh = await Job.findById(acmeJob._id).lean();
    expect(fresh?.title).not.toBe("hijacked");
  });

  it("DELETE cross-tenant → 404", async () => {
    const acmeJob = await Job.findOne({ companyId: ORG_A }).lean();
    if (!acmeJob) throw new Error("seed missing");

    const res = await app.inject({
      method: "DELETE",
      url: `/jobs/${acmeJob._id}`,
      headers: { "x-api-key": "key-globex" },
    });
    expect(res.statusCode).toBe(404);

    // Verify the acme job still exists
    const fresh = await Job.findById(acmeJob._id).lean();
    expect(fresh).not.toBeNull();
  });

  it("client-supplied companyId in create body is ignored (systemManaged strips it)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { "x-api-key": "key-acme" },
      payload: { title: "Attempted cross-tenant create", companyId: ORG_B },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { _id: string; companyId: string } };
    // Must belong to acme (from scope), NOT globex (from body)
    expect(body.data.companyId).toBe(ORG_A);

    const persisted = await Job.findById(body.data._id).lean();
    expect(persisted?.companyId).toBe(ORG_A);
  });
});
