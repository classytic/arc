# Severity Rubric

Score every finding by **blast radius × likelihood of harm × ease of detection in current tests**. Don't grade by code volume — a one-line auth bypass beats 200 lines of duplicated CRUD.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## 🔴 Critical — fix this release

A finding is **critical** if it meets any of:

- **Auth/authorization bypass.** `req.user.role` accessed without scope guard on a public route, missing tenant filter, hand-rolled idempotency that double-charges under retry, webhook signature verification on parsed body.
- **Data leakage.** Manual `toJSON` transform with sensitive fields not declared `hidden`. New sensitive fields (added later) inherit the leak silently.
- **Drift in security-critical wiring.** Custom controller that doesn't forward `tenantField`, so multi-tenant injection silently fails.
- **Silent failure modes.** Headers set in `onSend` (intermittent `ERR_HTTP_HEADERS_SENT` under load), `failOpen` events on a path that needs delivery guarantees.
- **Runtime crashes.** `req.user._id` access on `allowPublic()` routes (crashes only when unauthenticated request hits — usually missed in dev).

**Examples (from anti-patterns.md):** §4, §5, §9, §17, §18, §25, §27, §32.

**Action:** stop the audit, write a hot-fix recommendation, then continue. These can ship as standalone PRs ahead of the broader migration.

---

## 🟠 High — fix this quarter

A finding is **high** if:

- **Duplicated arc behavior** that *will* drift. Five `fastify.get/post/patch/delete` calls per resource where one `defineResource` would do — one resource gets a fix the others don't.
- **Wrong abstraction layer.** Driver imports (`mongoose`, `@prisma/client`, `drizzle-orm`) leaking into `services/`, `hooks/`, `routes/`. Forces every consumer to pull a database driver; complicates testing.
- **Missing arc capability** that's already a pain point. Manual idempotency, manual rate-limiting, manual event emission inconsistency, hand-rolled audit trail. The team is building tools arc already provides.
- **Whole-suite refactor.** No mongokit adoption (§28). Each Mongoose model is a 100+ LOC reduction.

**Examples:** §3, §7, §10, §19, §20, §22, §28.

**Action:** prioritize by occurrence count. A pattern repeated 30 times outranks an isolated high.

---

## 🟡 Medium — fix opportunistically

A finding is **medium** if:

- **Drift surface, not yet harmful.** Manual query parsing where the fields parsed are well-known and stable; manual cache invalidation where the cache strategy works today but breaks on rollout.
- **Documentation drift.** Hand-maintained OpenAPI/Swagger that's currently in sync but will inevitably diverge.
- **Preset adoption gap.** Soft-delete/multi-tenant/bulk wired manually instead of via preset. Code works but doesn't benefit from preset upgrades.
- **Style of contract.** Custom controller without forwarding hooks (works today, breaks when arc updates).

**Examples:** §1, §2, §6, §8, §14, §16, §21, §23, §24, §26.

**Action:** bundle into resource-by-resource refactor PRs. Don't open a separate "fix all medium" PR.

---

## 🟢 Low — fix when adjacent

A finding is **low** if:

- **Code-style only.** `console.log`, `any`, `@ts-ignore`, default exports, tsconfig path aliases breaking auto-discovery.
- **Cosmetic config.** Missing `displayName` / `module` on `defineResource`, no `arc-cheatsheet` subpath imports, missing `arc docs` script in package.json.
- **Nicety, not problem.** Manual auth registration instead of `createApp({ auth })` — works fine if app is small.

**Examples:** §11, §12, §13, §29, §30, §31.

**Action:** fix when touching the file for another reason. Don't write a dedicated PR.

---

## Triage examples

### "Found 47 manual permission checks across 12 resources"
🔴 Critical (auth surface) → list each as a separate finding **only if** the check pattern differs. If they're all `if (!req.user.roles.includes('admin')) throw ...`, group as one finding with 47 occurrences.

### "Found `mongoose` imported in 8 service files"
🟠 High → architectural. Group by service module, not file, since a service rewrite touches all files in the module together.

### "Found 3 separate `softDelete` reimplementations across resources"
🟡 Medium → preset adoption. Bundle with the resource refactor.

### "Found `console.log` in 23 places"
🟢 Low → unless any are inside a hot path with sensitive data (then escalate to High for *those* specific calls).

---

## When to escalate severity

Escalate one tier higher if:

- **The pattern is in a write path.** Any pattern in `POST/PATCH/DELETE` is one tier worse than the same pattern in `GET`.
- **The pattern is in `auth/`, `webhooks/`, `payments/`, `audit/`, or anything customer-money-touching.** All findings in these paths are at minimum 🟠.
- **The team has been bitten before.** If `git log` shows a hot-fix commit for a related bug, the underlying pattern is at minimum 🟠.
- **No tests cover the path.** A medium pattern with no test cover is high — drift will land in prod.

Escalate one tier lower if:

- **The path is feature-flagged off** in production.
- **The path is admin-only and there are <5 admins** with manually verified scope.
- **A migration is already in flight** for this pattern (don't double-count).

---

## Reporting cadence

For a single audit:

- **Top 3 criticals** in the executive summary.
- **All highs** in the body.
- **Mediums grouped by category** (one row each: "12× manual query parsing").
- **Lows in an appendix** or omitted.

Don't dump every finding into one giant table — readers will skip. Give them the headline first.

---

## Score → migration estimate

Rough conversion for the executive summary's "estimated effort" line:

| Critical findings | Highs | Mediums | Lows | Effort |
|---|---|---|---|---|
| 0 | <5 | <10 | any | S (1–3 days, 1 dev) |
| 0 | 5–15 | 10–30 | any | M (1–2 weeks, 1 dev) |
| 1–3 | 5–15 | 10–30 | any | M+ (2 weeks, 2 devs — split critical fixes) |
| any | >15 | >30 | any | L (1 month+, plan in phases) |
| >3 | any | any | any | Stop the audit, raise critical fixes first, then re-audit |

These are heuristics. Adjust for codebase size and test coverage.
