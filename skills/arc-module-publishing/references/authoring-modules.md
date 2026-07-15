# Authoring: presets, plugins, and modules

The three shapes a package exports, smallest surface first. All import arc through public
subpaths only (`@classytic/arc/{permissions,scope,types,utils,factory,testing}`).

---

## Shape 1 — Action preset (add verbs to one resource)

The smallest reusable unit: a function returning an `actions:` slice the host spreads into a
resource. No lifecycle, no engine. Storage-agnostic via a **structural repository port** — an
interface listing only the methods you call, satisfied by any kit repository without importing
the kit.

```ts
import type { PermissionCheck } from "@classytic/arc/permissions";
import { getOrgId, getUserId } from "@classytic/arc/scope";
import type { ActionDefinition, RequestWithExtras } from "@classytic/arc/types";
import { createDomainError, NotFoundError } from "@classytic/arc/utils";

// Structural port — NOT a kit import. Any kit repo with these methods satisfies it.
export interface SubjectRepository<TDoc> {
  getById(id: string, o: { organizationId?: string; throwOnNotFound: false; lean: true }): Promise<TDoc | null>;
  update(id: string, patch: Record<string, unknown>, o: { organizationId?: string; lean: true }): Promise<TDoc | null>;
}

export interface WithXConfig<TDoc> {
  readonly repository: SubjectRepository<TDoc>;
  readonly permissions: { readonly act: PermissionCheck };
  // ...host policy injected here: resolvers, side-effect hooks, tenancy mode
}

export function withX<TDoc>(config: WithXConfig<TDoc>): Record<"do_x", ActionDefinition> {
  return {
    do_x: {
      handler: async (id, data, req) => handler(config, id, data, req),
      permissions: config.permissions.act,
      description: "…",
      schema: { type: "object", /* JSON Schema */ additionalProperties: false },
    },
  };
}
```

Host composes it:

```ts
defineResource({
  actions: {
    ...withX({ repository, permissions, /* host policy */ }),
    post: { /* subject-specific verbs stay here */ },
  },
});
```

**Rules that make a preset reusable:**
- Inject **all policy** through config (permissions, resolvers, side-effect hooks). The preset
  contributes *mechanism*; the host owns *policy*.
- Take a **structural port**, never a concrete kit type. `SubjectRepository<TDoc>` with the two
  methods you use — not `MongooseRepository`.
- Read tenant/user via `getOrgId(req.scope)` / `getUserId(req.scope)`, never off `req.user`
  directly. Honor a `tenancy: "required" | "off"` config so single-tenant hosts work too.
- Ship schemas as **JSON Schema**. Map any domain errors to arc's `createDomainError(code, msg,
  status)` so the wire contract stays consistent.
- Model a **mode/source as a discriminated field, not a boolean flag**. `source: 'literal' |
  'policy' | 'auto'` beats `useMatrix: boolean`: it's extensible (a third mode is a new enum
  member, not a second conflicting flag), self-documenting, and makes contradictory inputs
  (a literal payload sent with `source: 'policy'`) rejectable instead of silently dropped. If a
  published boolean already exists, keep it as a `@deprecated` alias that bridges to the field
  for one minor, then remove — don't strand consumers on a hard rename.

---

## Shape 2 — Plugin (cross-cutting decorator/hook)

An `fp()`-wrapped Fastify plugin — the one documented exception to arc's no-default-exports
rule. Ship **both** a default (for `app.register(import(...))`) and a named export.

```ts
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

async function xPlugin(app: FastifyInstance /*, opts */): Promise<void> {
  app.decorate("x", createX(/* ... */));
  // Set response headers at onRequest or preSerialization — NEVER onSend (races Fastify's flush).
}

export const x = fp(xPlugin, { name: "arc-x", fastify: "5.x" });
export default x;   // fp() plugin entries MAY default-export (arc convention exception)
```

Host registers it in the `plugins:` slot or via `app.register`. If the plugin belongs to a
domain module, register it in the module's `plugins` lifecycle slot instead (below).

---

## Shape 3 — Module (a whole domain as one value)

Use `defineModule` when there's engine state to boot **and** multiple resources to register as
a unit. The host lists it in `createApp({ modules: [...] })`; arc expands it into the same
lifecycle phases a hand-wired app uses.

```ts
import { defineModule, getModuleExports } from "@classytic/arc/factory";
import type { FastifyInstance } from "fastify";

export interface AccountingEngine { post(entry: Entry): Promise<void>; }
export interface AccountingDeps { permissions: PermissionMatrix; }

