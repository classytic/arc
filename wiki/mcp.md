# MCP

**Summary**: Model Context Protocol integration — auto-generates AI tool schemas from `defineResource()` configs. Tools enforce same permissions as REST.
**Sources**: src/integrations/mcp/.
**Last updated**: 2026-10-28 (2026-07-28 only: 2025 era and stateful mode removed; `ctx.log` server-side).

---

**List-tool dispatch verbs (2.22)**: the list tool advertises `_count` / `_exists` / `_distinct` — REST's `?_count=true` family with identical permission/filter/tenant semantics (same controller dispatch), zero documents fetched. Cheapest way for an agent to answer "how many" / "any?" / "which values".

## What it produces

- `mcpPlugin({ resources, auth, exclude?, include?, expose?, overrides? })` — Fastify-mounted MCP server.
- `resourceToTools(resource)` — inspects resource → CRUD tool definitions (list, get, create, update, delete) + custom routes + actions + aggregations.
- `defineTool(...)`, `definePrompt(...)` — custom tools/prompts alongside auto-generated ones.
- `buildMcpToolsFromBridges([...])` — expose AI SDK `tool()` defs over MCP without duplicating glue.
- One mode: protocol **2026-07-28 only**, a fresh server per request, no sessions.

## SDK contract (`@modelcontextprotocol/*` 2.x)

- **`createMcpHandler(factory, { legacy: 'reject' })` + `toNodeHandler`.** Only 2026-07-28 is served (per-request `_meta` envelope, `server/discover`); a 2025 `initialize` gets the SDK's `400` / `-32022` naming the supported revision. Arc resolves auth FIRST, then hands identity to the factory as `AuthInfo` (`toSdkAuthInfo` / `fromSdkAuthInfo`, full result under `extra.arcAuth`) — never via a shared ref. GET/DELETE → arc's own 405 + `Allow: POST`.
- **No sessions, so no stateful mode.** It only ever served 2025 clients; `stateful: true` throws at boot. Nothing arc does needs server→client push: it sends no list-changed or resource-updated notifications, and `realtimeBridge` is an in-process dispatcher, not a transport. Change events, if ever needed, go through `handler.notify` (`subscriptions/listen`), not sessions.
- **Registration arity.** The SDK calls a schema-less tool as `(ctx)` and a schema-less prompt as `(ctx)`. `createMcpServer` registers one-argument callbacks there; the two-argument form fed the SDK context in as the tool's INPUT.
- **Flat shapes are wrapped by arc** (`z.object`) — the SDK's raw-shape overloads are `@deprecated`. A whole schema (`~standard`) passes through.
- **Annotations are explicit.** Spec defaults are cautious (`destructiveHint`/`openWorldHint` default TRUE), so CRUD sets every hint (`openWorldHint: false`); custom routes map by HTTP method (`routeAnnotations`), leaving `openWorldHint` unset.
- **401 under Better Auth** carries `WWW-Authenticate: Bearer resource_metadata=…`; custom resolvers get none (often API-key gates).
- **`ctx.log` is server-side** (`createMcpServer({ logger })`; `mcpPlugin` passes `fastify.log`), tagged `{ mcpTool }`. SEP-2577 deprecates protocol logging; `ctx.mcpReq.log` was a silent no-op anyway — arc never declares the `logging` capability.
- **Test harness** (`./mcp/testing`): the SDK `InMemoryTransport` pair, server side through `serveStdio(() => server, { transport, legacy: 'reject' })`, client pinned to 2026-07-28. One connection per server instance. HTTP-leg behaviour (401, 405, -32022) lives in `mcp-protocol-version.test.ts`.
- **Deliberately not adopted**: no `structuredContent` on CRUD results (no `outputSchema` to validate it, and it doubles the payload); no `inputRequired` — arc never asks the client for input.

## Tool input schemas — REST parity (2.20)

Auto-generated tools advertise the same query capabilities the REST layer exposes; both flow through `QueryResolver`, so the tool schema is the only thing that had to catch up:

- **list** — `page`/`limit` (offset) **and** `cursor` (keyset, stable under concurrent inserts; when set, `page` is ignored), plus `sort`, `search`, `select`, `populate`. Keyset paging was already in repo-core + mongokit + REST; 2.20 surfaces it on the tool.
- **get** — `select` field projection alongside `id` (same `select` semantics as list). `delete` stays id-only.

Schema lives in `input-schema.ts` (`buildInputSchema`) + the shared `PAGINATION_SHAPE`/`PROJECTION_FIELD` in `fieldRulesToZod.ts`.

## Per-resource opt-out (2.16)

`defineResource({ mcp: false })` excludes a resource from MCP tool generation entirely. Evaluated FIRST inside `filterResourcesForMcp` — local opt-out is authoritative, runs before plugin-level `expose` / `include` / `exclude` filtering. Co-locates the decision with the resource definition instead of a central blocklist that drifts.

## Auth

