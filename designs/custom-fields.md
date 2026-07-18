# Design: `@classytic/arc-custom-fields` — tenant-defined fields at runtime

**Status**: SKIPPED as a package (2026-07-14) — kept as the RECIPE. On the merits: every part
reduces to existing arc primitives (defs = a plain `defineResource` with audit+history;
validation = one beforeCreate/beforeUpdate hook; invalidation = events; read-gating =
preSerialization; discovery = one route). A feature that is pure composition of shipped
primitives is documentation, not API — same verdict as `resourcesFromEngine` and
stamp-from-scope. The layer that would justify a real product (admin UI, form renderer) is
out of arc's domain permanently. This doc is the answer to any host asking "how do I do
custom fields on arc?". Extraction rule stays armed: if 3+ real hosts hand-roll this same
hook, extract `@classytic/arc-custom-fields` FROM them (the arc-approval birth path) — never
pre-build it. Reserved wire key if that day comes: `custom`.
**Shape**: ecosystem package (`arc-ecosystem` repo), NOT a core subpath. Peers: `@classytic/arc >=2.22.0`.
**The bet**: this is the Salesforce-class capability — a tenant admin adds "Contract Renewal Date"
to customers without a deploy. It is also the feature that turns arc from framework into platform
kernel, which is why it gets a design doc and a deliberate yes/no instead of momentum.

---

## The one architectural fact everything follows from

Arc compiles route schemas ONCE at boot (Fastify/AJV). Per-tenant fields therefore **cannot ride
the static wire schema** — and must not try. The design splits the two layers cleanly:

- **Boot-static layer** (unchanged arc): the wire schema reserves ONE object slot on opted-in
  resources — `custom: { type: 'object' }` — advertised in OpenAPI with `x-tenant-defined: true`.
- **Request-dynamic layer** (this package): a hook validates `body.custom` against the TENANT's
  live field definitions — compiled AJV validators cached per `(tenant, defsVersion)`, invalidated
  by arc events when definitions change (multi-replica safe via the event transport).

No core change is required: the package composes through arc's existing seams — the `extensions`
hatch (per-resource opt-in), resource hooks (validation), events (cache invalidation), and a
plain `defineResource` for the definitions themselves.

## Surface (host DX)

```ts
import { customFieldsPlugin, customFieldsExtension } from '@classytic/arc-custom-fields';

await app.register(customFieldsPlugin, {
  repository: defsRepo,                       // definitions store — host's kit, any DB
  permissions: { manage: requireOrgRole(['admin']) },
});

defineResource({
  name: 'customer',
  extensions: { customFields: true },         // opt-in per resource
});
```

What the plugin mounts:
- `/custom-field-definitions` — a normal arc resource (tenant-scoped, `audit: true`,
  `history: true` — dogfooding 2.22). A definition:
  `{ resource: 'customer', key: 'contractRenewalDate', type: 'date', label, required?, enum?, visibleTo?, writableBy?, filterable? }`
- `GET /:resource/custom-fields` — live shape discovery (what admin UIs and API clients render
  forms from; this replaces per-tenant OpenAPI, which stays out of scope).
- The validation hook on every opted-in resource's create/update: unknown keys rejected,
  types/enum/required enforced, `writableBy` gated through the same role logic as arc field rules.
- A `preSerialization` filter applying `visibleTo` to the `custom` slice on reads.

## Type system (deliberately small)

`string | number | boolean | date | enum | reference(id)` — flat keys only, per-tenant cap
(default 50/resource). That's the whole v1 type system.

## Storage & querying

The `custom` object flows through the resource's EXISTING create/update path — storage is the
kit's concern (Mongo: native subdocument; sqlitekit/prismakit: JSON column). The package never
touches the DB for document data; only the definitions repo.

Filtering (`?filter[custom.x]=`) is **P3**: definitions declare `filterable: true`, and each kit
documents its indexing recipe (Mongo wildcard index on `custom.$**`, SQL JSONB GIN). Until P3,
custom fields are stored + validated + returned, not queried.

## Non-goals (the over-engineering fence — load-bearing)

- **No runtime custom OBJECTS/resources.** Fields on existing resources only. Custom objects are
  where metadata platforms go to die; arc's answer to "new entity" stays `defineResource` in code.
- **No formula/computed fields, no cross-field rules, no scripting.** v1 validates values.
- **No per-tenant OpenAPI generation.** The discovery endpoint is the live contract.
- **No automatic index creation.** Recipes, not magic.

## Phases

- **P1** — definitions resource + validation hook + discovery endpoint + event-driven cache. The MVP that makes the demo real.
- **P2** — `visibleTo`/`writableBy` read/write gating (field-permission parity).
- **P3** — `filterable` + kit indexing recipes + MCP tool schema surfacing of the discovery shape.

## Open questions (maintainer input before P1)

1. Reserved key: `custom` (proposed) vs `attributes` vs `meta`? Must never collide with real model fields — validator should also reject definitions shadowing schema-known keys.
2. Definition storage: host-provided `RepositoryLike` via deps (proposed — DB-agnostic, zero new peers) vs package-owned model per kit?
3. Cross-tenant limits: cap fields/resource at 50? Payload size cap for `custom` (e.g. 16KB)?
4. Does `reference` type validate existence (a repo lookup per write) in v1, or store-and-trust with validation in P2?

## Why this wins vs the incumbents

Salesforce's custom fields drag a metadata platform, a query language, and a UI builder with
them. Arc's version is one package: definitions are just a resource (audited, historied,
permission-gated by the machinery that already exists), validation is one hook, and the entire
platform stays in git except the one thing that genuinely belongs to the tenant — their fields.
