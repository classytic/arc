# SCIM 2.0 — IdP Provisioning

Arc ships a SCIM 2.0 plugin (`@classytic/arc/scim`) that auto-mounts `/scim/v2/Users` + `/scim/v2/Groups` REST endpoints and translates SCIM wire shapes onto the canonical **repository contract** (`@classytic/repo-core/adapter`). Arc does NOT introduce a SCIM-specific repository subset, controller pipeline, or storage tier — it composes with what kits already expose.

## Honest architecture (what SCIM actually is)

**SCIM is a thin REST layer over the kit's `RepositoryLike`.** Whatever plugins you wire at the kit/repo layer (audit, multi-tenant, field-policy, etc.) fire for SCIM exactly the way they fire for arc REST, because **both surfaces call the same repository methods**.

```
SCIM request → arc/scim plugin → resource.adapter.repository.<method> → kit hooks fire
```

This is NOT what some earlier docs implied. SCIM does not run arc's HTTP controller pipeline (`auth → permissions → preHandlers → controller → hooks → audit`). SCIM authentication is bearer/verify only at the REST edge; everything else (row-level perms, audit trail, hooks) is composed at the kit layer where it already lives.

| Layer | Where it composes | Fires for SCIM? |
|---|---|---|
| Bearer / OIDC verify | `scimPlugin({ bearer, verify })` | ✓ at the SCIM edge |
| Audit trail | `repo.use(auditTrailPlugin())` (mongokit) — kit-specific identifier | ✓ via repo hooks |
| Multi-tenant scope | `repo.use(multiTenantPlugin)` | ✓ via repo hooks |
| Field redaction (read) | mongokit's `fieldFilterPlugin` | ✓ on `getAll` / `getById` |
| Resource hooks | `defineResource({ hooks: { ... } })` | ✗ — those are HTTP-controller hooks; not on the repo path |
| Per-action permissions | `defineResource({ permissions: { ... } })` | ✗ — same reason; gate at the edge via `verify` |

If you want resource hooks to fire for SCIM writes too, install them as **kit plugins** (`repo.on('before:create', fn)`) rather than `defineResource({ hooks: ... })`. The docs for your kit (mongokit / sqlitekit) cover the hook surface.

## CRUD → repository contract mapping

| SCIM method | Repository call | Notes |
|---|---|---|
| `GET /Users` | `repo.getAll({ filters, page, limit, sort })` | Filter parser maps SCIM filter language → query DSL |
| `GET /Users/:id` | `repo.getById(id)` | |
| `POST /Users` | `repo.create(data)` | Inbound SCIM body maps onto resource shape via `mapping.attributes` |
| `PUT /Users/:id` | `repo.bulkWrite([{ replaceOne: { filter, replacement } }])` | **Kit-conditional** — see "Feature gating" below |
| `PATCH /Users/:id` | `repo.findOneAndUpdate({ id }, ops)` | Operators flow through unchanged (`$set`, `$unset`, `$push`, `$pull`) |
| `DELETE /Users/:id` | `repo.delete(id)` | |

## Feature gating (honest about what each kit supports)

**SCIM PATCH** translates the RFC 7644 PatchOp body into canonical Mongo-style operators and forwards them to `findOneAndUpdate`. The kit decides what's portable:

| Kit | `$set` / scalar overwrite | `$unset` | `$push` / `$pull` (array mutations) |
|---|---|---|---|
| **mongokit** | ✓ | ✓ | ✓ — applied natively |
| **sqlitekit** | ✓ (compiled to flat column writes) | ✓ | ✗ — JSON columns have no array-op semantics; sqlitekit throws cleanly, SCIM 400s with `scimType: invalidValue` |
| **prismakit** | ✓ | ✓ | depends on column type |
| **Custom kit (only `MinimalRepo`)** | ✓ via `update(id, $set)` fallback | ✗ — no `findOneAndUpdate` exposed → SCIM 400 | ✗ → SCIM 400 |

**SCIM PUT** requires `repo.bulkWrite([{ replaceOne }])` OR a top-level `repo.replace(id, doc)`. Kits that expose neither return **HTTP 501** with a clear message — no silent merge into `update(id, partial)` (which would leave omitted fields surviving and violate SCIM PUT semantics).

| Kit | `PUT` (full replace) |
|---|---|
| **mongokit** | ✓ via `bulkWrite([{ replaceOne }])` |
| **sqlitekit** | ✓ via `bulkWrite([{ replaceOne }])` AND `replace(id, doc)` (sqlitekit ≥0.4.0). Routes through `replaceById` (UPDATE with explicit NULLs for omitted columns) so SCIM PUT semantics are honored — omitted fields don't survive. |
| **prismakit** | varies |
| **Custom kit (only `MinimalRepo`)** | ✗ — 501 |

