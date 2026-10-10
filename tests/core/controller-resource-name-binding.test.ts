/**
 * A supplied controller that never passed `resourceName` to `super()` is bound to the
 * resource's name by `defineResource`, so its hooks and `audit: true` run; a controller
 * bound to a different name is refused at define time.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import { MemoryAuditStore } from "../../src/audit/stores/memory.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

beforeAll(async () => {
  await setupTestDatabase();
});
afterAll(async () => {
  await teardownTestDatabase();
});

const open = allowPublic();
const permissions = { list: open, get: open, create: open, update: open, delete: open };

describe("defineResource binds a supplied controller's resourceName", () => {
  it("a subclass without resourceName runs its after-update hook and is audited", async () => {
    const Model = createMockModel("NameBindingBranch");
    const repo = createMockRepository(Model);
    const [doc] = await Model.create([{ name: "before" }]);

    class BranchController extends BaseController {
      constructor() {
        super(repo, { tenantField: false });
      }
    }

    const afterUpdate = vi.fn();
    const resource = defineResource({
      name: "branch",
      prefix: "/branches",
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller: new BranchController(),
      tenantField: false,
      permissions,
      audit: true,
      hooks: { afterUpdate },
    });

    const store = new MemoryAuditStore();
    const app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem: new HookSystem() });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: { perResource: true },
    });
    await app.register(resource.toPlugin());
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/branches/${String(doc._id)}`,
        payload: { name: "after" },
      });
      expect(res.statusCode).toBe(200);
      expect(afterUpdate).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(store.getAll().map((e) => [e.resource, e.action])).toEqual([["branch", "update"]]);
    } finally {
      await app.close();
    }
  });

  it("a controller bound to a different resourceName is refused", () => {
    const Model = createMockModel("NameBindingMismatch");
    const repo = createMockRepository(Model);
    expect(() =>
      defineResource({
        name: "branch",
        adapter: createMongooseAdapter({ model: Model, repository: repo }),
        controller: new BaseController(repo, { resourceName: "warehouse", tenantField: false }),
        tenantField: false,
        permissions,
      }),
    ).toThrow(/bound to resourceName "warehouse"/);
  });
});
