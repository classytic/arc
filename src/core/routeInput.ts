/**
 * Declare a zod schema ONCE per route / action / CRUD verb; arc uses it three ways.
 *
 *   1. AJV: arc converts the slot to JSON Schema (request slots in the INPUT direction, so a
 *      `.default()` stays optional on the wire), and rejects what JSON Schema can express.
 *   2. A `preHandler` runs the SAME schema on what AJV let through and replaces `request.body` /
 *      `query` / `params` with the parsed value, so trim / default / refine take effect and the
 *      handler reads the schema's OUTPUT ({@link parsed} types it).
 *   3. OpenAPI and MCP derive from the same declaration.
 *
 * A failed parse is a 400 `arc.validation_error` with field `details`, same wire as AJV's.
 * Zod stays an optional peer: nothing here imports it at runtime (schemas are used through
 * `safeParse`); a plain JSON Schema in a slot is validated by AJV only. See wiki/schema-pipeline.md.
 */

import type { RouteHandlerMethod } from "fastify";
import type { z } from "zod";
import type { ActionDefinition, MiddlewareHandler } from "../types/index.js";
import { ValidationError } from "../utils/errors.js";

/** A zod schema (parsed by the preHandler) or plain JSON Schema (AJV only). */
export type InputSchema = z.ZodType | Record<string, unknown>;

export interface RouteInputSlots {
  /** `RouteDefinition.schema` is an open record. */
  [slot: string]: unknown;
  body?: InputSchema | undefined;
  querystring?: InputSchema | undefined;
  params?: InputSchema | undefined;
  /** Validated by AJV only; headers are not rewritten. */
  headers?: InputSchema | undefined;
  /** Serialization + docs. A `z.object` response strips fields it does not declare. */
  response?: Record<number, InputSchema> | undefined;
}

interface Parseable {
  safeParse(value: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
  };
}

function isParseable(schema: unknown): schema is Parseable {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/** Parse `value` with `schema`; zod issues become one `ValidationError` (400, `details[]`). */
function parseOrThrow(schema: Parseable, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(
    "Validation failed",
    (result.error?.issues ?? []).map((issue) => ({
      field: issue.path.map(String).join("."),
      message: issue.message,
    })),
  );
}

/**
 * Spread into a route entry: `{ method, path, permissions, ...routeInput({ body }), handler }`.
 * `preHandler` is empty when no zod body/querystring/params slot is declared.
 */
export function routeInput<const S extends RouteInputSlots>(
  slots: S,
): { schema: S; preHandler: RouteHandlerMethod[] } {
  const { body, querystring, params } = slots;
  const parseBody = isParseable(body) ? body : undefined;
  const parseQuery = isParseable(querystring) ? querystring : undefined;
  const parseParams = isParseable(params) ? params : undefined;
  if (!parseBody && !parseQuery && !parseParams) return { schema: slots, preHandler: [] };
  const parse: RouteHandlerMethod = async (request) => {
    if (parseParams) request.params = parseOrThrow(parseParams, request.params ?? {});
    if (parseQuery) request.query = parseOrThrow(parseQuery, request.query ?? {});
    if (parseBody) request.body = parseOrThrow(parseBody, request.body ?? {});
  };
  return { schema: slots, preHandler: [parse] };
}

/** The request part {@link routeInput} already parsed with `schema`: typed from it, not parsed again. */
export function parsed<S extends z.ZodType>(_schema: S, value: unknown): z.output<S> {
  return value as z.output<S>;
}

/**
 * A body that must be empty. As an action `schema` (or route `body`) AJV rejects any stray field,
 * and the reference states that the verb takes nothing else. Plain JSON Schema, so no zod needed.
 */
export const noPayloadSchema: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * Wire shape of a resource's own CRUD writes. Spread into `defineResource`:
 * `customSchemas` is what AJV validates (and, for zod, converts input-direction: a `.default()`
 * stays optional; `z.strictObject` refuses unknown keys); `openApiSchemas` makes the generated
 * reference describe what the route accepts rather than the stored model.
 *
 * `parse: true` also adds a create/update middleware that replaces `request.body` with the zod
 * OUTPUT (trim, defaults, refinements). It writes `middlewares.create` / `middlewares.update`, so
 * merge your own: `middlewares: { create: [...mine, ...crud.middlewares.create] }`.
 */
export function crudInput(input: { create?: InputSchema; update?: InputSchema; parse?: boolean }) {
  const { create, update } = input;
  const parseBody = (schema: InputSchema): MiddlewareHandler[] =>
    input.parse && isParseable(schema)
      ? [
          (async (request) => {
            request.body = parseOrThrow(schema, request.body ?? {});
          }) as MiddlewareHandler,
        ]
      : [];
  return {
    customSchemas: {
      ...(create ? { create: { body: create } } : {}),
      ...(update ? { update: { body: update } } : {}),
    },
    openApiSchemas: {
      ...(create ? { createBody: create } : {}),
      ...(update ? { updateBody: update } : {}),
    },
    middlewares: {
      ...(create && input.parse ? { create: parseBody(create) } : {}),
      ...(update && input.parse ? { update: parseBody(update) } : {}),
    } as { create?: MiddlewareHandler[]; update?: MiddlewareHandler[] },
  };
}

/**
 * Wrap an action handler so `data` is the zod schema's OUTPUT. Used by `ActionDefinition.parse`
 * and `defineAction({ parse: true })`; a non-zod schema returns the handler unchanged.
 */
export function withParsedInput(
  handler: ActionDefinition["handler"],
  schema: unknown,
): ActionDefinition["handler"] {
  if (!isParseable(schema)) return handler;
  return (id, data, req) => handler(id, parseOrThrow(schema, data) as Record<string, unknown>, req);
}
