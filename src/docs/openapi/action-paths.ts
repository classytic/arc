/**
 * Action endpoint emitter — `POST /:resource/:id/action` and/or
 * `POST /:resource/action`.
 *
 * Generates a dispatch endpoint per mount point. Each mount has its own
 * `oneOf` body schema containing only the actions that live at that
 * mount — id-bound actions under `/:id/action`, id-less actions
 * (`id: false`) under `/action`. Body schemas come from the SAME
 * `buildActionBodySchema` the runtime uses, so docs and validation stay
 * in sync.
 *
 * NOTE: action **response** shape varies per action — the dispatcher
 * returns whatever the handler returned. We can't statically type the
 * response without the handler exposing its return type, so the `200`
 * body schema is `{}` (codegen → `unknown`). Per-action shape lives in
 * the operation `description`.
 */

import { resolveActionPermission } from "../../core/actionPermissions.js";
import { buildActionBodySchema } from "../../core/createActionRouter.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ActionEntry, RegistryEntry } from "../../types/index.js";
import { createOperation, errorResponse } from "./operations.js";
import { toOpenApiPath } from "./parameters.js";
import type { PathItem, SchemaObject } from "./types.js";

type ActionMeta = NonNullable<RegistryEntry["actions"]>[number];

/**
 * Append action-dispatch paths to `paths` for the resource. Emits one
 * path per non-empty mount point — id-bound and/or id-less.
 */
export function appendActionPaths(
  paths: Record<string, PathItem>,
  resource: RegistryEntry,
  basePath: string,
  additionalSecurity: Array<Record<string, string[]>>,
): void {
  if (!resource.actions || resource.actions.length === 0) return;

  // Partition by mount. `id` undefined ⇒ legacy id-bound default (`true`).
  const idBound: ActionMeta[] = [];
  const idLess: ActionMeta[] = [];
  for (const a of resource.actions) {
    (a.id === false ? idLess : idBound).push(a);
  }

  if (idBound.length > 0) {
    emitMount(paths, resource, basePath, additionalSecurity, idBound, /* hasId */ true);
  }
  if (idLess.length > 0) {
    emitMount(paths, resource, basePath, additionalSecurity, idLess, /* hasId */ false);
  }
}

/**
 * Emit one OpenAPI path for a single mount point's action subset.
 * Centralises the shared rendering (body schema, description list,
 * auth detection, response wiring) so id-bound and id-less mounts can't
 * drift in shape.
 */
function emitMount(
  paths: Record<string, PathItem>,
  resource: RegistryEntry,
  basePath: string,
  additionalSecurity: Array<Record<string, string[]>>,
  subsetActions: ActionMeta[],
  hasId: boolean,
): void {
  const actionPath = toOpenApiPath(`${basePath}${hasId ? "/:id/action" : "/action"}`);
  const actionEnum = subsetActions.map((a) => a.name);
  const actionSchemas: Record<string, Record<string, unknown>> = {};
  for (const a of subsetActions) {
    // 2.11.1 widened `a.schema` to `unknown` (Zod assigns without cast).
    // `buildActionBodySchema` expects per-action JSON-Schema fragments;
    // narrow back via the same passthrough/conversion the runtime uses.
    if (a.schema) actionSchemas[a.name] = a.schema as Record<string, unknown>;
  }
  const bodySchema = buildActionBodySchema(actionEnum, actionSchemas);

  // Build a human-friendly description listing each action + its
  // permission/description so codegen surfaces the per-action contract
  // even though the response schema is `unknown`.
  const descLines: string[] = [
    hasId
      ? "Unified action endpoint for state transitions on an existing entity."
      : "Resource-root action endpoint (no `:id` — operates on the collection or creates new entities).",
    "",
    "**Available actions:**",
  ];
  for (const a of subsetActions) {
    const perm = a.permissions as PermissionCheck | undefined;
    const roles = perm?._roles;
    const roleStr = roles?.length ? ` — requires: ${roles.join(" or ")}` : "";
    const descStr = a.description ? ` — ${a.description}` : "";
    descLines.push(`- \`${a.name}\`${roleStr}${descStr}`);
  }
  descLines.push(
    "",
    "Response shape depends on the action handler — typically the mutated resource " +
      "document or a kit-defined result envelope. See the per-action description above.",
  );

  // Determine whether the endpoint requires auth. Use the shared
  // `resolveActionPermission` so docs reflect the SAME fallback chain
  // the runtime router and MCP tools apply — without it, a resource
  // that only sets `permissions.update: requireAuth()` would advertise
  // the action endpoint as unauthenticated even though REST rejects it
  // at runtime.
  const anyAuthRequired = subsetActions.some((a) => {
    const effective = resolveActionPermission({
      // RegistryEntry action items aren't full `ActionEntry` values
      // (they lack `handler`), but the resolver only reads `.permissions`
      // on the non-function branch — which matches the shape we have here.
      action: { permissions: a.permissions } as unknown as ActionEntry,
      resourcePermissions: resource.permissions,
      resourceActionPermissions: resource.actionPermissions,
    });
    return typeof effective === "function" && !effective._isPublic;
  });

  if (!paths[actionPath]) paths[actionPath] = {};
  paths[actionPath].post = createOperation(
    resource,
    "action",
    `Perform action (${actionEnum.join(" / ")})`,
    {
      ...(hasId
        ? {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
                description: "Resource ID",
              },
            ],
          }
        : {}),
      description: descLines.join("\n"),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: bodySchema as SchemaObject,
          },
        },
      },
      responses: {
        "200": {
          description: "Action executed successfully",
          content: {
            "application/json": {
              // Empty object → codegen produces `unknown`. See file
              // header for why we don't try to be cleverer here.
              schema: {},
            },
          },
        },
        "400": errorResponse("Invalid action or missing required fields"),
        ...(hasId ? { "404": errorResponse("Resource not found") } : {}),
      },
    },
    anyAuthRequired,
    additionalSecurity,
  );
}
