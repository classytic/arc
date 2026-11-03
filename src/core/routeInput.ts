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
import { normalizeSchemaIR } from "./schemaIR.js";

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

/** One zod issue as the parse saw it (`params` is what a refinement's `ctx.addIssue` attached). */
export interface RouteInputIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly code?: string;
  readonly params?: unknown;
}

/** Options shared by {@link routeInput}, {@link crudInput}. */
export interface RouteInputOptions {
  /**
   * A failed parse's issues -> the error to throw instead of the default 400
   * `arc.validation_error`, or `undefined` to keep it. Lets a schema choose its own code: a
   * refinement tags its issue (`ctx.addIssue({ ..., params: { code: 'insights.range_too_long' } })`)
   * and this returns `new ArcError(msg, { code, statusCode: 400 })` for it.
   */
  readonly mapIssues?: ((issues: readonly RouteInputIssue[]) => Error | undefined) | undefined;
}

interface Parseable {
  safeParse(value: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: ReadonlyArray<RouteInputIssue> };
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
function parseOrThrow(
  schema: Parseable,
  value: unknown,
  mapIssues?: RouteInputOptions["mapIssues"],
): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error?.issues ?? [];
  const mapped = mapIssues?.(issues);
  if (mapped) throw mapped;
  throw new ValidationError(
    "Validation failed",
    issues.map((issue) => ({
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
  options: RouteInputOptions = {},
): { schema: S; preHandler: RouteHandlerMethod[] } {
  const { mapIssues } = options;
  const { body, querystring, params } = slots;
  const parseBody = isParseable(body) ? body : undefined;
  const parseQuery = isParseable(querystring) ? querystring : undefined;
  const parseParams = isParseable(params) ? params : undefined;
  if (!parseBody && !parseQuery && !parseParams) return { schema: slots, preHandler: [] };
  const parse: RouteHandlerMethod = async (request) => {
    if (parseParams) request.params = parseOrThrow(parseParams, request.params ?? {}, mapIssues);
    if (parseQuery) request.query = parseOrThrow(parseQuery, request.query ?? {}, mapIssues);
    if (parseBody) request.body = parseOrThrow(parseBody, request.body ?? {}, mapIssues);
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
 * What {@link crudInput} returns. Each slot is present only when its schema was given
 * (never `undefined`), so the spread type-checks under `exactOptionalPropertyTypes`.
 */
export interface CrudInput {
  customSchemas: { create?: { body: InputSchema }; update?: { body: InputSchema } };
  openApiSchemas: { createBody?: InputSchema; updateBody?: InputSchema };
  /** Filled only with `parse: true`. */
  middlewares: { create?: MiddlewareHandler[]; update?: MiddlewareHandler[] };
}

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
export function crudInput(input: {
  create?: InputSchema | undefined;
  update?: InputSchema | undefined;
  parse?: boolean | undefined;
  /** With `parse: true`: see {@link RouteInputOptions.mapIssues}. */
  mapIssues?: RouteInputOptions["mapIssues"];
}): CrudInput {
  const { create, update } = input;
  const parseBody = (schema: InputSchema): MiddlewareHandler[] =>
    input.parse && isParseable(schema)
      ? [
          (async (request) => {
            request.body = parseOrThrow(schema, request.body ?? {}, input.mapIssues);
          }) as MiddlewareHandler,
        ]
      : [];
  // Assigned, never spread from a conditional: a spread infers `create?: X | undefined`,
  // which `defineResource` refuses under `exactOptionalPropertyTypes`. An absent slot is
  // an absent key.
  const customSchemas: CrudInput["customSchemas"] = {};
  const openApiSchemas: CrudInput["openApiSchemas"] = {};
  const middlewares: CrudInput["middlewares"] = {};
  if (create) {
    customSchemas.create = { body: create };
    openApiSchemas.createBody = create;
    if (input.parse) middlewares.create = parseBody(create);
  }
  if (update) {
    customSchemas.update = { body: update };
    openApiSchemas.updateBody = update;
    if (input.parse) middlewares.update = parseBody(update);
  }
  return { customSchemas, openApiSchemas, middlewares };
}

/** True when the schema's object shape declares an `action` property. */
function declaresAction(schema: unknown): boolean {
  try {
    return "action" in normalizeSchemaIR(schema as Record<string, unknown>).properties;
  } catch {
    return false;
  }
}

/**
 * Wrap an action handler so `data` is the zod schema's OUTPUT. Used by `ActionDefinition.parse`
 * and `defineAction({ parse: true })`; a non-zod schema returns the handler unchanged.
 *
 * `data` never carries the `action` discriminator (arc owns it). A schema that DECLARES `action`
 * (`z.strictObject({ action: z.literal('issue'), ... })`, a contracts discriminated-union branch)
 * is parsed with `action: actionName` put back, so strictness and refinements that read it hold;
 * the handler still gets the output without `action`.
 */
export function withParsedInput(
  handler: ActionDefinition["handler"],
  schema: unknown,
  actionName?: string,
): ActionDefinition["handler"] {
  if (!isParseable(schema)) return handler;
  if (actionName === undefined || !declaresAction(schema)) {
    return (id, data, req) =>
      handler(id, parseOrThrow(schema, data) as Record<string, unknown>, req);
  }
  return (id, data, req) => {
    const out = parseOrThrow(schema, { ...data, action: actionName });
    if (out === null || typeof out !== "object" || Array.isArray(out)) {
      return handler(id, out as Record<string, unknown>, req);
    }
    const { action: _owned, ...rest } = out as Record<string, unknown>;
    return handler(id, rest, req);
  };
}
