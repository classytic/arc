/**
 * CRUD path emitter — list / get / create / update / delete.
 *
 * All response shapes match arc 2.13's RUNTIME wire (set by
 * `BaseCrudController` + `fastifyAdapter`):
 *
 *   - List   → discriminated union via `buildPaginatedListSchema`
 *              (`oneOf` of offset / keyset / aggregate / bare).
 *   - Get / Create / Update → naked resource doc (`$ref` to the
 *              `<Resource>` model schema). NOT wrapped in
 *              `{ success, data }`.
 *   - Delete → `{ message, id?, soft? }` (`$ref: DeleteResult`).
 *
 * Error responses (`401` / `403` / `500`) come from `createOperation`'s
 * baseline; per-route additions (`400` validation, `404` not-found,
 * `409` duplicate-key) are added inline below — every error references
 * `ErrorContract`.
 */

import type { RegistryEntry } from "../../types/index.js";
import { buildPaginatedListSchema } from "./canonical-schemas.js";
import { createOperation, errorResponse } from "./operations.js";
import { convertSchemaToParameters, DEFAULT_LIST_PARAMS, toOpenApiPath } from "./parameters.js";
import type { PathItem } from "./types.js";

/**
 * Append the default-CRUD paths (`GET /` list + `POST /` create on the
 * collection path; `GET/PATCH|PUT/DELETE /:id` on the item path).
 * Honours `disableDefaultRoutes`, `disabledRoutes`, and `updateMethod`.
 */
export function appendCrudPaths(
  paths: Record<string, PathItem>,
  resource: RegistryEntry,
  basePath: string,
  additionalSecurity: Array<Record<string, string[]>>,
): void {
  if (resource.disableDefaultRoutes) return;

  const disabledSet = new Set(resource.disabledRoutes ?? []);
  const updateMethod = resource.updateMethod ?? "PATCH";

  // Collection routes: GET / (list) + POST / (create)
  const collectionPath: PathItem = {};

  if (!disabledSet.has("list")) {
    const listParams = resource.openApiSchemas?.listQuery
      ? convertSchemaToParameters(resource.openApiSchemas.listQuery as Record<string, unknown>)
      : DEFAULT_LIST_PARAMS;

    collectionPath.get = createOperation(
      resource,
      "list",
      "List all",
      {
        parameters: listParams,
        responses: {
          "200": {
            description: "List of items",
            content: {
              "application/json": {
                schema: buildPaginatedListSchema(`#/components/schemas/${resource.name}`),
              },
            },
          },
          "400": errorResponse("Validation error — bad filter / sort / pagination params"),
        },
      },
      undefined,
      additionalSecurity,
    );
  }

  if (!disabledSet.has("create")) {
    collectionPath.post = createOperation(
      resource,
      "create",
      "Create new",
      {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${resource.name}Input` },
            },
          },
        },
        responses: {
          "201": {
            description: "Created successfully",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${resource.name}` },
              },
            },
          },
          "400": errorResponse("Validation error — request body failed schema validation"),
          "409": errorResponse("Conflict — duplicate key on a unique-indexed field"),
        },
      },
      undefined,
      additionalSecurity,
    );
  }

  if (Object.keys(collectionPath).length > 0) {
    paths[basePath] = collectionPath;
  }

  // Item routes: GET /:id + UPDATE /:id + DELETE /:id
  const itemPath: PathItem = {};

  if (!disabledSet.has("get")) {
    itemPath.get = createOperation(
      resource,
      "get",
      "Get by ID",
      {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Item found",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${resource.name}` },
              },
            },
          },
          "404": errorResponse("Not found"),
        },
      },
      undefined,
      additionalSecurity,
    );
  }

  if (!disabledSet.has("update")) {
    const updateOp = createOperation(
      resource,
      "update",
      "Update",
      {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${resource.name}Input` },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated successfully",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${resource.name}` },
              },
            },
          },
          "400": errorResponse("Validation error — request body failed schema validation"),
          "404": errorResponse("Not found"),
          "409": errorResponse("Conflict — duplicate key on a unique-indexed field"),
        },
      },
      undefined,
      additionalSecurity,
    );

    if (updateMethod === "both") {
      itemPath.put = updateOp;
      itemPath.patch = updateOp;
    } else if (updateMethod === "PUT") {
      itemPath.put = updateOp;
    } else {
      itemPath.patch = updateOp;
    }
  }

  if (!disabledSet.has("delete")) {
    itemPath.delete = createOperation(
      resource,
      "delete",
      "Delete",
      {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Deleted successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeleteResult" },
              },
            },
          },
          "404": errorResponse("Not found"),
        },
      },
      undefined,
      additionalSecurity,
    );
  }

  if (Object.keys(itemPath).length > 0) {
    paths[toOpenApiPath(`${basePath}/:id`)] = itemPath;
  }
}
