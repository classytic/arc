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
      "./audit",
      "./auth",
      "./auth/audit",
      "./auth/redis",
      "./cache",
      "./cli",
      "./context",
      "./core",
      "./discovery",
      "./docs",
      "./encryption",
      "./events",
      "./events/redis",
      "./events/redis-stream",
      "./factory",
      "./hooks",
      "./idempotency",
      "./idempotency/redis",
      "./integrations",
      "./integrations/event-gateway",
      "./integrations/jobs",
      "./integrations/streamline",
      "./integrations/webhooks",
      "./integrations/websocket",
      "./integrations/websocket-pushref-redis",
      "./integrations/websocket-redis",
      "./logger",
      "./mcp",
      "./mcp/testing",
      "./middleware",
      "./migrations",
      "./permissions",
      "./pipeline",
      "./plugins",
      "./plugins/response-cache",
      "./plugins/tracing",
      "./presets",
      // approval + involvement were extracted to @classytic/arc-approval /
      // @classytic/arc-involvement (arc-ecosystem workspace) BEFORE 2.20
      // published — the subpaths never shipped. See ecosystem-extraction.md.
      "./presets/files-upload",
      "./presets/search",
      "./presets/tenant",
      "./registry",
      "./schemas",
      "./scim",
      "./scope",
      // 2.20: 19-line re-export of repo-core's ./sync change-log contract.
      "./sync",
      "./testing",
      "./testing/storage",
      "./types",
      "./types/storage",
      "./usage",
      "./utils",
    ].sort();

    expect(actualKeys).toEqual(expectedKeys);
  });

  it("labels every subpath with a stability level (arc.subpathStability)", () => {
    // Governance gate: every published subpath must declare stable |
    // experimental. A NEW subpath fails here until it's classified, and
    // an orphan label (subpath removed, label kept) fails too — the map
    // can't silently rot in either direction. Machine-readable so agents
    // and downstream tooling can read maturity without scraping docs.
    const pkg = readPackageJson() as unknown as {
      exports: Record<string, unknown>;
      arc?: { subpathStability?: Record<string, string> };
    };
    const stability = pkg.arc?.subpathStability ?? {};
    const exportKeys = Object.keys(pkg.exports).sort();
    const labeledKeys = Object.keys(stability).sort();

    expect(labeledKeys, "arc.subpathStability must cover exactly the exports map").toEqual(
      exportKeys,
    );
    for (const [subpath, level] of Object.entries(stability)) {
      expect(
        ["stable", "experimental"],
        `exports["${subpath}"] has invalid stability "${level}"`,
      ).toContain(level);
    }
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
      {
        subpath: "@classytic/arc/factory",
        symbols: ["createApp", "defineModule", "getModuleExports", "orderModules", "resolveModule"],
      },
      {
        subpath: "@classytic/arc/cache",
        symbols: ["MemoryCacheStore", "RedisCacheStore"],
      },
      {
        subpath: "@classytic/arc/permissions",
        symbols: ["allowPublic", "requireAuth", "requireRoles", "requireGrant"],
      },
      { subpath: "@classytic/arc/hooks", symbols: ["HookSystem"] },
      { subpath: "@classytic/arc/registry", symbols: ["ResourceRegistry"] },
      { subpath: "@classytic/arc/utils", symbols: ["ArcError"] },
      {
        subpath: "@classytic/arc/plugins",
        symbols: ["healthPlugin", "errorHandlerPlugin"],
      },
      { subpath: "@classytic/arc/auth", symbols: ["authPlugin"] },
      { subpath: "@classytic/arc/events", symbols: ["eventPlugin"] },
      { subpath: "@classytic/arc/idempotency", symbols: ["idempotencyPlugin"] },
      { subpath: "@classytic/arc/audit", symbols: ["auditPlugin"] },
      { subpath: "@classytic/arc/testing", symbols: ["createTestApp"] },
      {
        subpath: "@classytic/arc/schemas",
        symbols: ["ArcListResponse", "ArcPaginationQuery"],
      },
      { subpath: "@classytic/arc/discovery", symbols: ["discoveryPlugin"] },
      {
        subpath: "@classytic/arc/migrations",
        symbols: ["defineMigration", "MigrationRunner"],
      },
      {
        subpath: "@classytic/arc/middleware",
        symbols: ["multipartBody", "middleware", "sortMiddlewares"],
      },
      {
        subpath: "@classytic/arc/pipeline",
        symbols: ["guard", "intercept", "pipe", "transform", "executePipeline"],
      },
      { subpath: "@classytic/arc/context", symbols: ["requestContext"] },
      { subpath: "@classytic/arc/logger", symbols: ["arcLog", "configureArcLogger"] },
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
