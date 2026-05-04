---
name: arc-code-review
description: |
  Audit a client codebase that has @classytic/arc installed for gaps in arc-convention adoption.
  Surfaces hand-rolled CRUD/auth/query/cache code that should be one defineResource() call,
  Mongoose models that should use @classytic/mongokit, manual JSON Schema that should be fieldRules,
  bypassed RequestScope, missing presets, and other patterns that defeat arc's "less code, more
  maintainability" promise. Produces a prioritized migration report with before/after recipes.
  Use when reviewing/auditing a downstream project that depends on @classytic/arc, when the
  user asks for an "arc audit", "arc gap analysis", "arc migration plan", "why isn't arc helping
  us", or when refactoring a Fastify/Express service to arc conventions.
  Triggers: arc audit, arc review, arc gap, arc migration, arc convention check, arc compliance,
  classytic audit, defineResource refactor, mongoose to mongokit, hand-rolled crud to arc,
  arc adoption, arc lint, arc smell, arc anti-pattern.
license: MIT
metadata:
  author: Classytic
tags:
  - arc
  - code-review
  - audit
  - migration
  - refactor
  - fastify
  - mongoose
  - mongokit
  - convention-check
progressive_disclosure:
  entry_point:
    summary: "Audit a client codebase using @classytic/arc for unrealized convention gains. Detect hand-rolled CRUD/auth/query/cache, Mongoose-without-mongokit, bypassed scope, and emit a prioritized migration report."
    when_to_use: "Reviewing or migrating a project that has arc installed but hasn't adopted defineResource()/presets/permissions/scope/mongokit. Use whenever the user asks 'why isn't arc helping us' or wants a gap analysis."
    quick_start: "1. Confirm arc/mongokit versions  2. Run detection sweep (references/anti-patterns.md)  3. Score each finding (references/severity.md)  4. Emit report using template below"
  context_limit: 900
---

# arc-code-review

Audit skill for client projects that depend on `@classytic/arc`. Detects places where the team is writing code arc would have generated, then emits a prioritized migration plan with concrete before/after diffs.

## When to use

Invoke when:
- The user asks for an "arc audit", "arc gap analysis", "arc migration plan", or "why isn't arc helping us".
- A repo `dependsOn @classytic/arc` (or `@classytic/mongokit`) and the conversation is about refactoring, code-review, or onboarding.
- The user mentions hand-rolled CRUD, manual JSON Schema, raw `req.user` access, manual `Model.find()` in route handlers, or hand-written OpenAPI alongside arc.
- Migrating a Fastify/Express service to arc conventions.

**Do NOT use** for arc framework development itself — that's the `arc` skill in `skills/arc/`. This skill audits *consumers* of arc.

## Mental model — what arc replaces

One `defineResource()` call **replaces all of these** in a typical Fastify service:

| Hand-rolled today | Arc capability that subsumes it | Reference |
|---|---|---|
| 5 × `fastify.get/post/patch/delete` per resource | CRUD auto-generation | [arc-cheatsheet.md](references/arc-cheatsheet.md) |
| `if (req.user.role !== 'admin')` inside handler | `permissions: { create: requireRoles(['admin']) }` | [anti-patterns.md §4](references/anti-patterns.md) |
| Manual `req.query.filter` parsing, `$or`/`$and` building | `ArcQueryParser` / mongokit `QueryParser` | [anti-patterns.md §1](references/anti-patterns.md) |
| Hand-written `schema: { body, response }` per route | `schemaOptions.fieldRules` | [anti-patterns.md §2](references/anti-patterns.md) |
| `schema.set('toJSON', { transform })` to strip `password`/`__v` | `fieldRules: { password: { hidden: true } }` | [anti-patterns.md §5](references/anti-patterns.md) |
| Hand-maintained `openapi.yaml` / `swagger.json` | `arc docs ./openapi.json` | [anti-patterns.md §6](references/anti-patterns.md) |
| `eventBus.emit('product.created', ...)` in handler | `events: { created: {} }` (auto-emitted) | [anti-patterns.md §7](references/anti-patterns.md) |
| `cache.del('products-*')` after mutation | `cache: { tags: ['catalog'] }` (auto-invalidated) | [anti-patterns.md §8](references/anti-patterns.md) |
| `req.user._id`, `req.user.orgId` direct access | `getUserId(scope)`, `getOrgId(scope)` from `@classytic/arc/scope` | [anti-patterns.md §9](references/anti-patterns.md) |
| `import mongoose from 'mongoose'` in route/service files | Adapter-only via `createMongooseAdapter` | [anti-patterns.md §10](references/anti-patterns.md) |
| Soft-delete: `/deleted` route + `deletedAt` field + restore handler | `presets: ['softDelete']` | [anti-patterns.md §14](references/anti-patterns.md) |
| `class UserRepository { async create() { Model.create() } }` | `new Repository(Model)` (mongokit) | [mongokit-migration.md](references/mongokit-migration.md) |
| Per-schema `schema.pre('save', ...)` for timestamps/validation | `timestampPlugin()`, `validationChainPlugin()` | [mongokit-migration.md](references/mongokit-migration.md) |
| Hand-written `name === 'admin'` MCP tool handlers | `mcpPlugin({ resources })` (auto-generated) | [anti-patterns.md §15](references/anti-patterns.md) |

