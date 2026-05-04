/**
 * Action endpoint emitter — `POST /:resource/:id/action`.
 *
 * Generates a single dispatch endpoint per resource that lists every
 * declared action via the `action` discriminant. Body schema is built
 * via the SAME `buildActionBodySchema` runtime uses, so docs and
 * validation stay in sync (one source of truth for the action envelope
 * shape).
 *
 * NOTE: action **response** shape varies per action — the dispatcher
 * returns whatever the handler returned. We can't statically type the
 * response without the handler exposing its return type, and most
 * handlers return either the mutated resource document or a kit-defined
 * envelope. We declare the `200` body schema as an empty object (`{}`)
 * which `@hey-api/openapi-ts` and friends compile to `unknown` — that's
 * the most accurate thing we can say without lying to consumers about
 * shape. Per-action shape is documented in the `description` field;
 * future work could let resource authors declare a per-action
 * `responseSchema`.
 */

import { resolveActionPermission } from "../../core/actionPermissions.js";
import { buildActionBodySchema } from "../../core/createActionRouter.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ActionEntry, RegistryEntry } from "../../types/index.js";
import { createOperation, errorResponse } from "./operations.js";
import { toOpenApiPath } from "./parameters.js";
import type { PathItem, SchemaObject } from "./types.js";

/**
 * Append the action-dispatch path (`POST /:basePath/:id/action`) when
 * the resource declares any `actions`.
 */
export function appendActionPaths(
  paths: Record<string, PathItem>,
  resource: RegistryEntry,
  basePath: string,
  additionalSecurity: Array<Record<string, string[]>>,
): void {
  if (!resource.actions || resource.actions.length === 0) return;

  const actionPath = toOpenApiPath(`${basePath}/:id/action`);
  const actionEnum = resource.actions.map((a) => a.name);
  const actionSchemas: Record<string, Record<string, unknown>> = {};
  for (const a of resource.actions) {
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
    "Unified action endpoint for state transitions.",
    "",
    "**Available actions:**",
  ];
  for (const a of resource.actions) {
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

  // Determine whether the action endpoint requires auth. Use the shared
  // `resolveActionPermission` so docs reflect the SAME fallback chain
  // the runtime router and MCP tools apply — without it, a resource
  // that only sets `permissions.update: requireAuth()` would advertise
  // the action endpoint as unauthenticated even though REST rejects it
  // at runtime.
  const anyAuthRequired = resource.actions.some((a) => {
    const effective = resolveActionPermission({
      // RegistryEntry action items aren't full `ActionEntry` values
      // (they lack `handler`), but the resolver only reads
      // `.permissions` on the non-function branch — which matches the
      // shape we have here.
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
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Resource ID",
        },
      ],
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
        "404": errorResponse("Resource not found"),
      },
    },
    anyAuthRequired,
    additionalSecurity,
  );
}
