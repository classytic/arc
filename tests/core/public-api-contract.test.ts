import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ExportEntry = { types: string; default: string };

function getPackageRoot(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return resolve(testDir, "..", "..");
}

function readPackageJson(): {
  name: string;
  exports: Record<string, ExportEntry>;
} {
  const packageRoot = getPackageRoot();
  const packageJsonPath = resolve(packageRoot, "package.json");
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

describe("Public API Contract", () => {
  it("keeps the stable subpath export surface", () => {
    const pkg = readPackageJson();
    const actualKeys = Object.keys(pkg.exports).sort();

    const expectedKeys = [
      ".",
      "./adapters",
      "./audit",
      "./audit/mongodb",
      "./auth",
      "./auth/mongoose",
      "./auth/redis",
      "./cache",
      "./cli",
      "./core",
      "./discovery",
      "./docs",
      "./dynamic",
      "./events",
      "./events/mongo",
      "./events/redis",
      "./events/redis-stream",
      "./factory",
      "./hooks",
      "./idempotency",
      "./idempotency/mongodb",
      "./idempotency/redis",
      "./integrations",
      "./integrations/event-gateway",
      "./integrations/jobs",
      "./integrations/streamline",
      "./integrations/webhooks",
      "./integrations/websocket",
      "./integrations/websocket-redis",
      "./mcp",
      "./mcp/testing",
      "./migrations",
      "./org",
      "./org/types",
      "./permissions",
      "./plugins",
      "./plugins/response-cache",
      "./plugins/tracing",
      "./policies",
      "./presets",
      "./presets/files-upload",
      "./presets/search",
      "./presets/tenant",
      "./registry",
      "./rpc",
      "./schemas",
      "./scope",
      "./testing",
      "./testing/storage",
      "./types",
      "./types/storage",
      "./utils",
    ].sort();

    expect(actualKeys).toEqual(expectedKeys);
  });

  it("keeps all export entries wired to existing dist artifacts", () => {
    const packageRoot = getPackageRoot();
    const pkg = readPackageJson();

    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      const importEntry = (entry as any).import || entry;
      const requireEntry = (entry as any).require;

      expect(typeof importEntry.types, `Missing "types" in exports["${subpath}"]`).toBe("string");
      expect(typeof importEntry.default, `Missing "default" in exports["${subpath}"]`).toBe(
        "string",
      );
      expect(
        existsSync(resolve(packageRoot, importEntry.types)),
        `Missing file for "${subpath}" types: ${importEntry.types}`,
      ).toBe(true);
      expect(
        existsSync(resolve(packageRoot, importEntry.default)),
        `Missing file for "${subpath}" default: ${importEntry.default}`,
      ).toBe(true);
    }
  });

  it("exports expected runtime symbols from critical subpaths", async () => {
    const checks: Array<{ subpath: string; symbols: string[] }> = [
      {
        subpath: "@classytic/arc",
        symbols: ["defineResource", "BaseController", "allowPublic"],
      },
      {
        subpath: "@classytic/arc/core",
        symbols: ["createCrudRouter", "defineResource"],
      },
      { subpath: "@classytic/arc/factory", symbols: ["createApp"] },
      {
        subpath: "@classytic/arc/cache",
        symbols: ["MemoryCacheStore", "RedisCacheStore"],
      },
      {
        subpath: "@classytic/arc/permissions",
        symbols: ["allowPublic", "requireAuth", "requireRoles"],
      },
      { subpath: "@classytic/arc/hooks", symbols: ["HookSystem"] },
      { subpath: "@classytic/arc/registry", symbols: ["ResourceRegistry"] },
      { subpath: "@classytic/arc/utils", symbols: ["ArcError"] },
      {
        subpath: "@classytic/arc/plugins",
        symbols: ["healthPlugin", "errorHandlerPlugin"],
      },
      { subpath: "@classytic/arc/auth", symbols: ["authPlugin"] },
      {
        subpath: "@classytic/arc/org",
        symbols: ["organizationPlugin", "orgGuard"],
      },
      { subpath: "@classytic/arc/events", symbols: ["eventPlugin"] },
      { subpath: "@classytic/arc/idempotency", symbols: ["idempotencyPlugin"] },
      { subpath: "@classytic/arc/audit", symbols: ["auditPlugin"] },
      { subpath: "@classytic/arc/testing", symbols: ["createTestApp"] },
      {
        subpath: "@classytic/arc/policies",
        symbols: ["createAccessControlPolicy", "createPolicyMiddleware"],
      },
      {
        subpath: "@classytic/arc/schemas",
        symbols: ["ArcListResponse", "ArcPaginationQuery"],
      },
      { subpath: "@classytic/arc/discovery", symbols: ["discoveryPlugin"] },
      {
        subpath: "@classytic/arc/migrations",
        symbols: ["defineMigration", "MigrationRunner"],
      },
    ];

    for (const { subpath, symbols } of checks) {
      const mod = await import(subpath);
      for (const symbol of symbols) {
        expect(symbol in mod, `Missing export "${symbol}" from ${subpath}`).toBe(true);
      }
    }
  });

  it("keeps the integrations barrel type-only at runtime", async () => {
    const mod = await import("@classytic/arc/integrations");
    expect(Object.keys(mod)).toEqual([]);
  });
});