- `auth: getAuth()` — Better Auth OAuth 2.1 flow; populates `ctx.user` and [[request-scope]].
- `auth: createMcpAuthFromBetterAuthApiKey(getAuth(), opts?)` (2.17.0) — Better Auth API-key plugin → MCP. Wraps `auth.api.verifyApiKey`, normalises `key.referenceId ?? key.userId → userId`, extracts org from `metadata.organizationId` (override `orgFromMetadata` for custom paths). Keys with neither user binding nor referenceId surface as service principals via `clientId`. Disabled/expired keys + verifier exceptions return null (fail-closed).
- Custom function — returns `{ userId, organizationId, roles }` (human) or `{ clientId, organizationId, scopes }` (service).
- `auth: false` — `ctx.user` is `null` (not `"anonymous"`). Permission guards still work correctly. See [[gotchas]] #17.

Service-scope auth supported: machine tokens install `service` kind on scope — see [[request-scope]].

## Tool-name collisions (2.17.0)

`createMcpServer` resolves duplicate tool names BEFORE the MCP SDK sees them — the SDK's native `Tool already registered` error gave zero source attribution. Two outcomes:

- **Preset vs user** — auto-namespaces the preset side. `softDelete` preset's `restore_<resource>` becomes `softdelete_restore_<resource>` when the user declares `actions.restore`; user's tool keeps the canonical name.
- **Every other shape** (two user actions, two routes, two presets, three-way+) throws `ArcError('arc.mcp.tool_name_collision')` naming both sources. Stack trace points at resource definitions, not MCP SDK internals.

Tool `source` strings: `crud:<resource>:<op>`, `action:<resource>:<name>`, `route:<resource>:<METHOD> <path>`, `preset:<presetName>:<resource>:<op>`.

## Permission parity

MCP tools run through the same [[permissions]] pipeline as REST. Hidden fields do not leak in tool schemas. Row-level filters (ownership, multi-tenant) apply. `AuthorizationDecision.policy` filters flow into MCP tools exactly like REST.

Tenant preset middleware carries a transport-neutral preparation descriptor.
`permissions/tenantPreparation.ts` resolves all org/team/custom dimensions and conjoins
policies for REST and MCP CRUD, actions, opted-in custom routes, and aggregations.
Missing required dimensions fail before repository access; cross-tenant read
markers and trusted write stamping follow the same declaration on both transports.
Idempotency identities include principal kind, organization, team and custom scope;
request fingerprints are checked separately, so changed input under one key is 422.

When changing resource field rules, permissions, or routes → MCP tools change too. Always run `tests/integrations/mcp/`. See [[gotchas]] #16.

## Execution wiring — full pipeline parity (2.23)

The controller pipeline reads its wiring off the REQUEST context (`metadata.arc.hooks`, `ctx.server`, `ctx.scope`) — stamped by the arc decorator on HTTP. `McpExecutionWiring` restores the same on the synthetic path:

- **`mcpPlugin` wires automatically** (lazy getters over `fastify.arc.hooks` / `events` / `audit` / `log` / `idempotency.store`) — registration order doesn't matter for execution; register `idempotencyPlugin` before `mcpPlugin` only if you want `_idempotencyKey` advertised in tool schemas.
- **Hooks + events**: resource hooks (before/around/after) now run on MCP calls, so the arcCorePlugin after-hook publishes `<resource>.<op>d` events — realtime feeds, webhooks, and subscribers see agent-originated mutations. Pre-2.23 they silently no-oped.
- **Field-read masking** (`applyMcpReadMasking`): `fields.hidden()`/`visibleTo()`/`redactFor()` apply to every tool family's output — CRUD, custom routes, actions, aggregation rows — with HTTP-identical semantics (elevated bypass, user∪org roles).
- **Idempotency**: mutating CRUD tools accept `_idempotencyKey` when a store is wired. One operation/principal/tenant identity is separate from the body fingerprint: same key with changed input returns 422 `arc.idempotency_key_reused`. The executor rechecks completion after acquiring the lock and fences recording with `setIfLocked`; lease loss returns 409. Both transports refuse unfenced stores by default; `allowUnfencedCompletion: true` is the explicit warning-producing migration escape. Errors are never cached. See [[plugins]] for storage migration and effect-level limits.
- **Rate limits**: resource budgets share the host store across REST and MCP; explicit custom-route overrides retain separate buckets. Permission and tenant refusals precede budget consumption; cached/idempotent successes still consume it. Standalone tools use bounded memory unless a limiter is wired.
- **Standalone** `resourceToTools()` / `createTestMcpClient()` callers pass `{ wiring }` themselves, or omit it for legacy dispatch-only tools.

Fastify lifecycle hooks remain HTTP-specific. Put cross-transport authorization in permission checks and tenant presets; synthetic execution restores the declared controller hooks, events, masking, audit and idempotency wiring.

Pinned by `tests/integrations/mcp/mcp-execution-parity.test.ts` + `mcp-field-masking.test.ts`.

## Related
- [[core]] — `defineResource` shape drives tools
- [[permissions]] — tool auth identical to REST
- [[testing]] — `tests/integrations/mcp/`
