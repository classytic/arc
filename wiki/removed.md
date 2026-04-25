# Removed APIs

**Summary**: APIs removed by version, with migration targets. Do not re-add without a strong reason.
**Sources**: CHANGELOG.md, commit history.
**Last updated**: 2026-04-21.

---

## v2.10

| Removed | Replacement | Why |
|---|---|---|
| `@classytic/arc/policies` | `@classytic/arc/permissions` | Policy engine duplicated [[permissions]] (RBAC, ownership, tenant filters via `requireOrgInScope`) |
| `@classytic/arc/rpc` | External HTTP client of choice | Orphaned; no internal users |
| `@classytic/arc/dynamic` (`ArcDynamicLoader`) | `factory/loadResources` | Two filesystem loaders was one too many. See [[factory]] |

## v2.9

| Removed | Replacement |
|---|---|
| `createActionRouter`, `buildActionBodySchema` | `defineResource({ actions: { ... } })` |
| `ResourceConfig.onRegister` | `actions` or resource `hooks` |
| `PluginResourceResult.additionalRoutes` | Return `routes: RouteDefinition[]` from plugins |

## v2.5.2

| Removed | Replacement |
|---|---|
| `toPlugin()` on factory | `createApp({ resources })` directly. See [[factory]] |

## Related
- See [`/changelog/v2.md`](../changelog/v2.md) for the full release history with replacement context.