## Audit workflow

1. **Confirm arc is actually installed.** Read root `package.json`. Note `@classytic/arc`, `@classytic/mongokit`, `@classytic/repo-core`, `@classytic/sqlitekit` versions. If arc is absent, this skill doesn't apply — recommend `npx @classytic/arc init` instead.
2. **Locate the entry point.** Search for `createApp(` or `defineResource(` to see what arc surface is already in use. Note `auth`, `runtime`, `arcPlugins`, `presets` config.
3. **Inventory resources.** For each `defineResource()` call: list `name`, `permissions`, `presets`, `cache`, `schemaOptions`, custom `routes`/`actions`. Compare to what's used.
4. **Run the detection sweep.** Walk every section of [anti-patterns.md](references/anti-patterns.md). For each pattern, run the listed grep against `src/` (excluding `node_modules`, `dist`, `test*`). Record file:line of each hit.
5. **Score findings.** Apply [severity.md](references/severity.md) rubric (critical / high / medium / low). Critical = security gap or duplicated arc behavior that drifts. Low = cosmetic.
6. **Cross-check mongokit adoption.** If `mongoose` is a direct dep but `@classytic/mongokit` is not, every model is a candidate for migration. Use [mongokit-migration.md](references/mongokit-migration.md).
7. **Check arc CLI scaffolding hygiene.** Look for `.arcrc`, `arc generate resource` output structure (`{name}.model.ts`, `{name}.repository.ts`, `{name}.resource.ts`). Mismatch = team is hand-creating files. See [scaffolding.md](references/scaffolding.md).
8. **Emit the report** using the template below.

## Reporting template

```markdown
# Arc Convention Audit — <project-name>

**Arc version:** 3.0.x · **Mongokit:** <version or "not installed"> · **Sqlitekit:** <version or "n/a"> · **Date:** <YYYY-MM-DD>
**Files scanned:** <N> · **Findings:** <N critical · <N high · <N medium · <N low>

## Executive summary
- <1-2 sentences: how much manual code could be deleted, biggest single risk>
- Estimated LOC removable: ~<N> lines across <N> files
- Estimated effort: <S/M/L> per resource (<N> resources affected)

## Critical findings
### C1. <short title> (<N occurrences>)
**Pattern:** <what's wrong, in 1 sentence>
**Locations:** `src/foo/bar.ts:42`, `src/foo/baz.ts:118`, ...
**Why it matters:** <security / drift / maintainability impact>
**Fix:** <link to migration recipe>

## High / Medium / Low findings
(same shape)

## Migration plan (recommended order)
1. <Step 1 — usually scope/permissions because they're security-critical>
2. <Step 2 — usually CRUD consolidation>
3. ...

## Per-resource scorecard
| Resource | defineResource? | presets used | permissions | cache | events | mongokit | Score |
|---|---|---|---|---|---|---|---|
| product | ✅ | softDelete | ✅ | ❌ | manual | ❌ | 6/10 |
```

## Severity quick rule

- **Critical:** auth bypass, scope leak, fields exposed that should be `hidden`, hand-rolled idempotency that diverges from arc's behavior under load.
- **High:** duplicated CRUD that will rot (one resource gets a fix the others don't), manual permissions instead of combinators, mongoose imports leaking outside adapters.
- **Medium:** manual query parsing, manual cache invalidation, missing presets, hand-written OpenAPI.
- **Low:** style (default exports, `console.log`, `any`), naming conventions, missing `displayName`/`module` metadata.

Full rubric → [severity.md](references/severity.md).

## Output discipline

- **Cite file:line for every finding.** Do not generalize.
- **Show the before/after diff** for the first occurrence of each pattern. Subsequent occurrences just list locations.
- **Quote arc's exact API** in fixes (e.g., `requireRoles(['admin'])` from `@classytic/arc`, not "use arc's role helper").
- **Sort by severity, then by file count.** A pattern repeated 30× outranks an isolated critical bug for migration ROI.
- **Distinguish "missing arc feature" from "arc misuse".** The first is opportunity; the second is a bug.
- **Don't recommend arc features the project hasn't enabled.** If `arcPlugins.queryCache: false`, don't suggest cache tags — recommend enabling it first.

## References

- **[anti-patterns.md](references/anti-patterns.md)** — every greppable anti-pattern with detection regex, severity, and fix
- **[migration-recipes.md](references/migration-recipes.md)** — concrete before/after diffs (manual CRUD → defineResource, manual perms → combinators, manual events, etc.)
- **[mongokit-migration.md](references/mongokit-migration.md)** — Mongoose-only project → mongokit Repository + plugins
- **[arc-cheatsheet.md](references/arc-cheatsheet.md)** — what arc provides at a glance (defineResource fields, presets, permissions, scope, hooks, events, cache, MCP)
- **[scaffolding.md](references/scaffolding.md)** — arc CLI (`init`, `generate resource`, `docs`, `introspect`, `doctor`), `.arcrc`, file conventions
- **[severity.md](references/severity.md)** — severity rubric and triage examples
