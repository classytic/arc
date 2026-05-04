/**
 * Multi-Tenant Hierarchy E2E
 *
 * Tests real-world multi-tenant patterns:
 * - Org → Team → Project hierarchy
 * - tenantField scoping per resource
 * - Company-wide vs org-scoped resources in same app
 * - roles() permission check across levels
 *
 * Simulates Better Auth org patterns without requiring BA runtime:
 * - Uses custom authenticator that sets scope from headers
 * - Tests org isolation, cross-org denial, team scoping
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireAuth, roles } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

describe("Multi-Tenant Hierarchy E2E", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    // ── Company-wide resource: Plan (all orgs share) ──
    const PlanSchema = new mongoose.Schema({
      name: { type: String, required: true },
      maxMembers: Number,
    });
    const PlanModel = mongoose.models.MTPlan || mongoose.model("MTPlan", PlanSchema);
    const planRepo = new Repository(PlanModel);

    const planResource = defineResource({
      name: "plan",
      adapter: createMongooseAdapter({ model: PlanModel, repository: planRepo }),
      controller: new BaseController(planRepo, {
        resourceName: "plan",
        tenantField: false,
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: roles("admin"),
        update: roles("admin"),
        delete: roles("admin"),
      },
    });

    // ── Org-scoped resource: Project ──
    const ProjectSchema = new mongoose.Schema(
      {
        name: { type: String, required: true },
        status: { type: String, enum: ["active", "archived"], default: "active" },
        organizationId: { type: String, index: true },
        teamId: String,
      },
      { timestamps: true },
    );
    const ProjectModel = mongoose.models.MTProject || mongoose.model("MTProject", ProjectSchema);
    const projectRepo = new Repository(ProjectModel);

    const projectResource = defineResource({
      name: "project",
      adapter: createMongooseAdapter({ model: ProjectModel, repository: projectRepo }),
      controller: new BaseController(projectRepo, {
        resourceName: "project",
        queryParser: new QueryParser({
          allowedFilterFields: ["status", "teamId"],
          allowedOperators: ["eq", "in"],
        }),
        tenantField: "organizationId",
        schemaOptions: {
          fieldRules: {
            name: { type: "string", required: true },
            status: { type: "string", enum: ["active", "archived"] },
            teamId: { type: "string" },
            organizationId: { systemManaged: true },
            createdAt: { systemManaged: true },
            updatedAt: { systemManaged: true },
          },
        },
      }),
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: roles("admin", "member"),
        update: roles("admin", "member"),
        delete: roles("admin"),
      },
      schemaOptions: {
        fieldRules: {
          name: { type: "string", required: true },
          status: { type: "string", enum: ["active", "archived"] },
          teamId: { type: "string" },
          organizationId: { systemManaged: true },
          createdAt: { systemManaged: true },
          updatedAt: { systemManaged: true },
        },
      },
    });

    // ── Org-scoped resource: Task (nested under project) ──
    const TaskSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        projectId: { type: String, index: true },
        assignee: String,
        organizationId: { type: String, index: true },
      },
      { timestamps: true },
    );
    const TaskModel = mongoose.models.MTTask || mongoose.model("MTTask", TaskSchema);
    const taskRepo = new Repository(TaskModel);

    const taskResource = defineResource({
      name: "task",
      adapter: createMongooseAdapter({ model: TaskModel, repository: taskRepo }),
      controller: new BaseController(taskRepo, {
        resourceName: "task",
        tenantField: "organizationId",
        schemaOptions: {
          fieldRules: {
            title: { type: "string", required: true },
            projectId: { type: "string" },
            assignee: { type: "string" },
            organizationId: { systemManaged: true },
            createdAt: { systemManaged: true },
            updatedAt: { systemManaged: true },
          },
        },
      }),
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: roles("admin"),
      },
      schemaOptions: {
        fieldRules: {
          title: { type: "string", required: true },
          projectId: { type: "string" },
          assignee: { type: "string" },
          organizationId: { systemManaged: true },
          createdAt: { systemManaged: true },
          updatedAt: { systemManaged: true },
        },
      },
    });

    // Seed
    await PlanModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await TaskModel.deleteMany({});

    await PlanModel.create([
      { name: "Free", maxMembers: 5 },
      { name: "Pro", maxMembers: 50 },
    ]);
    await ProjectModel.create([
      { name: "Alpha", status: "active", organizationId: "org-a", teamId: "team-1" },
      { name: "Beta", status: "active", organizationId: "org-a", teamId: "team-2" },
      { name: "Gamma", status: "archived", organizationId: "org-b", teamId: "team-3" },
    ]);
    await TaskModel.create([
      { title: "Build API", projectId: "proj-1", assignee: "alice", organizationId: "org-a" },
      { title: "Write Docs", projectId: "proj-1", assignee: "bob", organizationId: "org-a" },
      { title: "Deploy", projectId: "proj-2", assignee: "charlie", organizationId: "org-b" },
    ]);

    // ── Custom authenticator: reads identity from headers ──
    app = await createApp({
      preset: "testing",
      auth: {
        type: "authenticator",
        authenticate: async (request: FastifyRequest, _reply: FastifyReply) => {
          const userId = request.headers["x-user-id"] as string;
          const orgId = request.headers["x-org-id"] as string;
          const userRole = request.headers["x-user-role"] as string;
          const orgRole = request.headers["x-org-role"] as string;

          if (!userId) return; // unauthenticated

          (request as any).user = {
            id: userId,
            _id: userId,
            role: userRole || "user",
          };

          if (orgId) {
            (request as any).scope = {
              kind: "member",
              userId,
              userRoles: userRole ? [userRole] : ["user"],
              organizationId: orgId,
              orgRoles: orgRole ? [orgRole] : ["member"],
            };
          } else {
            (request as any).scope = {
              kind: "authenticated",
              userId,
              userRoles: userRole ? [userRole] : ["user"],
            };
          }
        },
      },
      resources: [planResource, projectResource, taskResource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  /** Inject with auth headers */
  function authed(opts: {
    method: string;
    url: string;
    payload?: unknown;
    userId?: string;
    orgId?: string;
    userRole?: string;
    orgRole?: string;
  }) {
    return app.inject({
      method: opts.method as any,
      url: opts.url,
      payload: opts.payload,
      headers: {
        ...(opts.userId ? { "x-user-id": opts.userId } : {}),
        ...(opts.orgId ? { "x-org-id": opts.orgId } : {}),
        ...(opts.userRole ? { "x-user-role": opts.userRole } : {}),
        ...(opts.orgRole ? { "x-org-role": opts.orgRole } : {}),
      },
    });
  }

  // ── Company-wide resource (tenantField: false) ──

  describe("company-wide resource (plans)", () => {
    it("anonymous can list plans", async () => {
      const res = await app.inject({ method: "GET", url: "/plans" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBe(2);
    });

    it("any org user sees all plans (no org scoping)", async () => {
      const res = await authed({ method: "GET", url: "/plans", userId: "u1", orgId: "org-a" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBe(2);
    });

    it("admin can create plan", async () => {
      const res = await authed({
        method: "POST",
        url: "/plans",
        payload: { name: "Enterprise", maxMembers: 500 },
        userId: "u1",
        userRole: "admin",
      });
      expect(res.statusCode).toBe(201);
    });

    it("non-admin cannot create plan", async () => {
      const res = await authed({
        method: "POST",
        url: "/plans",
        payload: { name: "Hacked" },
        userId: "u2",
        userRole: "user",
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Org-scoped resource (projects) ──

  describe("org-scoped resource (projects)", () => {
    it("org-a user sees only org-a projects", async () => {
      const res = await authed({ method: "GET", url: "/projects", userId: "u1", orgId: "org-a" });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.length).toBe(2);
      expect(data.every((d: any) => d.organizationId === "org-a")).toBe(true);
    });

    it("org-b user sees only org-b projects", async () => {
      const res = await authed({ method: "GET", url: "/projects", userId: "u2", orgId: "org-b" });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.length).toBe(1);
      expect(data[0].name).toBe("Gamma");
    });

    it("org-a user cannot see org-b project by ID", async () => {
      // Get org-b project ID
      const orgB = await authed({ method: "GET", url: "/projects", userId: "u2", orgId: "org-b" });
      const gammaId = orgB.json().data[0]._id;

      // Try to access from org-a context
      const res = await authed({
        method: "GET",
        url: `/projects/${gammaId}`,
        userId: "u1",
        orgId: "org-a",
      });
      expect(res.statusCode).toBe(404);
    });

    it("org member can create project (roles checks org role)", async () => {
      const res = await authed({
        method: "POST",
        url: "/projects",
        payload: { name: "New Project", status: "active" },
        userId: "u1",
        orgId: "org-a",
        orgRole: "member",
      });
      expect(res.statusCode).toBe(201);
    });

    it("unauthenticated cannot list projects", async () => {
      const res = await app.inject({ method: "GET", url: "/projects" });
      expect(res.statusCode).toBe(401);
    });

    it("filter by status within org scope", async () => {
      const res = await authed({
        method: "GET",
        url: "/projects?status=active",
        userId: "u1",
        orgId: "org-a",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.every((d: any) => d.status === "active")).toBe(true);
    });

    it("filter by teamId within org scope", async () => {
      const res = await authed({
        method: "GET",
        url: "/projects?teamId=team-1",
        userId: "u1",
        orgId: "org-a",
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.length).toBe(1);
      expect(data[0].name).toBe("Alpha");
    });
  });

  // ── Org-scoped with role-based permissions (tasks) ──

  describe("org-scoped with role permissions (tasks)", () => {
    it("org member can list tasks in their org", async () => {
      const res = await authed({ method: "GET", url: "/tasks", userId: "u1", orgId: "org-a" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBe(2);
    });

    it("org member can create task", async () => {
      const res = await authed({
        method: "POST",
        url: "/tasks",
        payload: { title: "Review PR", assignee: "alice" },
        userId: "u1",
        orgId: "org-a",
      });
      expect(res.statusCode).toBe(201);
    });

    it("non-admin cannot delete task (roles('admin') check)", async () => {
      const list = await authed({ method: "GET", url: "/tasks", userId: "u1", orgId: "org-a" });
      const id = list.json().data[0]._id;

      const res = await authed({
        method: "DELETE",
        url: `/tasks/${id}`,
        userId: "u1",
        orgId: "org-a",
        orgRole: "member",
      });
      expect(res.statusCode).toBe(403);
    });

    it("org admin can delete task (roles('admin') checks orgRole)", async () => {
      const list = await authed({ method: "GET", url: "/tasks", userId: "u1", orgId: "org-a" });
      const id = list.json().data[0]._id;

      const res = await authed({
        method: "DELETE",
        url: `/tasks/${id}`,
        userId: "u1",
        orgId: "org-a",
        orgRole: "admin",
      });
      expect(res.statusCode).toBe(200);
    });

    it("platform admin can delete task (roles('admin') checks userRole)", async () => {
      const list = await authed({ method: "GET", url: "/tasks", userId: "u1", orgId: "org-a" });
      const id = list.json().data[0]._id;

      const res = await authed({
        method: "DELETE",
        url: `/tasks/${id}`,
        userId: "u1",
        orgId: "org-a",
        userRole: "admin",
        orgRole: "member",
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