If your IdP requires PUT semantics and your kit doesn't expose `bulkWrite`, two options: (1) ask the kit team to add it, (2) configure your IdP to use PATCH instead (Okta / Azure AD both support PATCH-only flows).

## Quick start

```typescript
import { scimPlugin } from "@classytic/arc/scim";

await app.register(scimPlugin, {
  users: { resource: userResource },     // your existing arc resource
  groups: { resource: orgResource },     // optional
  bearer: process.env.SCIM_TOKEN,        // OR: verify: async (req) => …
});
```

That's it. Endpoints mounted: `GET/POST/PUT/PATCH/DELETE /scim/v2/Users[/:id]`, same for `Groups`, plus `ServiceProviderConfig` / `ResourceTypes` / `Schemas` discovery.

## Default mapping (Better Auth aligned)

If you don't override `mapping`, SCIM assumes the BA `user` / `organization` schema:

| SCIM attribute | Backend field |
|---|---|
| `id` | `id` |
| `userName` | `email` |
| `name.formatted` / `displayName` | `name` |
| `emails[].value` | `email` (primary) |
| `active` | `isActive` |
| `externalId` | `externalId` |
| `meta.created` | `createdAt` |
| `meta.lastModified` | `updatedAt` |

For non-BA schemas, override per-attribute:

```typescript
import { scimPlugin, DEFAULT_USER_MAPPING } from "@classytic/arc/scim";

await app.register(scimPlugin, {
  users: {
    resource: userResource,
    mapping: {
      attributes: {
        ...DEFAULT_USER_MAPPING.attributes,
        userName: "username",
        "name.familyName": "lastName",
      },
    },
  },
  bearer: process.env.SCIM_TOKEN,
});
```

## Filter language (RFC 7644 §3.4.2.2)

Operators supported: `eq`, `ne`, `co` (contains), `sw` (starts with), `ew` (ends with), `gt`/`ge`/`lt`/`le`, `pr` (present), `and` / `or` / `not`, grouped with `( )`.

Real production filters that work out of the box:

```
filter=userName eq "alice@acme.com" and active eq true
filter=externalId eq "ad:f3e9-..."
filter=meta.lastModified gt "2025-01-01T00:00:00Z"
```

## Auth — bearer or verify

```typescript
bearer: process.env.SCIM_TOKEN,                          // simplest
// OR
verify: async (request) => {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  const claims = await verifyJwt(auth.slice(7));
  return claims.scope?.includes("scim:write") ?? false;
},
```

Pass exactly one — `bearer` XOR `verify`. The plugin throws at boot if both / neither are configured.

## Observability

Every request emits one `ScimObservedEvent`:

```typescript
{
  resourceType: "Users" | "Groups" | "discovery",
  op: "list" | "get" | "create" | "replace" | "patch" | "delete" | "discovery.<endpoint>",
  status: number,
  durationMs: number,
  scimType?: string,        // SCIM error type when failed
  path: string,
}
```

Wire to your metrics / logging stack via `observe`:

```typescript
await app.register(scimPlugin, {
  users: { resource: userResource },
  bearer: process.env.SCIM_TOKEN,
  observe: (event) => {
    metrics.histogram("scim.duration_ms", event.durationMs, {
      op: event.op,
      status: String(event.status),
    });
  },
});
```

Default (when `observe` is omitted): `request.log.info({ scim: event }, "scim.request")` — Pino-friendly structured log line.

## Discovery endpoints

Auto-mounted; every IdP probes them during connector setup:

- `/scim/v2/ServiceProviderConfig` — capability advertisement (`patch.supported: true`, `bulk.supported: false`, `oauthbearertoken` auth)
- `/scim/v2/ResourceTypes` — `User` (always) + `Group` (when `groups` binding present)
- `/scim/v2/Schemas` — id + name stub (most IdPs treat as a sanity check)

## Error envelope (RFC 7644 §3.12)

