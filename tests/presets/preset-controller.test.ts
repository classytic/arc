/**
 * Preset route builders receive the controller: `routes(permissions, controller)`.
 * Covers the auto-built controller (created after presets apply), the boot check
 * on methods read while routes are built, the warn-once
 * window for host presets that still return string dispatch, and arc's own presets
 * staying silent.
 */

import type { StandardRepo } from "@classytic/repo-core/repository";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/index.js";
import { resetDeprecationWarnings } from "../../src/logger/deprecation.js";
import { allowPublic } from "../../src/permissions/index.js";
import { createPresetControllerHandle } from "../../src/presets/controllerHandle.js";
import {
  bulkPreset,
  slugLookupPreset,
  softDeletePreset,
  treePreset,
} from "../../src/presets/index.js";
import type {
  AnyRecord,
  DataAdapter,
  IRequestContext,
  PresetController,
  PresetResult,
  ResourcePermissions,
} from "../../src/types/index.js";

class ItemRepo implements StandardRepo {
  async getAll() {
    return [{ _id: "1", name: "one" }];
  }
  async getById(id: string) {
    return { _id: id, name: `item ${id}` };
  }
  async create(data: AnyRecord) {
    return { _id: "new", ...data };
  }
  async update(id: string, data: AnyRecord) {
    return { _id: id, ...data };
  }
  async delete() {
    return true;
  }
}

class StatsController extends BaseController {
  async getStats(_ctx: IRequestContext) {
    return { data: { total: 7 } };
  }
}

const adapter = (): DataAdapter => ({ repository: new ItemRepo(), type: "custom", name: "test" });
const open: ResourcePermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

async function inject(resource: ReturnType<typeof defineResource>, url: string) {
  const app = Fastify({ logger: false });
  await app.register(resource.toPlugin(), { prefix: "/api" });
  await app.ready();
  const res = await app.inject({ method: "GET", url });
  await app.close();
  return res;
}

describe("preset routes(permissions, controller)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const deprecations = () =>
    warn.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("is deprecated"));

  beforeEach(() => {
    resetDeprecationWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("arrow form reaches the AUTO-BUILT controller, with no deprecation warning", async () => {
    const firstItem: PresetResult = {
      name: "firstItem",
      routes: (permissions, controller: PresetController<"list">) => [
        {
          method: "GET",
          path: "/first",
          permissions: permissions.list ?? allowPublic(),
          handler: (ctx) => controller.list(ctx),
        },
      ],
    };
    const resource = defineResource({
      name: "fn-auto",
      adapter: adapter(),
      permissions: open,
      presets: [firstItem],
    });
    const res = await inject(resource, "/api/fn-autos/first");
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('"name":"one"');
    expect(deprecations()).toEqual([]);
  });

  it("reference form reaches a host controller's method with `this` bound to the controller", async () => {
    let seenThis: unknown;
    class ThisController extends StatsController {
      override async getStats(ctx: IRequestContext) {
        seenThis = this;
        return super.getStats(ctx);
      }
    }
    const host = new ThisController(new ItemRepo());
    const stats: PresetResult = {
      name: "stats",
      routes: (permissions, controller: PresetController<"getStats">) => [
        {
          method: "GET",
          path: "/stats",
          operation: "getStats",
          permissions: permissions.list ?? allowPublic(),
          handler: controller.getStats,
        },
      ],
    };
    const resource = defineResource({
      name: "ref-host",
      adapter: adapter(),
      controller: host,
      permissions: open,
      presets: [stats],
    });
    const res = await inject(resource, "/api/ref-hosts/stats");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 7 });
    expect(seenThis).toBe(host);
    expect(deprecations()).toEqual([]);
  });

  it("a referenced method the controller lacks fails BOOT with a code naming resource, preset, route and method", () => {
    const stats: PresetResult = {
      name: "stats",
      routes: (permissions, controller: PresetController<"getStats">) => [
        {
          method: "GET",
          path: "/stats",
          permissions: permissions.list ?? allowPublic(),
          handler: controller.getStats,
        },
      ],
    };
    const define = () =>
      defineResource({
        name: "ref-missing",
        adapter: adapter(),
        permissions: open,
        presets: [stats],
      });
    expect(define).toThrow(
      expect.objectContaining({
        name: "ArcBootError",
        code: "preset-controller-method-missing",
        message:
          "Resource 'ref-missing': preset 'stats' route GET /stats uses controller.getStats, " +
          "but the controller has no 'getStats' method.",
      }),
    );
  });

  it("crud: false + slugLookup with no controller fails BOOT", () => {
    expect(() =>
      defineResource({
        name: "no-ctrl",
        adapter: adapter(),
        crud: false,
        presets: [slugLookupPreset()],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "preset-controller-method-missing",
        message:
          "Resource 'no-ctrl': preset 'slugLookup' route GET /slug/:slug uses controller.getBySlug, " +
          "but the resource has no controller.",
      }),
    );
  });

  it("skipValidation defers the check to registration, which still fails boot", async () => {
    const resource = defineResource({
      name: "no-ctrl-skip",
      adapter: adapter(),
      crud: false,
      skipValidation: true,
      presets: [slugLookupPreset()],
    });
    const app = Fastify({ logger: false });
    await expect(
      app.register(resource.toPlugin(), { prefix: "/api" }).then(() => app.ready()),
    ).rejects.toMatchObject({ code: "preset-controller-method-missing" });
    await app.close();
  });

  it("a host preset returning a string handler warns ONCE, naming the preset and the fix, and still serves", async () => {
    const legacy: PresetResult = {
      name: "legacyStats",
      routes: (permissions) => [
        {
          method: "GET",
          path: "/stats",
          permissions: permissions.list ?? allowPublic(),
          handler: "getStats",
        },
      ],
    };
    const define = (name: string) =>
      defineResource({
        name,
        adapter: adapter(),
        controller: new StatsController(new ItemRepo()),
        permissions: open,
        presets: [legacy],
      });
    const first = define("legacy-a");
    define("legacy-b");

    const lines = deprecations();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("A string `handler` on a preset route is deprecated");
    expect(lines[0]).toContain("routes(permissions, controller)");
    expect(lines[0]).toContain("handler: controller.method");
    expect(lines[0]).toContain("GET /stats from preset 'legacyStats' on resource 'legacy-a'");

    const res = await inject(first, "/api/legacy-as/stats");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 7 });
  });

  it("arc's own presets reference controller methods and never warn", () => {
    defineResource({
      name: "builtin",
      adapter: adapter(),
      permissions: open,
      presets: [softDeletePreset(), slugLookupPreset(), treePreset(), bulkPreset()],
    });
    expect(deprecations()).toEqual([]);
    const { controller } = createPresetControllerHandle("probe");
    const expected: Record<string, string> = {
      "GET /deleted": "getDeleted",
      "POST /:id/restore": "restore",
      "GET /slug/:slug": "getBySlug",
      "GET /tree": "getTree",
      "GET /:parent/children": "getChildren",
      "POST /bulk": "bulkCreate",
      "PATCH /bulk": "bulkUpdate",
      "DELETE /bulk": "bulkDelete",
    };
    for (const preset of [softDeletePreset(), slugLookupPreset(), treePreset(), bulkPreset()]) {
      const routes =
        typeof preset.routes === "function" ? preset.routes({}, controller) : (preset.routes ?? []);
      for (const route of routes) {
        const method = expected[`${route.method} ${route.path}`] as string;
        expect(route.handler).toBe((controller as Record<string, unknown>)[method]);
      }
    }
  });
});
