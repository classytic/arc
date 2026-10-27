import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const { name, version, license, homepage } = JSON.parse(readFileSync("./package.json", "utf-8"));

/**
 * Attribution banner prepended to every emitted JS chunk.
 *
 * Derived from package.json rather than written out, so it cannot go stale — the
 * version changes every release, and a hardcoded string would quietly start
 * lying on the first one someone forgot to update.
 *
 * `/*!` (not `/*`) is the load-bearing detail: minifiers treat it as a legal
 * comment and preserve it. Arc does not minify its own output, but a host
 * bundling arc into an application does, and that is precisely the build where
 * the attribution would otherwise vanish.
 *
 * JS only. The `.d.mts` files are read by tooling, not people, and arc emits 200+
 * of them — a banner there is noise that also perturbs the api-surface snapshot.
 */
const banner = `/*! ${name} v${version} | ${license} | ${homepage} */`;

export default defineConfig({
  entry: [
    // Core
    "src/index.ts",
    "src/core/index.ts",
    "src/usage/index.ts",
    "src/types/index.ts",
    "src/types/storage.ts",
    "src/permissions/index.ts",
    "src/cache/index.ts",
    "src/presets/index.ts",
    "src/presets/multiTenant.ts",
    "src/presets/filesUpload.ts",
    "src/presets/search.ts",

    // Scope
    "src/scope/index.ts",

    // Auth
    "src/auth/index.ts",

    // Hooks, Registry, Utils
    "src/hooks/index.ts",
    "src/registry/index.ts",
    "src/utils/index.ts",

    // Context (AsyncLocalStorage), Logger, Middleware, Pipeline — zero-dep primitives
    "src/context/index.ts",
    "src/logger/index.ts",
    "src/middleware/index.ts",
    "src/pipeline/index.ts",

    // Factory
    "src/factory/index.ts",

    // Auth — dedicated Redis session store subpath
    "src/auth/redis-session.ts",

    // Plugins — barrel + dedicated heavy-dep subpaths
    "src/plugins/index.ts",
    "src/plugins/tracing-entry.ts",
    "src/plugins/response-cache.ts",
    "src/http-cache/index.ts",
    "src/http-cache/purgers/cloudflare.ts",
    "src/http-cache/purgers/fastly.ts",
    "src/http-cache/testing/index.ts",

    // Events — barrel (memory + repo-backed outbox) + Redis transport subpaths
    "src/events/index.ts",
    "src/events/transports/redis.ts",
    "src/events/transports/redis-stream-entry.ts",

    // Audit — single barrel (plugin accepts `repository` directly)
    "src/audit/index.ts",

    // Idempotency — barrel (memory + repo-backed) + dedicated Redis subpath
    "src/idempotency/index.ts",
    "src/idempotency/redis.ts",

    // Encryption — Application-Layer Encryption (JWE via optional `jose` peer
    // + field-level AES-256-GCM via node:crypto)
    "src/encryption/index.ts",

    // Docs
    "src/docs/index.ts",

    // Testing
    "src/testing/index.ts",
    "src/testing/storageContract.ts",
    "src/testing/cleanupStoreContract.ts",
    "src/testing/outboxStoreContract.ts",
    "src/testing/requiredPorts.ts",

    // Schemas (TypeBox)
    "src/schemas/index.ts",

    // Migrations
    "src/migrations/index.ts",

    // CLI
    "src/cli/index.ts",
    "src/cli/commands/describe.ts",
    "src/cli/commands/docs.ts",
    "src/cli/commands/generate.ts",
    "src/cli/commands/introspect.ts",
    "src/cli/commands/init.ts",
    "src/cli/commands/doctor.ts",

    // Integrations — each is opt-in, separate entry point
    "src/integrations/index.ts",
    "src/integrations/streamline.ts",
    "src/integrations/websocket.ts",
    "src/integrations/websocket-redis.ts",
    "src/integrations/websocket-pushref-redis.ts",
    "src/integrations/jobs/index.ts",
    "src/integrations/event-gateway.ts",
    "src/integrations/webhooks.ts",

    // MCP — Model Context Protocol integration
    "src/integrations/mcp/index.ts",
    "src/integrations/mcp/testing.ts",

    // SCIM 2.0 — IdP provisioning (Okta / Azure AD / Google Workspace / etc.)
    "src/scim/index.ts",

    // Auth — Better Auth → arc audit bridge (auth-event lifecycle)
    "src/auth/audit.ts",

    // Discovery — auto-discovery plugin
    "src/discovery/index.ts",

    // Data Cleanup Center — thin recipe framework (registry, plan digest,
    // run/evidence ports, orchestration service, resource factory)
    "src/cleanup/index.ts",
    "src/outbox-admin/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  banner: { js: banner },

  treeshake: true,
  target: "node22",
  outDir: "dist",
  define: {
    __ARC_VERSION__: JSON.stringify(version),
  },
  deps: {
    // arc bundles NOTHING from node_modules. `neverBundle: true` marks every
    // package specifier external AS WRITTEN, without resolving it, so it covers
    // dependencies, peers (required + optional), dev-only integrations and
    // workspace `@classytic/*` symlinks alike, and a new peer needs no list entry.
    //
    // tsdown's DEFAULT is to inline a devDependency that source imports. `./testing`
    // imports `mongoose` and `mongodb-memory-server` lazily, so under tsdown 0.23
    // (where the old `skipNodeModulesBundle` no longer protected them) 2.44.0/2.45.0
    // shipped ~4.5 MB of inlined mongoose + mongodb driver + mongodb-memory-server.
    // That broke `mongoMemoryDatabase` under vitest 5: the inlined CJS reads `__dirname`,
    // which an ES module does not have. It also made the harness own a SEPARATE mongoose
    // instance from the host's, while kernels register models on the host's.
    neverBundle: true,

    // The guard: a build that would inline ANY node_modules package fails instead of
    // shipping it. (`onlyBundle` is a whitelist; empty means nothing may be bundled.)
    onlyBundle: [],
  },
});