Every error response uses the canonical SCIM shape:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "400",
  "scimType": "invalidFilter",
  "detail": "Attribute 'xyz' is not filterable"
}
```

Content-Type: `application/scim+json` on every response. Parser auto-registered, idempotent on redeclare.

## What's NOT supported (yet)

- **Bulk operations** (`/Bulk`) — most IdPs don't use them; discovery advertises `bulk.supported: false`
- **EnterpriseUser extension** (`employeeNumber`, `manager`, `costCenter`) — pass-through via `mapping.attributes` works today; first-class extension support lands when a paying customer asks
- **Schema introspection beyond IDs** — `/Schemas` returns id+name only

## Production checklist

- [ ] Mount on the same host as your REST surface (no separate SCIM service)
- [ ] Rotate `SCIM_TOKEN` quarterly; use `verify` callback with short-lived JWTs for multi-IdP setups
- [ ] Wire your kit's audit plugin at the **kit** layer (mongokit: `repo.use(auditTrailPlugin())` from `@classytic/mongokit/plugins`), not via `defineResource({ audit: true })` — only the kit-layer plugin fires for SCIM writes
- [ ] Test the Okta / Azure AD connector against `playground/enterprise-auth/` before production cutover
- [ ] Confirm your kit exposes `findOneAndUpdate` (for PATCH operators) and `bulkWrite` (for PUT) — see "Feature gating" above; otherwise pick the IdP flows your kit supports

## sqlitekit gap message — RESOLVED in sqlitekit ≥0.4.0

sqlitekit ≥0.4.0 ships both asks. The original message is preserved below for historical context.

**Status of each ask:**

1. **`bulkWrite([{ replaceOne }])` with full-replace semantics — ✓ shipped.** Routes through `actions/update.replaceById` which UPDATE-with-explicit-NULLs every column omitted from the replacement. Pinned by `tests/integration/replace-and-array-ops.test.ts`. The earlier behavior (silent partial-update) is fixed; SCIM PUT clients now see the contract honored.
2. **JSON-column array policy — ✓ shipped (option a, refuse cleanly).** `findOneAndUpdate` and `updateMany` throw a clear actionable error on `$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll`, mirroring the refusal `claim()` already shipped. Arc's SCIM plugin translates the throw into `400 Bad Request` with `scimType: invalidValue`.
3. **Top-level `replace(id, doc)` — ✓ shipped.** Available alongside `bulkWrite([{ replaceOne }])`; arc can feature-detect either.

**Bonus fix:** `findOneAndUpdate` and `updateMany` now also accept raw mongo `$set` / `$unset` / `$inc` / `$setOnInsert` operator records (compiled to flat column writes via the existing `UpdateSpec` path). Previously these silently produced `near "where": syntax error` from Drizzle. SCIM PATCH operator forwarding now works on sqlitekit without an arc-side translation step.

---

### Original gap message (historical)

If your sqlitekit-backed app needs SCIM PUT (full replace) or PATCH array ops (`$push`/`$pull`), the underlying repository needs to expose two ops it currently doesn't:

> **From:** arc 2.13 SCIM consumer
>
> **Subject:** `bulkWrite` + JSON-column array operators for SCIM 2.0 PUT / PATCH
>
> **Context.** Arc 2.13 ships a SCIM 2.0 plugin that translates IdP requests onto the canonical `@classytic/repo-core/adapter` `RepositoryLike` contract. PATCH uses `findOneAndUpdate(filter, ops)` so operators (`$set` / `$unset` / `$push` / `$pull`) flow through unchanged. PUT uses `bulkWrite([{ replaceOne }])` because full-document replace isn't in `MinimalRepo`. mongokit covers both today; sqlitekit doesn't.
>
> **Asks (in priority order):**
>
> 1. **`bulkWrite([...])` with `replaceOne` support.** SCIM PUT (full replace) currently 501s on sqlitekit. The contract: `replaceOne: { filter, replacement }` should DELETE then INSERT (or UPDATE all columns) atomically. Other op types (`updateOne`, `deleteOne`) can stub or fan out to existing methods. Returning `{ matchedCount, modifiedCount }` is enough.
>
> 2. **Documented JSON-column array policy for `findOneAndUpdate`.** sqlitekit currently rejects `$push` / `$pull` on `text` (JSON) columns. Three reasonable options for the kit team to pick:
>    - **(a)** Refuse cleanly (current behaviour) — sqlitekit throws; arc 400s with `scimType: invalidValue`. Honest. Document it.
>    - **(b)** Read-modify-write helper (non-atomic). Reads the JSON, mutates, writes back. Document the non-atomicity for hosts to evaluate.
>    - **(c)** SQLite `json_insert` / `json_remove` functions. Atomic via SQL; sqlite-version dependent.
>
>    arc consumes whatever sqlitekit decides; the SCIM plugin doesn't depend on (b) or (c) being shipped.
>
> 3. **Optional: a `replace(id, doc)` top-level convenience.** If the team prefers not to expose `bulkWrite`, a kit-specific `replace(id, doc)` method on `SqliteRepository` would also unlock PUT — arc could feature-detect either path.
>
> **No urgency** — SCIM PUT can be substituted with PATCH for most IdPs (Okta / Azure AD support PATCH-only reconciliation modes). This is a "ship when natural" ask, not a blocker for any current consumer.

## See also

- [enterprise-auth.md](enterprise-auth.md) — feature matrix
- [agent-auth.md](agent-auth.md) — DPoP + capability mandates
- [`playground/enterprise-auth/`](../../../playground/enterprise-auth/) — runnable smoke
