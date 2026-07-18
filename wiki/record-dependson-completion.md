# Record — `dependsOn` module ordering (completion, 2026-07-06, arc 2.20.0)

Point-in-time verification record. The living documentation is
[[modules]] § "dependsOn — composition order without list-position coupling";
this file only preserves what shipped and the evidence.

**Shipped** (all in `src/factory/module.ts`, consumed by `registerResources.ts`):
`ArcModule.dependsOn` (composition order, NOT lazy loading); `orderModules()`
stable Kahn topo-sort with a no-edges fast path (arrays without `dependsOn`
return unchanged); fail-fast graph validation before any infra runs
(duplicate / missing / self-reference / cycle-with-printed-path); the module
`plugins` phase; typed `ArcModuleRegistry` + throwing `getModuleExports`.

**Verification:**

| Evidence | Result |
|---|---|
| `tests/factory/order-modules.test.ts` + `modules.test.ts` (ordering, stable tiebreak, all four diagnostics, diamond, plugins phase) | 35 tests green |
| Full arc suite at completion | 5615 green |
| be-prod (69k-LOC ERP, ZERO `dependsOn` edges by design → exercises the fast path) on arc 2.20.0 | 2829 tests / 251 files green — primitive invisible to existing hosts |

**Adopter guidance** lives in [[modules]] (prefer ports/events over edges;
cycles mean the boundary is wrong; canonical real edge: `reservation dependsOn order`).
