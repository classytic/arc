/**
 * CRUD → MCP tool generation.
 *
 * Owns: list / get / create / update / delete tool factories + their
 * default descriptions + op-level annotations. Handler dispatch is
 * delegated to {@link invokeController} so CRUD tools share the exact
 * permission-eval + context-build + canonical-error path with custom MCP
 * tools, scheduled jobs, and workflow steps. The previous inline
 * "permission denied" / "Error: …" string shapes drifted from the
 * `ErrorContract` shape every other surface uses; routing through
 * `invokeController` eliminates that drift.
 */

import type { FieldPermissionMap } from "../../permissions/fields.js";
import type { ResourcePermissions } from "../../types/index.js";
import { pluralize } from "../../utils/pluralize.js";
import { invokeController } from "./invokeController.js";
import type {
  CrudDescriptionMeta,
  CrudDescriptionOverride,
  CrudOperation,
  McpExecutionWiring,
  ToolAnnotations,
  ToolDefinition,
} from "./types.js";

export const ALL_CRUD_OPS: CrudOperation[] = ["list", "get", "create", "update", "delete"];

export const CRUD_ANNOTATIONS: Record<CrudOperation, ToolAnnotations> = {
  list: { readOnlyHint: true },
  get: { readOnlyHint: true },
  create: { destructiveHint: false },
  update: { destructiveHint: true, idempotentHint: true },
  delete: { destructiveHint: true, idempotentHint: true },
};

/**
 * Build a handler that dispatches to the controller method for `op` via
 * the shared {@link invokeController} pipeline. Permission check + context
 * build + envelope/error conversion all live in one place — this factory
 * only resolves the op-specific permission and threads it through.
 */
/** Ops where an idempotency key is meaningful (mutations). */
const MUTATING_CRUD_OPS: ReadonlySet<CrudOperation> = new Set(["create", "update", "delete"]);

export function createCrudHandler(
  op: CrudOperation,
  controller: unknown,
  resourceName: string,
  permissions?: ResourcePermissions,
  fields?: FieldPermissionMap,
  extras?: {
    wiring?: McpExecutionWiring;
    schemaOptions?: unknown;
    idField?: string;
  },
): ToolDefinition["handler"] {
  const permission = permissions?.[op as keyof ResourcePermissions];
  return (input, ctx) => {
    // `_idempotencyKey` is executor metadata, never body data — lift it out
    // before dispatch so BodySanitizer / strict schemas never see it.
    let idempotencyKey: string | undefined;
    let payload = input;
    if ("_idempotencyKey" in input) {
      const { _idempotencyKey, ...rest } = input;
      payload = rest;
      if (MUTATING_CRUD_OPS.has(op) && typeof _idempotencyKey === "string" && _idempotencyKey) {
        idempotencyKey = _idempotencyKey;
      }
    }
    return invokeController(controller, op, payload, {
      session: ctx.session,
      resourceName,
      permissions: permission,
      fields,
      wiring: extras?.wiring,
      schemaOptions: extras?.schemaOptions,
      idField: extras?.idField,
      idempotencyKey,
    });
  };
}

/**
 * Default description for a CRUD tool. Enriches list descriptions with the
 * configured filter/sort metadata so MCP clients can see what's queryable
 * without reading the resource source.
 *
 * Exposed publicly so authors using the function-form `descriptions`
 * override can call this from their own override to keep the auto-derived
 * blurb intact and only append extra context.
 */
export function defaultCrudDescription(
  op: CrudOperation,
  displayName: string,
  softDelete: boolean,
  queryMeta?: {
    filterableFields?: readonly string[];
    allowedOperators?: readonly string[];
    sortableFields?: readonly string[];
  },
): string {
  // 2.15.5 — `displayName` is now SINGULAR by default (was plural pre-2.15.5),
  // so singular contexts ("Get a single …") read correctly and `pluralize()`
  // doesn't double-pluralize when we need the plural form. Hosts that
  // explicitly pass a plural-form displayName still get the right shape for
  // singular contexts because `singularize` is NOT called — Arc trusts the
  // declared display name and only PLURALIZES when grammar demands it.
  const singular = displayName.toLowerCase();
  switch (op) {
    case "list": {
      const parts = [`List ${pluralize(singular)} with optional filters and pagination.`];
      if (queryMeta?.filterableFields?.length) {
        parts.push(`Filterable fields: ${queryMeta.filterableFields.join(", ")}.`);
      }
      if (queryMeta?.allowedOperators?.length) {
        parts.push(
          `Filter operators: ${queryMeta.allowedOperators.join(", ")} (use field[op]=value syntax).`,
        );
      }
      if (queryMeta?.sortableFields?.length) {
        parts.push(`Sortable fields: ${queryMeta.sortableFields.join(", ")}.`);
      }
      parts.push(
        "Set _count: true for a count-only result, _exists: true for a boolean existence check, or _distinct: '<field>' for distinct values — all honor the same filters.",
      );
      return parts.join(" ");
    }
    case "get":
      return `Get a single ${singular} by ID`;
    case "create":
      return `Create a new ${singular}`;
    case "update":
      return `Update an existing ${singular} by ID`;
    case "delete":
      return softDelete
        ? `Delete a ${singular} by ID (soft delete — marks as deleted, not permanently removed)`
        : `Delete a ${singular} by ID`;
  }
}

/**
 * Resolve a {@link CrudDescriptionOverride} (string or function) into a
 * concrete description. Centralises the function-form contract so every
 * call site that consumes an override applies it the same way.
 *
 * Falls back to {@link defaultCrudDescription} when no override is set.
 */
export function resolveCrudDescription(
  override: CrudDescriptionOverride | undefined,
  meta: CrudDescriptionMeta,
): string {
  if (override === undefined) return meta.defaultDescription;
  if (typeof override === "string") return override;
  return override(meta);
}