// Factory takes host deps, returns an ArcModule. TExports inferred from bootstrap's return.
export const accountingModule = (deps: AccountingDeps) =>
  defineModule({
    name: "accounting",                 // namespaced, unique across the host — the graph key
    dependsOn: ["ledger"],              // composition order (see below), NOT lazy loading

    plugins: (f) => {                   // register infra — runs after app plugins(), before bootstraps
      f.register(/* db conn, sse, etc. */);
    },

    bootstrap: async (f) => {           // init engine — its return becomes the PUBLIC EXPORT
      const ledger = getModuleExports<LedgerEngine>(f, "ledger"); // guaranteed live (dependsOn)
      return createAccountingEngine(deps, ledger);                // → fastify.arc.modules.accounting
    },

    resources: (f) => {                 // factory form runs AFTER all bootstraps — engines are live
      const engine = getModuleExports<AccountingEngine>(f, "accounting");
      return [accountsResource(engine, deps.permissions), entriesResource(engine)];
    },

    afterResources: (f) => { /* cross-resource event subscriptions the module owns */ },
    onClose: (f) => { /* stop timers, flush outbox, destroy engine */ },

    errorMappers: [{                    // 2.21 — domain error → wire envelope, merged into the
      type: AccountingError,            // host's error handler at boot (host mappers keep priority)
      toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
    }],
  });
```

### Lifecycle phases (module runs before app-level in each)

```
plugins        = app plugins()          → modules' plugins        (infra registration)
bootstrap[]    = modules' bootstrap      → options.bootstrap       (engine init + export)
resources[]    = modules' resources      → options.resources        (module routes register first)
afterResources = modules' afterResources → options.afterResources
onClose        = modules' onClose (REVERSE order) → options.onClose  (last composed, first closed)
```

A module's engine is live before app-level bootstrap; app `afterResources` can wire across
modules; teardown mirrors init in reverse.

### `dependsOn` is composition order, not lazy loading

`dependsOn: ["ledger"]` guarantees ledger's `plugins`/`bootstrap` (and thus its public export)
run **before** this module's — so `getModuleExports(f, "ledger")` is live. It does **not** delay
*importing* the module. Every module input (including dynamic-import thunks) is resolved up
front via `Promise.all`, then `dependsOn` orders the *composition*. It's a **stable topological
sort**: modules with no edge between them keep list order, so adding `dependsOn` never silently
reorders an unrelated module. Fail-fast at boot on unknown dep, self-reference, and cycles.

### Cross-module wiring — `getModuleExports`, not a container

A module's `bootstrap` return value is its **public export**, recorded at
`fastify.arc.modules[name]`. Later modules read it with the typed accessor — no DI container,
no proxy. For inferred types without an inline generic, augment the registry once:

```ts
declare module "@classytic/arc/factory" {
  interface ArcModuleRegistry {
    accounting: AccountingEngine;
    ledger: LedgerEngine;
  }
}
// then: getModuleExports(f, "accounting") infers AccountingEngine
```

`getModuleExports` **throws** (fail-fast) if the name isn't composed, is composed after the
caller, or returned nothing — all wiring bugs that must surface at boot, not as `undefined`
downstream.

### Lazy / region packs — thunk of a dynamic import

To gate *whether* a module is imported at all (region/tier packs), pass a thunk that returns a
dynamic import. Only the selected pack enters the bundle path:

```ts
const taxPack =
  region === "BD"
    ? () => import("@classytic/bd-tax").then((m) => m.createBdTaxModule(deps))
    : () => import("@classytic/us-tax").then((m) => m.createUsTaxModule(deps));

await createApp({ modules: [coreModule(deps), taxPack] });
// only the selected tax package is imported + composed
```

Thunk = *whether to import*; `dependsOn` = *order of already-selected modules*. Different tools.

### One module per package

A package exports **one** `createXModule` factory. To compose several domains, publish several
packages (or several subpath exports) and let the host list them — don't return an array of
modules from one factory. The host owns the flat `modules:` list and its ordering; keep that
control theirs.

### Resource assembly — kernel-typed ports + `mergeResourceConfig` (2.21 standard)

Two rules kill the `as never` tax that plagued pre-2.21 module packages:

**1. Type the engine port with the KERNEL's own bags.** The kernel is already your peer, so
indexing its exported engine type adds zero coupling — and its truths (optional sub-module
members, literal unions) flow into your resource builders:

```ts
import type { CatalogEngine } from "@classytic/catalog";

export interface CatalogEngineLike {          // structural — any conforming engine composes
  models: CatalogEngine["models"];
  repositories: CatalogEngine["repositories"];
}
```

Never re-declare the bags as `Record<string, unknown>` — that's what forced every
`createMongooseAdapter(engine.models.X as never, ...)` cast.

**2. Merge base config + host seams with `mergeResourceConfig`, not hand-rolled spreads.**
Expose your per-resource override surface as projections of arc's `ResourceSeams` and let
arc's slot-aware merge do assembly — arrays CONCAT (host routes append, never clobber),
plain objects deep-merge, class instances (queryParser, adapter) last-win, `undefined`
never overwrites, `as const` readonly host tables are accepted:

```ts
import { defineResource, mergeResourceConfig, type ResourceSeams } from "@classytic/arc";
import { permissionMatrix } from "@classytic/arc/permissions";

export interface ProductSeams {               // your public seam names, arc's slot types
  extraRoutes?: ResourceSeams["routes"];
  extraActions?: ResourceSeams["actions"];
  cache?: ResourceSeams["cache"];
}

