/**
 * Phase 1 — fail-fast structural validation.
 *
 * Rejects malformed config BEFORE preset application, controller
 * construction, or schema synthesis run. The goal is "any error
 * surfaced here points at exactly one user mistake" — preset/Phase 3+
 * errors carry less of a paper trail back to the source.
 *
 * Two failure modes:
 *
 *   1. Hard errors (`throw new Error(...)`) — config will never produce
 *      a working resource. Surfaced synchronously at define-time so the
 *      host sees the failure during module load, before any request
 *      can hit a half-wired endpoint.
 *
 *   2. Non-fatal diagnostics — collected into a `ResourceDiagnostic[]`
 *      and returned to the caller. `defineResource()` attaches them to
 *      `ResourceDefinition._diagnostics`; `buildResourcePlugin` flushes
 *      them through `fastify.log.warn` on first mount so the host's
 *      configured logger handles them. The framework never reaches for
 *      `console.*` directly outside of `src/cli/`.
 */

import type { ActionDefinition, AnyRecord, ResourceConfig } from "../../types/index.js";
import { assertValidConfig } from "../validateResourceConfig.js";
import type { ResourceDiagnostic } from "./diagnostics.js";

/**
 * CRUD op names — kept module-scope (vs allocated per `defineResource()`
 * call) since the set is fixed and the cost of re-allocating is a
 * pointless boot tax for hosts with hundreds of resources.
 */
const CRUD_OP_NAMES = new Set<string>(["create", "update", "delete", "list", "get"]);

/**
 * Run the structural validation pipeline.
 *
 * Throws synchronously on hard errors. Returns the (possibly empty)
 * list of non-fatal diagnostics — defineResource attaches them to the
 * resulting `ResourceDefinition` for the plugin layer to flush through
 * `fastify.log.warn` on first mount.
 */
export function validateDefineResourceConfig<TDoc>(
  config: ResourceConfig<TDoc>,
): ResourceDiagnostic[] {
  assertValidConfig(config as ResourceConfig<AnyRecord>, {
    skipControllerCheck: true,
  });

  validatePermissionsShape(config);
  validateCustomRoutePermissions(config);
  validateActionsShape(config);
  validateRouteCapabilities(config);
  return [
    ...collectRedundantFieldRuleDiagnostics(config),
    ...collectReservedFilterNameDiagnostics(config),
    ...collectPaginationCapDiagnostics(config),
  ];
}

/**
 * Query-string param names arc's `QueryParser` reserves for
 * pagination/projection (`q.after ?? q.cursor` is the keyset cursor). A
 * document field with one of these names can never be filtered via the query
 * string — the parser consumes the name before it reaches the filter map — and
 * the same reservation flows into the MCP list-tool schema. Silent pre-2.20;
 * now surfaced.
 */
const RESERVED_QUERY_PARAMS = new Set<string>([
  "page",
  "limit",
  "cursor",
  "after",
  "sort",
  "search",
  "select",
  "populate",
]);

/**
 * Warn when a declared filterable field's NAME collides with a reserved query
 * param. Verified empirically (tests/e2e/reserved-field-name-collision.test.ts):
 * a field named `cursor`/`page` is silently unfilterable. Boot diagnostic, not
 * a hard error — the resource still works, the field just isn't query-filterable.
 */
function collectReservedFilterNameDiagnostics<TDoc>(
  config: ResourceConfig<TDoc>,
): ResourceDiagnostic[] {
  const filterable = config.schemaOptions?.filterableFields;
  if (!filterable) return [];
  const collisions = filterable.filter((f) => RESERVED_QUERY_PARAMS.has(f));
  if (collisions.length === 0) return [];
  return [
    {
      severity: "warn",
      code: "filter-field-reserved-name",
      message:
        `[Arc] Resource '${config.name}': filterable field(s) [${collisions.join(", ")}] collide with reserved ` +
        "query params (page, limit, cursor, after, sort, search, select, populate). The query parser consumes " +
        "these names for pagination/projection, so filtering by them via the query string — and via the MCP list " +
        "tool — will NOT work. Rename the field(s), or drop them from `filterableFields` if the collision is intended.",
    },
  ];
}

