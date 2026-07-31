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
    "src/sync/changelog.ts",
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
    // arc bundles NOTHING from node_modules — every dependency, peer
    // dependency (required + optional), and dev-only integration stays
    // external. Externalizing by RESOLVED PATH means it cannot drift from
    // package.json and needs no hand-maintained allowlist; new peers are
    // covered automatically.
    //
    // tsdown deprecates this in favour of `neverBundle: true`, but that option
    // is a UNION (`true | ExternalOption`) — taking `true` would mean dropping
    // the pattern list below, and `true` keeps a dependency external only when
    // it RESOLVES INTO node_modules. A workspace `@classytic/*` symlink
    // resolves outside it, so the two are not interchangeable here and the
    // migration would silently start bundling peers. Revisit when tsdown allows
    // both, or when it exposes a resolved-path predicate.
    skipNodeModulesBundle: true,

    // Belt-and-suspenders for workspace/linked deps that resolve OUTSIDE
    // node_modules during local dev (monorepo symlinks) — scoped roots +
    // their subpaths.
    neverBundle: [
      /^@classytic\//,
      /^@fastify\//,
      /^@opentelemetry\//,
      /^@modelcontextprotocol\//,
      /^zod\//,
    ],
  },
});
