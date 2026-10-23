---
name: arc-module-publishing
description: Author and publish a package on top of @classytic/arc: an action preset, plugin, or defineModule() domain module that hosts install. Covers peers, tsdown, public subpaths, resource assembly, testing, release gate. Use when creating an arc-<domain> package or preparing npm publish. Triggers: arc package, defineModule, ArcModule, action preset, peerDependencies, mergeResourceConfig.
license: MIT
metadata:
  author: Classytic
  minVersion: "2.46.0"
tags:
  - arc
  - packaging
  - publishing
  - modules
---

# Publishing @classytic/arc ecosystem packages

The package declares a contract, the host owns the installation. Node 22+, ESM only, strict TypeScript, tsdown, Biome.

## Do not hand-roll

| Need | Use | Import |
|---|---|---|
| Domain as one value (engine, resources, teardown) | `defineModule` | `@classytic/arc/factory` |
| Read another module's engine | `getModuleExports`, `getOptionalModuleExports` | `@classytic/arc/factory` |
| Module resources from host seams | `mergeResourceConfig`, `ResourceSeams` | `@classytic/arc` |
| Plugin with global and per-resource parts | `createPlugin` | `@classytic/arc/plugins` |
| Verbs on one resource | `defineAction` in an `actions` slice | `@classytic/arc/core` |
| Zod v4 body validated once, handler gets parsed value | `routeInput`, `crudInput`, `parsed`, `noPayloadSchema` | `@classytic/arc/core` |
| CRUD gates from read/write | `permissionMatrix` | `@classytic/arc/permissions` |
| Tenant and user ids | `getUserId`, `requireOrgId`, `requireUserId`, `scopeFirstCtx` | `@classytic/arc/scope` |
| Domain errors on the wire | `createDomainError`, `defineErrorMapper`, module `errorMappers` | `@classytic/arc/utils` |
| Recurring work | module `scheduledJobs`; `schedulesPlugin` with `daily: { hour, zone, ledger }` | `@classytic/arc/plugins` |
| Event subscriptions, readiness | module `eventHandlers`, `healthChecks` | `@classytic/arc/factory` |
| Background queue | `jobsPlugin`, `defineJob` | `@classytic/arc/integrations/jobs` |
| Boot proof for a module | `bootModuleApp`, `assertModuleBootsAlone` | `@classytic/arc/testing` |
| Store conformance | `runOutboxStoreContract`, `runStorageContract`, `runCleanupRunStoreContract` | `@classytic/arc/testing/{outbox,storage,cleanup}` |

## Golden path

Pick the smallest shape: preset (verbs on one resource), plugin (cross-cutting decorator), module (engine plus several resources).

1. Preset: injected policy, zod v4 schema declared once, tenant from scope.

```ts
import { defineAction } from "@classytic/arc/core";
import type { PermissionCheck } from "@classytic/arc/permissions";
import { requireOrgId } from "@classytic/arc/scope";
import type { ActionDefinition } from "@classytic/arc/types";
import { z } from "zod";

const closeBody = z.object({ note: z.string().trim().min(2) });

export function withClose(cfg: { permission: PermissionCheck; close(id: string, orgId: string, note: string): Promise<unknown> }): Record<"close", ActionDefinition> {
  return {
    close: defineAction({
      schema: closeBody,
      parse: true,
      permissions: cfg.permission,
      description: "Close the subject.",
      handler: (id, data, req) => cfg.close(id, requireOrgId(req.scope), data.note),
    }),
  };
}
```

2. Module: `bootstrap` return is the public export, `resources` factory runs after all bootstraps.

```ts
import { defineModule, getModuleExports } from "@classytic/arc/factory";

export const accountingModule = (deps: AccountingDeps) =>
  defineModule({
    name: "accounting",
    dependsOn: ["ledger"],
    bootstrap: async (f, { defer }) => {
      const engine = createAccountingEngine(deps, getModuleExports<LedgerEngine>(f, "ledger"));
      defer(() => engine.stop());
      return engine;
    },
    resources: (f) => [accountsResource(getModuleExports<AccountingEngine>(f, "accounting"), deps)],
  });
```

3. Manifest: arc, primitives, repo-core, kits and zod are peers with `>=` floors; tests pin `^` devDeps. See references/package-manifest.md.
4. Build: tsdown, bundle nothing. See references/build-and-types.md.
5. Prove composition: `bootModuleApp(({ connection }) => [accountingModule(deps)])`, hit routes with `t.app.inject`, `await t.close()`. See references/testing-packages.md.
6. Release: `npm run verify`, then `npm publish -w <pkg>`. See references/publishing-workflow.md.

## Gotchas

- Module `plugins` and `afterResources` are called by arc, not registered: `await fastify.register(x)` inside, never return a plugin.
- `dependsOn` orders composition, it does not delay imports; a thunk decides whether to import.
- Peer floor equals the newest arc feature you use, never the workspace baseline.
- No upper bound on peers; floors only.
- A shared `ErrorMapper` goes in module `errorMappers`; host mappers keep priority.
- An action `schema` is the body schema itself; `{ body: X }` validates nothing and logs `schema.slot_wrapper`.
- Reserved query names (`page`, `limit`, `cursor`, `after`, `sort`, `search`, `select`, `populate`) cannot be filter fields.
- Identity comes only from `req.scope` accessors, never `req.user` or `x-user-id` headers.

## Never

- Put arc, fastify or a kit in `dependencies`; write a peer as `^`.
- Bundle `@classytic/*`; import arc `src` or `dist` paths.
- Make arc depend on your package; the port belongs in arc.
- Add a second job system or event shape when arc and primitives provide one.
- Use `--no-verify` or skip `prepublishOnly`.
- Use `Co-Authored-By` or global git config in classytic packages.

## References

- [references/package-manifest.md](references/package-manifest.md): read when writing package.json, peers, devDeps, exports.
- [references/build-and-types.md](references/build-and-types.md): read when configuring tsdown or keeping optional-peer types out of d.mts.
- [references/action-presets-and-plugins.md](references/action-presets-and-plugins.md): read when shipping a preset or fp() plugin.
- [references/module-lifecycle.md](references/module-lifecycle.md): read when writing defineModule, dependsOn, ports, cross-module exports, thunks.
- [references/resource-assembly.md](references/resource-assembly.md): read when building resources from host seams, schemas and permissions.
- [references/testing-packages.md](references/testing-packages.md): read when writing boot tests and store conformance tests.
- [references/publishing-workflow.md](references/publishing-workflow.md): read when setting up gates, monorepo, bot identity, versioning.
