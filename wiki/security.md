# Security Checklist

**Summary**: Run through this list whenever you touch auth, permissions, MCP, events, or data handling.
**Sources**: AGENTS.md §12.
**Last updated**: 2026-04-21.

---

- [ ] `isRevoked` remains fail-closed (errors = denied). See [[auth]].
- [ ] Public routes: `request.user` is `undefined` — code guards properly. See [[gotchas]] #1.
- [ ] Field permissions: hidden fields not leaked in responses or MCP schemas. See [[permissions]], [[mcp]].
- [ ] Permission filters: row-level filters from `requireOwnership` / `multiTenant` cannot be bypassed via query manipulation. See [[presets]].
- [ ] Event data: sensitive fields stripped before publishing. See [[events]].
- [ ] MCP auth: tools enforce same permissions as REST endpoints. See [[mcp]].
- [ ] Session ownership: validate session belongs to requesting user. See [[auth]].
- [ ] Body sanitization: immutable fields stripped on update. See [[core]].
- [ ] Rate limiting: scoped per tenant when multi-tenant. See [[plugins]].
- [ ] Idempotency: body hash prevents replay with different payloads. See [[plugins]].
- [ ] Webhook signatures: verify against `req.rawBody`, not parsed `req.body`. See [[gotchas]] #14.
- [ ] multiTenant: org injection runs on UPDATE (v2.9). See [[gotchas]] #12.

## Related
- [[gotchas]] — numbered trap list
- [[permissions]], [[auth]], [[events]], [[mcp]]
