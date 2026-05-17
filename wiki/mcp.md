# MCP

**Summary**: Model Context Protocol integration — auto-generates AI tool schemas from `defineResource()` configs. Tools enforce same permissions as REST.
**Sources**: src/integrations/mcp/.
**Last updated**: 2026-05-18.

---

## What it produces

- `mcpPlugin({ resources, auth, exclude?, include?, expose?, overrides? })` — Fastify-mounted MCP server.
- `resourceToTools(resource)` — inspects resource → CRUD tool definitions (list, get, create, update, delete) + custom routes + actions + aggregations.
- `defineTool(...)`, `definePrompt(...)` — custom tools/prompts alongside auto-generated ones.
- `buildMcpToolsFromBridges([...])` — expose AI SDK `tool()` defs over MCP without duplicating glue.
- Stateless (default) and stateful modes; session cache for stateful.

## Per-resource opt-out (2.16)

`defineResource({ mcp: false })` excludes a resource from MCP tool generation entirely. Evaluated FIRST inside `filterResourcesForMcp` — local opt-out is authoritative, runs before plugin-level `expose` / `include` / `exclude` filtering. Co-locates the decision with the resource definition instead of a central blocklist that drifts.

## Auth

- `auth: getAuth()` — Better Auth OAuth 2.1 flow; populates `ctx.user` and [[request-scope]].
- Custom function — returns `{ userId, organizationId, roles }` (human) or `{ clientId, organizationId, scopes }` (service).
- `auth: false` — `ctx.user` is `null` (not `"anonymous"`). Permission guards still work correctly. See [[gotchas]] #17.

Service-scope auth supported: machine tokens install `service` kind on scope — see [[request-scope]].

## Permission parity

MCP tools run through the same [[permissions]] pipeline as REST. Hidden fields do not leak in tool schemas. Row-level filters (ownership, multi-tenant) apply. `PermissionResult.filters` flow into MCP tools exactly like REST.

When changing resource field rules, permissions, or routes → MCP tools change too. Always run `tests/integrations/mcp/`. See [[gotchas]] #16.

## Related
- [[core]] — `defineResource` shape drives tools
- [[permissions]] — tool auth identical to REST
- [[testing]] — `tests/integrations/mcp/`