defineResource(mergeResourceConfig(
  {
    name: "product",
    adapter: createMongooseAdapter({ model: models.Product, repository: repositories.product }),
    permissions: permissionMatrix({ read: deps.permissions.view, write: deps.permissions.manage }),
  },
  { routes: cfg.extraRoutes, actions: cfg.extraActions, cache: cfg.cache },
));
```

The only casts left in a well-formed package are documented boundaries: wire-body narrowing
in action handlers (`data as { role: PartyRole }` — narrow to the KERNEL's union, not
`string`) and hydrated-vs-lean id widening at a kernel bridge. Anything else is a smell.

---

## Testing a package

Boot a **real arc app** around your export and exercise it over HTTP — that's the only test
that proves it *composes*. There are two harness layers, and the difference matters:

| Harness | Persistence | Fidelity | Home |
|---|---|---|---|
| `@classytic/arc/testing` | none — you inject a repo (fake / `Map`-backed) | boot + wiring only | inside arc |
| a **kit-backed testkit** (e.g. `@classytic/arc-testkit`) | real in-memory store (Mongo memory-server) | **prod-fidelity** | arc-ecosystem |

**Why two layers, and why the testkit is kit-specific:** arc's non-negotiable rule is *no DB
driver imports anywhere in arc*. So `@classytic/arc/testing` can boot the app but cannot give
you real persistence — it hands you an injected/fake repository. A harness that persists for
real **must** pick a concrete kit (mongokit + `mongodb-memory-server`, or sqlite in-memory).
That's not a limitation to design around — it's the point: **a testkit's value is fidelity, so
it should exercise the module the way it runs in production**, with the same adapter.

**Don't "make the testkit DB-agnostic" by defaulting to a fake in-memory repo.** A `Map`-backed
repo does not reproduce ObjectId-vs-string `_id`, `select`/projection semantics, query-operator
translation, pagination cursor encoding, unique-index enforcement, or Mongoose strict-mode
field dropping. A module that ships a real adapter will pass on the fake and break in prod — the
test gets greener and less truthful. Agnostic *interface*, real *backend*:

- **Agnostic seam:** the harness takes a **`TestBackend`** — `setup() → { ctx: { connection,
  uri }, teardown }` — so the store is pluggable, not hard-wired.
- **Real default, backend lives in the kit:** `@classytic/arc-testkit` is the thin generic core
  (`bootModuleApp(modules, { backend })`); its default backend is `mongoMemoryBackend()` from
  **`@classytic/mongokit/testkit`**, loaded via dynamic `import()` so mongokit +
  `mongodb-memory-server` stay *optional* peers. This is the concrete "adapters/backends live in
  their kits" split — mongokit owns the Mongo lifecycle, arc-testkit owns the arc boot. Add a
  sibling (`@classytic/sqlitekit/testkit` → `sqliteMemoryBackend()`) only when a non-Mongo module
  exists — YAGNI until the second consumer is real.

```ts
import { bootModuleApp } from "@classytic/arc-testkit";
import { mongoMemoryBackend } from "@classytic/mongokit/testkit"; // only to override the default

const t = await bootModuleApp(({ connection }) => [createOrderModule({ connection, permissions })]);
// or point at a real cluster:  { backend: mongoMemoryBackend({ uri: process.env.ATLAS_TEST_URI }) }
const res = await t.app.inject({ method: "GET", url: "/orders" });
await t.close();
```

**Install contract (the part that bites on adoption):** because the harness declares its DB deps
as *optional peers*, the consumer installs all three together —

```bash
npm i -D @classytic/arc-testkit @classytic/mongokit mongodb-memory-server
```

Miss `mongodb-memory-server` and the default backend throws at boot; pin `@classytic/mongokit`
below the version that first shipped `/testkit` and the subpath won't resolve (a floating `^`
range won't upgrade past a lockfile pin on its own — bump the devDep floor). This is the tradeoff
of *not* bundling: the harness stays out of production, but the consumer owns the dev install.

Whichever layer you use, cover these edges:

- Boot a minimal app, register your preset/module, hit the routes with `app.inject`.
- Test **both tenancy modes** (`required` and `off`) if you support them.
- Avoid field names arc's query parser reserves (`page`, `limit`, `cursor`, `after`, `sort`,
  `search`, `select`, `populate`) — a filter field colliding with one is silently unfilterable.
  Arc emits a `filter-field-reserved-name` boot diagnostic; heed it. **This class of bug only
  surfaces on a real backend** — another reason the fidelity harness earns its keep.
- Pin devDeps at or above every peer floor so the suite exercises the version you promise.

**Shared harness pattern:** the harness is published once — `@classytic/arc-testkit` (generic
core, in the ecosystem repo, *not* a per-domain monorepo) + `@classytic/mongokit/testkit` (the
Mongo backend, in the kit) — so every module author and third party reuses it. Depend on it via
`devDependencies` (a version range from the registry; `workspace:*` only inside its own monorepo).
"If your module boots green in the testkit, it composes" is the contract.
