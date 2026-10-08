/**
 * Arc's request validator — the AJV settings every route arc builds is validated with, on ANY host.
 *
 * Fastify's stock AJV runs `removeAdditional: true`, which turns `additionalProperties: false`
 * into a silent STRIP: an unknown key in a strict action body or filter querystring reaches the
 * handler as if it were never sent, and a dropped filter is a WIDER read. Arc's routes therefore
 * carry their own `validatorCompiler` unless the instance was built by `createApp`, whose root
 * AJV already runs these options (plus the host's `ajv.keywords`).
 * Pinned by `tests/core/route-validator-bare-host.test.ts`.
 */

import { AjvCompiler } from "@fastify/ajv-compiler";
import type { FastifyInstance, FastifySchema, FastifySchemaCompiler } from "fastify";

/** The AJV options `createApp` configures and arc's own routes are compiled with. */
export function arcAjvCustomOptions(extraKeywords: readonly string[] = []): {
  coerceTypes: true;
  useDefaults: true;
  removeAdditional: false;
  strictTypes: false;
  keywords: string[];
} {
  return {
    coerceTypes: true,
    useDefaults: true,
    removeAdditional: false,
    // Kits emit `additionalProperties: true` WITHOUT `type: 'object'` for any-value (`Mixed`)
    // fields — correct, but `strictTypes` would flag it at boot. Other strict checks stay on.
    strictTypes: false,
    keywords: ["example", ...extraKeywords],
  };
}

declare module "fastify" {
  interface FastifyInstance {
    /** Set by `createApp`: the root AJV already runs `arcAjvCustomOptions`, so routes inherit it. */
    arcRootValidator?: true;
  }
}

/** Mark an instance whose ROOT AJV was configured with `arcAjvCustomOptions` (createApp only). */
export function markArcRootValidator(fastify: FastifyInstance): void {
  fastify.decorate("arcRootValidator", true);
}

/** One pool for the process: `@fastify/ajv-compiler` caches an AJV per (shared schemas, options). */
const buildFromPool = AjvCompiler();
type SharedSchemas = Parameters<typeof buildFromPool>[0];

/**
 * The `validatorCompiler` an arc-built route registers with — `undefined` under `createApp`
 * (the root already validates this way). Schemas added with `fastify.addSchema` stay
 * `$ref`-able: the shared pool is read when Fastify compiles the route.
 */
export function arcRouteValidatorCompiler(
  fastify: FastifyInstance,
): FastifySchemaCompiler<FastifySchema> | undefined {
  if (fastify.arcRootValidator === true) return undefined;
  return ({ schema, httpPart }) => {
    const compile = buildFromPool(sharedSchemas(fastify), { customOptions: arcAjvCustomOptions() });
    return compile({
      schema: httpPart === "headers" ? lowerCaseHeaderSchema(schema) : schema,
    });
  };
}

/** The instance's `addSchema` pool, in the shape AJV accepts (a schema is an object or boolean). */
function sharedSchemas(fastify: FastifyInstance): SharedSchemas {
  const out: SharedSchemas = {};
  for (const [id, schema] of Object.entries(fastify.getSchemas())) {
    if (isSchemaValue(schema)) out[id] = schema;
  }
  return out;
}

function isSchemaValue(value: unknown): value is SharedSchemas[string] {
  return typeof value === "boolean" || (typeof value === "object" && value !== null);
}

/**
 * Fastify lower-cases a headers schema's keys before compiling it with its OWN compiler and
 * skips that for a custom one — so a route-level compiler must do it, or `Authorization` in a
 * schema never matches the `authorization` header Node delivers.
 */
function lowerCaseHeaderSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  const out: Record<string, unknown> = { ...schema };
  if (Array.isArray(schema.required)) {
    out.required = schema.required.map((h) => (typeof h === "string" ? h.toLowerCase() : h));
  }
  if (isPlainObject(schema.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key.toLowerCase()] = value;
    }
    out.properties = properties;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
