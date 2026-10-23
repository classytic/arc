# Severity rubric

Score by blast radius times likelihood of harm times how well current tests would catch it. A one-line auth bypass outranks 200 lines of duplicated CRUD.

## Critical: fix this release

- Auth or authorization bypass: unguarded identity reads, missing tenant filter, webhook signature over a parsed body.
- Data leakage: manual `toJSON` stripping, sensitive fields not `hidden`.
- Security wiring drift: a custom controller that does not forward `tenantField`; a wrong tenant config key.
- Silent failure: headers set in async `onSend`, SSE token verified inline.
- Runtime crash: `req.user._id` on a public route.

Smells: A1, A2, A5, A8, A9, A10, R8, I5. Action: stop the audit, write the hot-fix note, then continue. These ship as standalone PRs ahead of the rest.

## High: fix this quarter

- Duplicated arc behavior that will drift: five hand-written routes per entity, per-route schemas, parsing in every handler, `{ body }`-wrapped action schemas that validate nothing.
- Wrong layer: driver imports in services, hooks, routes.
- Missing capability already causing pain: hand-rolled idempotency, jobs, daily gates, aggregation, event emission.
- No mongokit: every Mongoose model with a hand-written repository class.
- Wrong default left on: `tenantField` on company-wide tables.

Smells: R1, R3, A4, A6, D1 to D4, D6, P1, P2, P6, P7, I1, I2, I4, I6. Action: rank by occurrence count.

## Medium: fix opportunistically

- Drift surface not yet harmful: manual query parsing, manual cache invalidation, hand-kept OpenAPI, reimplemented presets, hand-written MCP tools, per-route rate limits, hand-written error bodies.

Smells: R2, R4, R6, R7, R9, R10, A3, A7, D5, D7, D8, P3, P4, P5, I3. Action: bundle into the per-resource refactor PR.

## Low: fix when adjacent

- Style: `console.log`, `any`, default exports, path aliases, custom not-found handler, hand-wired auth, repeated CRUD gates, missing `displayName`.

Smells: R5, A11, P8, I7.

## Escalate one tier when

- The code is on a write path (`POST`, `PATCH`, `DELETE`).
- The path is under auth, webhooks, payments, audit or anything touching customer money (minimum high).
- Git history shows a hot-fix for a related bug.
- No tests cover the path.

## Lower one tier when

- The path is feature-flagged off in production.
- It is admin-only with fewer than five verified admins.
- A fix for the same pattern is already in flight.

## Triage examples

| Finding | Severity and grouping |
|---|---|
| 47 inline role checks across 12 resources | critical; one finding if the pattern is identical, split if it differs |
| `mongoose` imported in 8 service files | high; group by service module |
| 3 soft-delete reimplementations | medium; bundle with the resource refactor |
| `console.log` in 23 places | low; high only for the calls that log sensitive data |

## Reporting

- Top 3 critical findings in the summary, all highs in the body, mediums grouped by category ("12 manual query parsers"), lows in an appendix.
- Lead with the headline; do not dump every finding into one table.

## Effort estimate

| Critical | High | Medium | Effort |
|---|---|---|---|
| 0 | under 5 | under 10 | S: 1 to 3 days, one dev |
| 0 | 5 to 15 | 10 to 30 | M: 1 to 2 weeks, one dev |
| 1 to 3 | 5 to 15 | 10 to 30 | M+: 2 weeks, two devs; split the critical fixes |
| any | over 15 | over 30 | L: a month or more, phase it |
| over 3 | any | any | stop, fix criticals, then re-audit |

Heuristics: adjust for codebase size and test coverage.