/**
 * Warn when the parser's page cap exceeds the repository's.
 *
 * Page size is capped in THREE independent places — the query parser, the
 * repository's pagination engine, and arc — and none of them can see the others.
 * The lowest silently wins, so a resource that declares 1000 and a repository
 * left at its default 100 serves 100 rows with a `200` and no signal anywhere.
 * That is not hypothetical: an account picker read 100 of 696 rows, filtered
 * that arbitrary slice client-side, and rendered "No accounts found".
 *
 * arc is the only layer that holds BOTH, so it is the only one that can notice.
 * A diagnostic rather than a throw: the mismatch is usually an unconfigured
 * default rather than a mistake, and a published framework must not refuse to
 * boot an app that works today — it just works less than the author intended.
 *
 * Read structurally, never by importing a kit: `repository._pagination.config`
 * is mongokit's shape, and arc stays database-agnostic (`check:boundaries`).
 * Any kit exposing the same shape gets the check for free; one that does not is
 * simply skipped.
 */
function collectPaginationCapDiagnostics<TDoc>(config: ResourceConfig<TDoc>): ResourceDiagnostic[] {
  const parserCap = (config.queryParser as { maxLimit?: unknown } | undefined)?.maxLimit;
  if (typeof parserCap !== "number") return [];

  const repo = (config.adapter as { repository?: unknown } | undefined)?.repository;
  const repoCap = (repo as { _pagination?: { config?: { maxLimit?: unknown } } } | undefined)
    ?._pagination?.config?.maxLimit;
  if (typeof repoCap !== "number" || parserCap <= repoCap) return [];

  return [
    {
      severity: "warn",
      code: "pagination-cap-mismatch",
      message:
        `[Arc] Resource '${config.name}': the query parser allows ${parserCap} rows per page ` +
        `but the repository caps at ${repoCap}, so ${repoCap} wins and larger pages are ` +
        "truncated with a 200 and no error. Configure the repository's pagination " +
        `\`maxLimit\` to ${parserCap} as well, or lower the parser's to match.`,
    },
  ];
}

/** Permissions must be `PermissionCheck` functions, not arbitrary values. */
function validatePermissionsShape<TDoc>(config: ResourceConfig<TDoc>): void {
  if (!config.permissions) return;
  for (const [key, value] of Object.entries(config.permissions)) {
    if (value !== undefined && typeof value !== "function") {
      throw new Error(
        `[Arc] Resource '${config.name}': permissions.${key} must be a PermissionCheck function.\n` +
          `Use allowPublic(), requireAuth(), or requireRoles(['role']) from @classytic/arc/permissions.`,
      );
    }
  }
}

/**
 * Custom routes must declare `permissions` as a function — fail-closed
 * default. A missing `permissions` could otherwise quietly mount an
 * unauthenticated route.
 */
