/**
 * Controller-configure lifecycle + dropped-options warn provenance —
 * arc 2.15.0.
 *
 * Three behaviours under test:
 *
 *   1. **`setQueryParser` fail-loud**: when a resource declares
 *      `queryParser` but its custom controller has no `setQueryParser`,
 *      `defineResource` throws at registration. (Pre-2.15 silently
 *      warned and shipped a controller using its internal default —
 *      "filters silently broken" production class.)
 *
 *   2. **Configure-aware controllers don't trigger the dropped-options
 *      warn**: when a custom controller exposes `configure(opts)`, arc
 *      forwards the resolved options into it AND skips the warn —
 *      options aren't actually dropped.
 *
 *   3. **`_declaredKeys` provenance gates the warn**: arc's own
 *      `inferTenantFieldFromAdapter` mutates `tenantField = false` when
 *      the model has no `organizationId` path. Pre-2.15 the warn fired
 *      ("you set tenantField"), even though the user never set it.
 *      The snapshot of `Object.keys(config)` taken before any
 *      mutation now gates the warn so only user-declared keys count.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import { describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { configureArcLogger } from "../../src/logger/index.js";
import { allowPublic } from "../../src/permissions/core.js";
import type { RepositoryLike } from "../../src/types/repository.js";

const stubRepo = {
  getOne: async () => null,
  getAll: async () => [],
  create: async (d: unknown) => d,
  update: async () => null,
  delete: async () => false,
} as unknown as RepositoryLike<Record<string, unknown>>;

function makeAdapter(opts: {
  hasFieldPath?: (name: string) => boolean | undefined;
}): DataAdapter<Record<string, unknown>> {
  return {
    type: "custom",
    name: "stub",
    repository: stubRepo,
    hasFieldPath: opts.hasFieldPath,
  };
}

const basePerms = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

// Capture arc warnings via the logger writer hook so tests can assert
// "fired" / "did not fire" without importing internal helpers.
function captureArcWarnings(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const noop = () => {};
  configureArcLogger({
    writer: {
      debug: noop,
      info: noop,
      warn: (...args: unknown[]) => {
        warns.push(args.map((a) => String(a)).join(" "));
      },
      error: noop,
    },
  });
  return {
    warns,
    restore: () => configureArcLogger({}),
  };
}

describe("controller.configure() lifecycle + warn provenance — 2.15.0", () => {
  describe("setQueryParser fail-loud (H1)", () => {
    it("throws at registration when controller declares queryParser but lacks setQueryParser", () => {
      const adapter = makeAdapter({ hasFieldPath: () => true });
      class CustomController {
        // intentionally NO setQueryParser
        list = vi.fn();
        get = vi.fn();
        create = vi.fn();
        update = vi.fn();
        delete = vi.fn();
      }
      const queryParser = {
        parse: () => ({}),
        getQuerySchema: () => ({}),
      } as unknown as Parameters<typeof defineResource>[0]["queryParser"];

      expect(() =>
        defineResource({
          name: "thing",
          adapter,
          // biome-ignore lint/suspicious/noExplicitAny: test stub controller shape
          controller: new CustomController() as any,
          queryParser,
          permissions: basePerms,
        }),
      ).toThrow(/does not expose `setQueryParser/);
    });

    it("succeeds when the custom controller exposes setQueryParser", () => {
      const adapter = makeAdapter({ hasFieldPath: () => true });
      const setQueryParser = vi.fn();
      const queryParser = {
        parse: () => ({}),
        getQuerySchema: () => ({}),
      } as unknown as Parameters<typeof defineResource>[0]["queryParser"];

      const customController = {
        setQueryParser,
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      expect(() =>
        defineResource({
          name: "thing",
          adapter,
          // biome-ignore lint/suspicious/noExplicitAny: test stub
          controller: customController as any,
          queryParser,
          permissions: basePerms,
        }),
      ).not.toThrow();
      expect(setQueryParser).toHaveBeenCalledTimes(1);
      expect(setQueryParser).toHaveBeenCalledWith(queryParser);
    });
  });

  describe("configure() lifecycle hook (#3)", () => {
    it("arc forwards resolved resource-level options into a configure-aware controller", () => {
      const adapter = makeAdapter({ hasFieldPath: () => true });
      const configure = vi.fn();
      const customController = {
        configure,
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      defineResource({
        name: "thing",
        adapter,
        // biome-ignore lint/suspicious/noExplicitAny: test stub
        controller: customController as any,
        tenantField: "workspaceId",
        idField: "uuid",
        defaultSort: "-createdAt",
        cache: { staleTime: 60 },
        onFieldWriteDenied: "strip",
        permissions: basePerms,
      });

      expect(configure).toHaveBeenCalledTimes(1);
      const opts = configure.mock.calls[0][0];
      expect(opts.tenantField).toBe("workspaceId");
      expect(opts.idField).toBe("uuid");
      expect(opts.defaultSort).toBe("-createdAt");
      expect(opts.cache).toEqual({ staleTime: 60 });
      expect(opts.onFieldWriteDenied).toBe("strip");
    });

    it("configure-aware controllers do NOT trigger the dropped-options warn", () => {
      const cap = captureArcWarnings();
      try {
        const adapter = makeAdapter({ hasFieldPath: () => true });
        const customController = {
          configure: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        };
        defineResource({
          name: "thing",
          adapter,
          // biome-ignore lint/suspicious/noExplicitAny: test stub
          controller: customController as any,
          tenantField: "workspaceId",
          permissions: basePerms,
        });
        expect(cap.warns.some((m) => m.includes("declares a custom controller"))).toBe(false);
      } finally {
        cap.restore();
      }
    });

    it("controllers WITHOUT configure() still get the warn (legacy path preserved)", () => {
      const cap = captureArcWarnings();
      try {
        const adapter = makeAdapter({ hasFieldPath: () => true });
        const customController = {
          // NO configure
          list: vi.fn(),
          get: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        };
        defineResource({
          name: "thing",
          adapter,
          // biome-ignore lint/suspicious/noExplicitAny: test stub
          controller: customController as any,
          tenantField: "workspaceId",
          permissions: basePerms,
        });
        expect(
          cap.warns.some(
            (m) => m.includes("declares a custom controller") && m.includes("tenantField"),
          ),
        ).toBe(true);
      } finally {
        cap.restore();
      }
    });

    it("BaseController.configure() rebuilds AccessControl + QueryResolver when tenantField changes", () => {
      const ctrl = new BaseController(stubRepo, { resourceName: "x", tenantField: "orgA" });
      const accessControlBefore = ctrl.accessControl;
      const queryResolverBefore = ctrl.queryResolver;
      ctrl.configure({ tenantField: "orgB" });
      // New AccessControl and QueryResolver instances since tenantField
      // participates in both — referentially-stable consumers don't see
      // stale state.
      expect(ctrl.accessControl).not.toBe(accessControlBefore);
      expect(ctrl.queryResolver).not.toBe(queryResolverBefore);
    });

    it("BaseController.configure() leaves untouched fields alone (idempotent partial)", () => {
      const ctrl = new BaseController(stubRepo, {
        resourceName: "x",
        tenantField: "orgA",
        idField: "_id",
      });
      ctrl.configure({ tenantField: "orgB" }); // only tenantField
      // idField unchanged — accessing via accessControl scope (the tenant
      // is in there too).
      // We can't read protected fields, so check via behaviour: configure
      // again with the same tenantField returns same AccessControl ref
      // (no rebuild trigger).
      const accessControlAfter = ctrl.accessControl;
      ctrl.configure({}); // no-op
      expect(ctrl.accessControl).toBe(accessControlAfter);
    });

    it("BaseController.configure() rebuilds BodySanitizer when schemaOptions change", () => {
      const ctrl = new BaseController(stubRepo, {
        resourceName: "x",
        schemaOptions: { fieldRules: { secret: { systemManaged: true } } },
      });
      const before = ctrl.bodySanitizer;
      ctrl.configure({
        schemaOptions: { fieldRules: { otherSecret: { systemManaged: true } } },
      });
      expect(ctrl.bodySanitizer).not.toBe(before);
    });
  });

  describe("_declaredKeys warn provenance (#1)", () => {
    it("does NOT warn about tenantField when arc inferred it (user never declared it)", () => {
      const cap = captureArcWarnings();
      try {
        const adapter = makeAdapter({
          // Adapter says no organizationId path — arc will infer
          // tenantField: false.
          hasFieldPath: (name) => name !== "organizationId",
        });
        const customController = {
          // No configure — would normally trip the warn.
          list: vi.fn(),
          get: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        };
        defineResource({
          name: "lookup",
          adapter,
          // biome-ignore lint/suspicious/noExplicitAny: test stub
          controller: customController as any,
          // tenantField NOT set by user
          permissions: basePerms,
        });
        // The dropped-options warn must not name `tenantField` because
        // the user didn't declare it — arc inferred `false`.
        const droppedWarn = cap.warns.find((m) => m.includes("declares a custom controller"));
        if (droppedWarn) {
          expect(droppedWarn).not.toMatch(/tenantField/);
        }
      } finally {
        cap.restore();
      }
    });

    it("DOES warn when user explicitly set tenantField", () => {
      const cap = captureArcWarnings();
      try {
        const adapter = makeAdapter({ hasFieldPath: () => true });
        const customController = {
          // No configure — legacy path
          list: vi.fn(),
          get: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        };
        defineResource({
          name: "thing",
          adapter,
          // biome-ignore lint/suspicious/noExplicitAny: test stub
          controller: customController as any,
          tenantField: "workspaceId", // user-declared
          permissions: basePerms,
        });
        expect(
          cap.warns.some(
            (m) => m.includes("declares a custom controller") && m.includes("tenantField"),
          ),
        ).toBe(true);
      } finally {
        cap.restore();
      }
    });
  });
});
