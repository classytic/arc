---
name: arc-module-publishing
description: |
  Author and publish an ecosystem package for @classytic/arc the way arc's own packages
  are built — modules, action presets, and plugins that hosts install and compose.
  Codifies the non-negotiable conventions: no hardcoded dependencies (host duty), peers
  as `>=` ranges (stable API contract), bundle-nothing tsdown, public-subpath imports only,
  one-way dependency (arc never depends on you), and the classytic release gate.
  Use when creating a new @classytic/arc-<domain> package, extracting a domain out of an
  app into a reusable module, deciding a package's package.json / tsdown / peer setup,
  writing a defineModule() or an action preset, or preparing an arc module for npm publish.
  Triggers: publish arc module, arc package, arc ecosystem, defineModule, ArcModule, arc
  plugin package, arc action preset, extract domain to package, arc-approval, arc-involvement,
  peer dependencies arc, tsdown arc package, arc module conventions, classytic publish,
  mergeResourceConfig, ResourceSeams, kernel-typed engine port, module errorMappers.
license: MIT
metadata:
  author: Classytic
tags:
  - arc
  - packaging
  - publishing
  - modules
  - ecosystem
  - tsdown
  - peer-dependencies
  - monorepo
---

# Publishing @classytic/arc ecosystem packages

How to author and ship a reusable package **on top of** arc — a domain module, an action
preset, or a plugin — so it composes cleanly into any host and follows the same discipline
as arc's own first-party packages (`@classytic/arc-approval`, `@classytic/arc-involvement`,
`@classytic/arc-notifications`).

**Node ≥22 · ESM only · TypeScript strict · tsdown build · Biome lint.**

---

## The one rule everything else follows

> **The package declares a contract; the host owns the installation.**

A published arc package is a *contribution* to someone else's app, not an app. That single
idea produces every convention below: you never bundle what the host provides, you never
pin what the host must choose, you never reach past arc's public surface, and you never
make arc depend on you.

---

## Decision: which shape are you shipping?

Three shapes, smallest surface first. Pick the smallest that does the job.

| Shape | You export | Host uses it via | Example |
|---|---|---|---|
| **Action preset** | a function returning an `actions:` slice | spread into `defineResource({ actions })` | `withApprovalChain()` (arc-approval) |
| **Plugin** | an `fp()`-wrapped Fastify plugin (+ named export) | `app.register()` / `plugins:` slot | any cross-cutting decorator/hook |
| **Module** | `createXModule(deps) → ArcModule` | `createApp({ modules: [...] })` | a whole domain (engine + resources + wiring) |

- A preset adds **verbs to one resource**. No lifecycle, no engine — just a function that
  returns `Record<string, ActionDefinition>`. Storage-agnostic via a **structural repository
  port** (an interface with the two or three methods you actually call), never a kit import.
- A module owns a **whole domain**: it initializes an engine in `bootstrap`, registers its
  resources, wires `afterResources`, and tears down in `onClose`. Use `defineModule` and let
  the host list it in `modules:`. See [references/authoring-modules.md](references/authoring-modules.md).

When unsure, ship a **preset or plugin**. A module is the right call only when there is
engine state to boot and multiple resources to register as a unit.

---

## Dependency discipline (the part reviewers keep catching)

This is where packages go wrong. Get the `package.json` dependency fields exactly right:

- **`dependencies`: usually empty.** Everything arc-shaped is a *peer*. Only add a real
  `dependency` for a genuinely private, bundled-in helper the host should never see or
  control — which is rare. If you're tempted to add `@classytic/*` or `fastify` here, stop:
  that's a peer.
- **`peerDependencies`: `>=` ranges, never `^`.** A peer is a *contract*: "I work against
  arc 2.20 and up." `^2.20.0` would wrongly forbid a host on arc 3.x that still satisfies the
  API you use. Use `">=2.20.0"`. This keeps the API contract stable and lets hosts upgrade arc
  without your package blocking them.
- **`devDependencies`: pin with `^`.** These are the versions your *test suite* runs against —
  a concrete, current version (`"@classytic/arc": "^2.20.0"`). The floor of every devDep must
  be `>=` the peer floor, or your tests never exercise the version you claim to support.
- **Optional peers** (zod, ioredis, a kit) go in `peerDependencies` **and**
  `peerDependenciesMeta: { "<name>": { optional: true } }`. Never let their types leak into
  your public `.d.mts` — use structural typing so a host that doesn't install them still
  compiles. See [references/package-manifest.md](references/package-manifest.md).

**Why `>=` and not `^` for peers:** the host, not you, resolves the actual installed version.
Your job is to state the *floor* of the API you depend on and stay out of the host's upgrade
path. A caret peer turns every host major-bump into a forced wait on your release.

---

## Import discipline: public surface only

Import arc through its **published subpaths**, exactly as a third-party host would. Never
reach into `@classytic/arc/src/...` or a deep `dist/` path.

```ts
import type { PermissionCheck } from "@classytic/arc/permissions";
import { getOrgId, getUserId, requireOrgId } from "@classytic/arc/scope";
import type { ActionDefinition, RequestWithExtras } from "@classytic/arc/types";
import { createDomainError, NotFoundError, ValidationError } from "@classytic/arc/utils";
```

The canonical entry points: `@classytic/arc` (core), `/permissions`, `/scope`, `/types`,
`/utils`, `/factory` (for `defineModule`, `getModuleExports`), `/testing`. If something you
need isn't on a public subpath, that's a signal — file it against arc rather than deep-import
around it. Deep imports break the moment arc reorganizes internals, which it's free to do
because they were never public.

