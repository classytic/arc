/**
 * Custom-route → MCP tool INPUT schema. The route's own schema is the contract:
 * an input the REST route would refuse must be refused on MCP, never stripped.
 *
 * - A Zod schema that is not a plain object (a union of strict arms) is registered
 *   WHOLE — the MCP SDK validates and advertises a Standard Schema as-is. Flattening
 *   it yields `{}`, and the SDK's `z.object({})` then strips every key the caller sent.
 * - A flat schema declaring `additionalProperties: false` registers as `z.strictObject`,
 *   so an unknown key is an input error instead of a silently dropped filter. So
 *   does a route with NO schema: a key it was sent could never reach the handler.
 * - Any other non-object schema (a JSON Schema `anyOf`, or a Zod union beside `:id`
 *   or a second source) throws at tool build: there is no lossless flat form, so
 *   bridge it with `mcpHandler` or opt out with `mcp: false`.
 */

import { z } from "zod";
import { normalizeSchemaIR } from "../../core/schemaIR.js";
import { schemaIRToZodShape } from "../../core/schemaIRZod.js";
import { toJsonSchema } from "../../utils/schemaConverter.js";
import type { ToolInputSchema } from "./types.js";

/** A Zod v4 schema (carries the `_zod` marker and the Standard Schema slot). */
export function isZodTypeSchema(value: unknown): value is z.ZodType {
  return value !== null && typeof value === "object" && "_zod" in value && "~standard" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** The JSON Schema HTTP validates this request slot with (`input` io, as the router converts it). */
function requestJsonSchema(schema: object): Record<string, unknown> | undefined {
  return toJsonSchema(schema, "draft-7", "throw", "input");
}

/** Does this JSON Schema have a single top-level object a flat shape can carry? */
function flattensLosslessly(json: Record<string, unknown> | undefined): boolean {
  if (!json) return true;
  if ("anyOf" in json || "oneOf" in json || "allOf" in json) return false;
  return json.type === "object" || "properties" in json;
}

export function buildRouteInputSchema(
  route: { readonly method: string; readonly path: string; readonly schema?: unknown },
  hasId: boolean,
): ToolInputSchema {
  const routeSchema = isRecord(route.schema) ? route.schema : undefined;
  // Body first: it is the primary input channel, and wins a same-name clash below.
  const sources = [routeSchema?.body, routeSchema?.querystring].filter(isRecord);

  const whole: z.ZodType[] = [];
  let unflattenable = 0;
  for (const source of sources) {
    if (flattensLosslessly(requestJsonSchema(source))) continue;
    unflattenable++;
    if (isZodTypeSchema(source)) whole.push(source);
  }
  const [only] = whole;
  if (unflattenable > 0) {
    if (only && sources.length === 1 && !hasId) return only;
    // A boot-time authoring error (like a missing action gate), never a wire error.
    throw new Error(
      `[Arc/MCP] Route '${route.method} ${route.path}': a non-object input schema (union) is bridged ` +
        "only as a Zod schema that is the route's sole input with no ':id' — anything else loses validation. " +
        "Declare `mcpHandler` for this route or set `mcp: false`.",
    );
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  if (hasId) shape.id = z.string().describe("Resource ID");
  // No declared input: anything sent would be stripped unseen, so refuse it instead.
  let strict = sources.length === 0;
  for (const source of sources) {
    // Strictness as HTTP sees it: arc's AJV runs `removeAdditional: false`, so this rejects there.
    if (requestJsonSchema(source)?.additionalProperties === false) strict = true;
    const ir = normalizeSchemaIR(source);
    for (const [key, val] of Object.entries(schemaIRToZodShape(ir))) {
      if (!(key in shape)) shape[key] = val;
    }
  }
  return strict ? z.strictObject(shape) : shape;
}

/**
 * The field shape a tool advertises — the flat record itself, or a whole object
 * schema's `.shape`. `undefined` for a union, which has no single shape.
 */
export function toolInputShape(
  schema: ToolInputSchema | undefined,
): Record<string, z.ZodTypeAny> | undefined {
  if (schema === undefined) return undefined;
  if (!isZodTypeSchema(schema)) return schema;
  return schema instanceof z.ZodObject ? schema.shape : undefined;
}
