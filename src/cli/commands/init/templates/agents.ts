/**
 * Agent-guidance template — the always-in-context file that stops AI
 * coding agents from hand-rolling what arc already provides.
 *
 * Rationale (2.22): agents decide from (a) training priors — a million
 * Express/Mongoose repos — and (b) whatever is in context AT GENERATION
 * TIME. Arc's skills are pull-based (they fire only when triggered);
 * this file is push-based: it sits at the repo root where every agent
 * session loads it, and its core is the "about to write X → arc already
 * has Y" table. Emitted as CLAUDE.md (the most-read convention today);
 * the header tells other-agent users it doubles as AGENTS.md.
 */

import type { ProjectConfig } from "../types.js";

export function agentsGuideTemplate(config: ProjectConfig): string {
  const kit =
    config.adapter === "mongokit" ? "@classytic/mongokit (Mongoose)" : "a custom DataAdapter kit";
  return `# CLAUDE.md — agent guide for this app

> This file doubles as AGENTS.md — copy or symlink if your tool reads that name.

**This is an \`@classytic/arc\` application.** Resources are DECLARED, not hand-rolled:
one \`defineResource()\` = REST + validation + auth + permissions + events + caching +
OpenAPI + MCP tools. Data layer: ${kit}.

## The one rule

**Hand-rolling is a bug.** Before writing ANY route, validation, pagination, auth check,
cron, counter, or audit code by hand, prove arc lacks it — check the table below, then
\`node_modules/@classytic/arc/skills/arc/SKILL.md\` (full framework guide + references).

## About to write X? Arc already has Y

| If you're about to write… | Use instead |
|---|---|
| \`fastify.get/post/...\` CRUD routes for an entity | \`defineResource({ name, adapter, permissions })\` |
| \`if (req.user.role !== 'admin') return 403\` | \`permissions: { update: requireRoles(['admin']) }\` |
| Reading \`req.user._id\` / org id directly | \`getUserId(scope)\` / \`requireOrgId(scope)\` from \`@classytic/arc/scope\` |
| Hand-written \`schema: { body }\` / JSON Schema | \`schemaOptions.fieldRules\` (or \`customSchemas\` for wire≠model) |
| toJSON transforms hiding \`password\`/internals | \`fieldRules: { password: { hidden: true } }\` |
| Manual \`req.query\` filter/sort/pagination parsing | the resource's \`queryParser\` (allow-listed fields) |
| Soft delete / slug lookup / tree / bulk / file upload | \`presets: ['softDelete', 'slugLookup', ...]\` |
| \`setInterval\` sweeps + hand-rolled leader lock | \`schedulesPlugin\` (\`@classytic/arc/plugins\`) |
| A background/queue worker entrypoint | \`createWorker(sameOptions)\` (\`@classytic/arc/factory\`) |
| Usage counters / quotas / plan rate limits | \`usagePlugin\` + \`requireQuota\` + \`rateLimit.plan\` |
| Audit log rows / "who changed what" endpoints | \`audit: true\` + \`history: true\` on the resource |
| Manual idempotency keys / dedupe | \`idempotencyPlugin\` |
| Event emitters / webhooks plumbing | \`eventPlugin\` + resource \`events:\` (+ outbox for guarantees) |
| Custom MCP/AI tool handlers | generated automatically from every resource |

## Load-bearing conventions

- \`request.user\` is \`undefined\` on public routes — always guard.
- Never read \`scope.organizationId\` directly — use \`@classytic/arc/scope\` accessors.
- The DB connection belongs in \`createApp({ beforeBoot })\` — not before \`createApp\`.
- Custom endpoints: \`routes:\`/\`actions:\` on the resource (they inherit auth/permissions/
  OpenAPI/MCP) — a bare \`fastify.get()\` gets none of that.

## Commands

\`\`\`bash
npm run dev        # watch mode
npm test           # vitest
npx arc generate resource <name>   # scaffold a resource (model/repo/resource files)
npx arc describe   # list registered resources + routes
\`\`\`
`;
}
