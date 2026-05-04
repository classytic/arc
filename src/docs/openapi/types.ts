/**
 * OpenAPI 3.0 type primitives used by arc's spec emitter.
 *
 * Internal to `src/docs/openapi/*` — public exports are surfaced via
 * `src/docs/index.ts` (which re-exports `OpenApiSpec` only).
 */

export interface OpenApiOptions {
  /** API title */
  title?: string;
  /** API version */
  version?: string;
  /** API description */
  description?: string;
  /** Server URL */
  serverUrl?: string;
  /** Route prefix for spec endpoint (default: '/_docs') */
  prefix?: string;
  /** API prefix for all resource paths (e.g., '/api/v1') */
  apiPrefix?: string;
  /** Auth roles required to access spec (default: [] = public) */
  authRoles?: string[];
  /** Include internal routes (default: false) */
  includeInternal?: boolean;
  /** Custom OpenAPI extensions */
  extensions?: Record<string, unknown>;
}

export interface OpenApiBuildOptions {
  title?: string;
  version?: string;
  description?: string;
  serverUrl?: string;
  apiPrefix?: string;
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
  tags: Array<{ name: string; description?: string }>;
  security?: Array<Record<string, string[]>>;
}

export interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  options?: Operation;
  head?: Operation;
}

export interface Operation {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
  /** Arc permission metadata (OpenAPI extension) */
  "x-arc-permission"?: { type: string; roles?: readonly string[] };
  /** Arc pipeline steps (OpenAPI extension) */
  "x-arc-pipeline"?: Array<{ type: string; name: string }>;
}

export interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: SchemaObject;
  description?: string;
}

export interface RequestBody {
  required?: boolean;
  content: Record<string, { schema: SchemaObject }>;
}

export interface Response {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
}

export interface SchemaObject {
  type?: string | string[];
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  $ref?: string;
  description?: string;
  example?: unknown;
  additionalProperties?: boolean | SchemaObject;
  enum?: (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  default?: unknown;
  nullable?: boolean;
}

export interface SecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
}
