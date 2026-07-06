# MCP

**Summary**: Model Context Protocol integration — auto-generates AI tool schemas from `defineResource()` configs. Tools enforce same permissions as REST.
**Sources**: src/integrations/mcp/.
**Last updated**: 2026-07-06.

---

## What it produces

- `mcpPlugin({ resources, auth, exclude?, include?, expose?, overrides? })` — Fastify-mounted MCP server.
- `resourceToTools(resource)` — inspects resource → CRUD tool definitions (list, get, create, update, delete) + custom routes + actions + aggregations.
- `defineTool(...)`, `definePrompt(...)` — custom tools/prompts alongside auto-generated ones.
- `buildMcpToolsFromBridges([...])` — expose AI SDK `tool()` defs over MCP without duplicating glue.
- Stateless (default) and stateful modes; session cache for stateful.

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

MCP tools run through the same [[permissions]] pipeline as REST. Hidden fields do not leak in tool schemas. Row-level filters (ownership, multi-tenant) apply. `PermissionResult.filters` flow into MCP tools exactly like REST.

When changing resource field rules, permissions, or routes → MCP tools change too. Always run `tests/integrations/mcp/`. See [[gotchas]] #16.

## Related
- [[core]] — `defineResource` shape drives tools
- [[permissions]] — tool auth identical to REST
- [[testing]] — `tests/integrations/mcp/`
