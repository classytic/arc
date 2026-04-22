# MCP

**Summary**: Model Context Protocol integration — auto-generates AI tool schemas from `defineResource()` configs. Tools enforce same permissions as REST.
**Sources**: src/integrations/mcp/.
**Last updated**: 2026-04-21.

---

## What it produces

- `createMcpServer({ resources, auth })` — Fastify-mounted MCP server.
- `resourceToTools(resource)` — inspects resource → CRUD tool definitions (list, get, create, update, delete).
- `defineTool(...)`, `definePrompt(...)` — custom tools/prompts alongside auto-generated ones.
- Stateless and stateful modes; session cache for stateful.

## Auth

- `auth: true` (default) — requires JWT/session; populates `ctx.user` and [[request-scope]].
- `auth: false` — `ctx.user` is `null` (not `"anonymous"`). Permission guards still work correctly. See [[gotchas]] #6.

Service-scope auth supported: machine tokens install `service` kind on scope — see [[request-scope]].

## Permission parity

MCP tools run through the same [[permissions]] pipeline as REST. Hidden fields do not leak in tool schemas. Row-level filters (ownership, multi-tenant) apply.

When changing resource field rules, permissions, or routes → MCP tools change too. Always run `tests/integrations/mcp/`. See [[gotchas]] #10.

## Related
- [[core]] — `defineResource` shape drives tools
- [[permissions]] — tool auth identical to REST
- [[testing]] — `tests/integrations/mcp/`