function validateCustomRoutePermissions<TDoc>(config: ResourceConfig<TDoc>): void {
  for (const route of config.routes ?? []) {
    if (typeof route.permissions !== "function") {
      throw new Error(
        `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
          `permissions is required and must be a PermissionCheck function.`,
      );
    }
  }
}

/**
 * Surface common field-rule misconfigurations as boot-time diagnostics.
 *
 * Catches:
 *   1. `immutable: true` + `immutableAfterCreate: true` — `immutable`
 *      already covers `immutableAfterCreate`. Picking both signals the
 *      author wasn't sure which to use.
 *   2. `systemManaged: true` + `readonly: true` — both are write rules
 *      and `BodySanitizer` strips on either; the second flag is dead.
 *   3. `hidden: true` + `aggregable: false` — `hidden` already blocks
 *      aggregation; `aggregable: false` is redundant.
 *
 * NOT hard errors — write-rule overlap is harmless at runtime, just
 * noisy in code review. Returned as `ResourceDiagnostic[]` so the
 * caller can route them through the host logger; never logged here.
 */
function collectRedundantFieldRuleDiagnostics<TDoc>(
  config: ResourceConfig<TDoc>,
): ResourceDiagnostic[] {
  const fieldRules = config.schemaOptions?.fieldRules;
  if (!fieldRules) return [];

  const diagnostics: ResourceDiagnostic[] = [];
  for (const [field, rule] of Object.entries(fieldRules)) {
    if (!rule) continue;
    const r = rule as Record<string, unknown>;
    if (r.immutable === true && r.immutableAfterCreate === true) {
      diagnostics.push({
        severity: "warn",
        code: "field-rule-redundant-immutable",
        message:
          `[Arc] Resource '${config.name}' fieldRules.${field}: ` +
          "`immutable: true` already implies `immutableAfterCreate: true` — drop the second flag.",
      });
    }
    if (r.systemManaged === true && r.readonly === true) {
      diagnostics.push({
        severity: "warn",
        code: "field-rule-redundant-system-managed",
        message:
          `[Arc] Resource '${config.name}' fieldRules.${field}: ` +
          "`systemManaged` and `readonly` both strip writes — pick one (`systemManaged` is the canonical name).",
      });
    }
    if (r.hidden === true && r.aggregable === false) {
      diagnostics.push({
        severity: "warn",
        code: "field-rule-redundant-hidden",
        message:
          `[Arc] Resource '${config.name}' fieldRules.${field}: ` +
          "`hidden: true` already blocks aggregation — `aggregable: false` is redundant.",
      });
    }
  }
  return diagnostics;
}

/**
 * Route `capability` keys — must not collide with a CRUD slot, an action, an
 * aggregation, or another route on the same resource.
 *
 * At BOOT, not at introspection. `introspectRegistry` also refuses a collision,
 * but nothing inside arc calls it: it is a host API, and a host calls it from a
 * permission-matrix endpoint. So the only thing catching a duplicate key was a
 * 500 on that endpoint at REQUEST time — and because a UI reads its whole
 * permission map from there, one static config typo took every client's gates
 * out at once, in production, rather than failing the deploy.
 *
 * A duplicate `capability` is decidable from the config alone, so it belongs
 * with the other boot checks. The introspection-side throw stays as a backstop
 * for callers that build a registry entry by hand instead of via
 * `defineResource`.
 */
function validateRouteCapabilities<TDoc>(config: ResourceConfig<TDoc>): void {
  const routes = config.routes;
  if (!routes?.length) return;

  // Every key `introspectRegistry` will publish, in the order it publishes them.
  const taken = new Map<string, string>();
  for (const op of Object.keys(config.permissions ?? {})) taken.set(op, "CRUD slot");
  for (const name of Object.keys(config.actions ?? {})) taken.set(`action:${name}`, "action");
  for (const name of Object.keys(config.aggregations ?? {}))
    taken.set(`agg:${name}`, "aggregation");

  for (const route of routes) {
    const key = route.capability;
    if (key === undefined) continue;
    const owner = taken.get(key);
    if (owner !== undefined) {
      throw new Error(
        `[Arc] Resource '${config.name}': route ${route.method} ${route.path} declares ` +
          `capability '${key}', which is already published by a ${owner}. ` +
          "Two gates under one key means one answers for the other verb — rename the " +
          "route's `capability`.",
      );
    }
    taken.set(key, `route ${route.method} ${route.path}`);
  }
}

/**
 * Actions (v2.8) — name must not collide with CRUD ops; handler +
 * permissions must have the right shapes. Fail at boot so production
 * never ships a misconfigured action endpoint.
 */
function validateActionsShape<TDoc>(config: ResourceConfig<TDoc>): void {
  if (!config.actions) return;
  for (const [name, entry] of Object.entries(config.actions)) {
    if (CRUD_OP_NAMES.has(name)) {
      throw new Error(
        `[Arc] Resource '${config.name}': action '${name}' conflicts with CRUD operation.\n` +
          `Use a different name (e.g., '${name}_item', 'do_${name}').`,
      );
    }
    if (typeof entry !== "function") {
      const def = entry as ActionDefinition;
      if (typeof def.handler !== "function") {
        throw new Error(
          `[Arc] Resource '${config.name}': actions.${name}.handler must be a function.`,
        );
      }
      if (def.permissions !== undefined && typeof def.permissions !== "function") {
        throw new Error(
          `[Arc] Resource '${config.name}': actions.${name}.permissions must be a PermissionCheck function.`,
        );
      }
    }
  }
}
