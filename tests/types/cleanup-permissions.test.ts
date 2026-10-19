import { describe, expectTypeOf, it } from "vitest";
import type { DataCleanupModuleDeps, CleanupPermissions } from "../../src/cleanup/index.js";
import { requirePlatformRole } from "../../src/permissions/index.js";
import type { PermissionCheck } from "../../src/permissions/types.js";

describe("cleanup module permission types", () => {
  it("accepts standard platform gates and existing boolean permission functions", () => {
    const gate = requirePlatformRole("superadmin");
    const permissions: DataCleanupModuleDeps["permissions"] = { view: gate, execute: gate };
    const existing: CleanupPermissions = { view: () => true, execute: async () => false };
    const compatible: DataCleanupModuleDeps["permissions"] = existing;
    expectTypeOf(permissions.view).toEqualTypeOf<PermissionCheck>();
    expectTypeOf(compatible.execute).toEqualTypeOf<PermissionCheck>();
  });
});