**One-way dependency:** your package depends on arc; **arc never depends on your package.**
If arc would need something from you, the abstraction belongs *in arc* (a port, a hook, a
preset seam), not as a back-edge. This keeps the dependency graph a DAG and arc publishable
on its own.

---

## Build: bundle nothing

tsdown, ESM only, and **bundle nothing that's a peer**. Every `@classytic/*` and `fastify`
stays external so the host's single installed copy is the one that runs (two copies of arc =
two plugin registries = subtle breakage).

```ts
// tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  treeshake: true,
  target: "node22",
  outDir: "dist",
  deps: {
    skipNodeModulesBundle: true,     // don't inline node_modules
    neverBundle: [/^@classytic\//],  // arc + primitives + kits stay external, always
  },
});
```

`package.json` build wiring: `sideEffects: false`, `files: ["dist"]`, an `exports` map with
`types` + `default`, `type: "module"`, `engines.node: ">=22"`, `publishConfig.access:
"public"`. Full template in [references/package-manifest.md](references/package-manifest.md).

---

## Bridge onto arc's primitives — don't reinvent them

A hard-won lesson: when a host already gets a capability from arc, **bridge onto it** instead
of shipping a second path.

- Need background work? Use `fastify.jobs` (arc's BullMQ bridge) — don't add your own BullMQ
  dependency and stand up a parallel queue. Two job systems in one app is a footgun, not a
  feature.
- Need guaranteed event delivery? Use arc's **outbox** and the `@classytic/primitives` event
  contract (`createEvent`, `DomainEvent`, `EventTransport`) — don't invent an event shape.
- Need permissions/scope? Use `@classytic/arc/permissions` + `@classytic/arc/scope`
  accessors (`getOrgId`, `requireUserId`) — don't re-derive tenant/user from `request.user`.

The test: *"Does arc already bless a primitive for this?"* If yes, your package composes onto
it. Shipping a competing path breaks the host's single-source-of-truth and doubles their ops
surface. Reinvent only when arc genuinely has no primitive — and then consider whether it
should live in arc.

---

## Naming & versioning

- **Package name:** `@classytic/arc-<domain>` for first-party; third parties use their own
  scope (`@acme/arc-billing`). The `arc-` prefix signals "arc ecosystem package."
- **Module `name`** (the `defineModule({ name })` identifier): namespace it so it can't
  collide in a host that composes many modules — `"accounting"`, `"order"`, or a
  vendor-qualified `"acme.billing"`. This is the key hosts use in `dependsOn` and
  `getModuleExports`, and arc rejects duplicate module names at boot.
- **SemVer the public export**, not the internals. Your exported function signatures, the
  `ArcModule` shape you return, and the action/schema surface are the contract. Bumping a peer
  floor (e.g. requiring a newer arc) is at least a **minor**; changing an exported signature is
  a **major**.

---

## Release gate

Every publish runs a gate — no `--no-verify`, ever. In a workspace, a shared script; in a
solo package, `prepublishOnly`:

```jsonc
"scripts": {
  "build": "tsdown",
  "typecheck": "tsc --noEmit",
  "lint": "biome check src/",
  "prepublishOnly": "npm run typecheck && npm run lint && npm run test && npm run build"
}
```

For a **monorepo of packages**, add a **peer-skew gate** that fails if any package's devDep
floor is below its declared peer floor — it's the mechanical guard that stops your suite from
silently testing against a version older than you promise to support. Full script and workspace
layout in [references/publishing-workflow.md](references/publishing-workflow.md).

**classytic packages** additionally: commit as `classytic-bot[bot]` (per-invocation git env
vars, never `git config --global`, no `Co-Authored-By`), push via `classytic-push`, publish to
public npm. See the workspace `CLAUDE.md` and [references/publishing-workflow.md](references/publishing-workflow.md).

---

## Pre-publish checklist

- [ ] `dependencies` is empty (or only truly-private bundled helpers)
- [ ] every arc/fastify/kit dep is a `peerDependency` with a `>=` range
- [ ] every peer floor is covered by a `^`-pinned devDep at or above it (peer-skew clean)
- [ ] optional peers are marked `optional: true` and their types don't leak into `dist/*.d.mts`
- [ ] tsdown `neverBundle: [/^@classytic\//]` + `skipNodeModulesBundle: true`
- [ ] imports use public subpaths only — no `@classytic/arc/src` or deep `dist` paths
- [ ] arc has **no** dependency on this package (grep arc for the package name → nothing)
- [ ] `sideEffects: false`, `files: ["dist"]`, `exports` map with `types`+`default`, `type: "module"`
- [ ] action schemas shipped as **JSON Schema** (zod stays an optional peer, never required)
- [ ] `prepublishOnly` gate green (typecheck + lint + test + build), no `--no-verify`
- [ ] module `name` is namespaced and can't collide across a multi-module host
- [ ] boots green in a **kit-backed testkit** (real in-memory store, prod-fidelity — not a fake repo)
- [ ] `.npmrc`: `auto-install-peers=false` + an install-script allowlist for any dep with a `postinstall`

---

## References

- [references/package-manifest.md](references/package-manifest.md) — copy-paste `package.json`
  + `tsdown.config.ts`, optional-peer structural-typing pattern, the dependency-field cheat sheet.
- [references/authoring-modules.md](references/authoring-modules.md) — `defineModule` lifecycle,
  `dependsOn` composition order, `getModuleExports` cross-module wiring, thunk lazy/region packs,
  action-preset and structural-port patterns.
- [references/publishing-workflow.md](references/publishing-workflow.md) — monorepo layout, the
  peer-skew + prepublish gates, classytic bot-identity release steps, versioning a public export.
