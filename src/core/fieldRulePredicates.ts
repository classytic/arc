/**
 * Field-rule predicates — single source of truth for "which fields are
 * allowed in responses / select / distinct / aggregations / etc."
 *
 * arc's `fieldRules` carry several flags with overlapping but distinct
 * intent. Concentrating the rules here prevents the historical bug where
 * different code paths used different combinations of flags to mean the
 * same thing. Specifically: `systemManaged` is a **write rule** (the
 * server stamps the value, clients can't PATCH it) — it does NOT control
 * visibility. Conflating it with `hidden` is what caused the aggregation,
 * `_distinct`, and `select=` strips to over-block legitimate reads of
 * server-stamped fields like `createdAt` / `status` / `priority`.
 *
 * Visibility / read decisions:
 *   - `hidden: true` → omit from responses, don't accept in `select`,
 *     don't expose via `_distinct`, don't aggregate (unless
 *     `aggregable: true` overrides on agg).
 *   - everything else → readable.
 *
 * Write decisions (handled in BodySanitizer / mergeFieldRuleConstraints
 * — NOT here):
 *   - `systemManaged` / `readonly` / `immutable` → strip on writes.
 *
 * Aggregation decisions (handled in `aggregation/validate.ts`):
 *   - default = block iff `hidden`
 *   - `aggregable: true` overrides hidden (escape hatch)
 *   - `aggregable: false` overrides default-allow (explicit deny)
 */

import type { ArcFieldRule, RouteSchemaOptions } from "../types/index.js";

/**
 * True when the field is allowed to appear in client-readable surfaces
 * (response payloads, `select=` whitelists, `_distinct` queries).
 *
 * Mirror of every read-side gate. Don't reach for `rules.systemManaged`
 * here — that's a write rule.
 */
export function isFieldReadable(rule: ArcFieldRule | undefined): boolean {
  if (!rule) return true;
  return rule.hidden !== true;
}

/**
 * The set of field names blocked from read-side surfaces (used by
 * `QueryResolver.sanitizeSelectAny` and `BaseCrudController._distinct`).
 *
 * Returns `null` (not an empty array) when there are no rules to apply,
 * so call-sites can early-out without creating empty allocations.
 */
export function collectReadBlockedFields(
  schemaOptions: RouteSchemaOptions | undefined,
): Set<string> | null {
  const fieldRules = schemaOptions?.fieldRules;
  if (!fieldRules) return null;
  const blocked = new Set<string>();
  for (const [field, rule] of Object.entries(fieldRules)) {
    if (!rule) continue;
    if (!isFieldReadable(rule)) blocked.add(field);
  }
  return blocked.size > 0 ? blocked : null;
}
