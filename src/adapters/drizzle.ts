/**
 * Drizzle Adapter — SQL-kit binding for arc.
 *
 * Thin wrapper around a Drizzle table + a `MinimalRepo` / `StandardRepo`
 * repository. Mirrors the mongoose adapter's delegation pattern: schema
 * generation is delegated to a kit-provided callback so arc doesn't pull
 * `drizzle-orm` or any kit into its core dependency graph.
 *
 * Wire it with sqlitekit's introspection:
 *
 * ```ts
 * import { SqliteRepository } from '@classytic/sqlitekit/repository';
 * import { buildCrudSchemasFromTable } from '@classytic/sqlitekit/schema/crud';
 * import { createDrizzleAdapter } from '@classytic/arc/adapters';
 *
 * const adapter = createDrizzleAdapter({
 *   table: products,
 *   repository: new SqliteRepository({ db, table: products }),
 *   schemaGenerator: (table, opts) => buildCrudSchemasFromTable(table, opts),
 * });
 * defineResource({ name: 'product', adapter, ... });
 * ```
 *
 * The same wiring works against a future pgkit: pass pgkit's
 * `buildCrudSchemasFromTable` instead. Arc stays backend-agnostic.
 */

import type { AnyRecord, OpenApiSchemas, RouteSchemaOptions } from "../types/index.js";
import { mergeFieldRuleConstraints } from "./field-rule-helpers.js";
import type {
  AdapterSchemaContext,
  DataAdapter,
  FieldMetadata,
  RepositoryLike,
  SchemaMetadata,
} from "./interface.js";
import { isRepository } from "./types.js";

// ============================================================================
// Structural types — we never import from drizzle-orm so the peer stays peer.
// ============================================================================

/**
 * Minimum shape arc needs from a Drizzle column. Every SQLite, PG, and MySQL
 * column in `drizzle-orm` exposes these via `getTableColumns(table)`. Held
 * structurally so arc doesn't depend on `drizzle-orm` types.
 */
interface DrizzleColumnLike {
  columnType?: string;
  dataType?: "number" | "string" | "date" | "boolean" | "json" | "buffer" | "bigint" | "custom";
  notNull?: boolean;
  hasDefault?: boolean;
  primary?: boolean;
  enumValues?: readonly string[];
  length?: number;
  name?: string;
}

/**
 * Structural Drizzle table — only requires `[Symbol.for('drizzle:Columns')]`,
 * which every Drizzle table exposes. Matches `drizzle-orm`'s `Table` at
 * runtime without importing it at compile time.
 */
type DrizzleTableLike = Record<symbol, Record<string, DrizzleColumnLike>> & {
  [key: string]: unknown;
};

// ============================================================================
// Options
// ============================================================================

export interface DrizzleAdapterOptions<TDoc = unknown> {
  /** Drizzle table — used for schema introspection. */
  table: DrizzleTableLike;

  /** Repository implementing the repo-core contract. */
  repository: RepositoryLike<TDoc>;

  /**
   * External schema generator. When provided, replaces the built-in
   * type-only conversion. Wire it to your kit's `buildCrudSchemasFromTable`
   * (sqlitekit, pgkit, ...) to get the full CRUD schemas — strict
   * additional-property control, field-rule application, param-type
   * narrowing from primary-key columns, etc.
   */
  schemaGenerator?: (
    table: DrizzleTableLike,
    options?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ) => OpenApiSchemas | Record<string, unknown>;

  /** Optional name — defaults to "DrizzleAdapter". */
  name?: string;
}

// ============================================================================
// Column introspection — used by the built-in fallback only
// ============================================================================

const DRIZZLE_COLUMNS_SYMBOL = Symbol.for("drizzle:Columns");

function getColumns(table: DrizzleTableLike): Record<string, DrizzleColumnLike> {
  const cols = table[DRIZZLE_COLUMNS_SYMBOL];
  if (!cols || typeof cols !== "object") return {};
  return cols;
}

function columnToJsonSchema(column: DrizzleColumnLike): Record<string, unknown> {
  const { dataType, columnType, enumValues, length } = column;

  if (dataType === "date") return { type: "string", format: "date-time" };
  if (dataType === "boolean") return { type: "boolean" };
  if (dataType === "json") return { type: "object", additionalProperties: true };
  if (dataType === "buffer") return { type: "string", contentEncoding: "base64" };

  if (dataType === "number" || dataType === "bigint") {
    return { type: columnType === "SQLiteInteger" ? "integer" : "number" };
  }

  if (dataType === "string") {
    const result: Record<string, unknown> = { type: "string" };
    if (Array.isArray(enumValues) && enumValues.length > 0) result.enum = [...enumValues];
    if (typeof length === "number" && length > 0) result.maxLength = length;
    return result;
  }

  return {};
}

function columnToFieldMetadata(column: DrizzleColumnLike): FieldMetadata {
  const { dataType, enumValues } = column;

  const typeMap: Record<string, FieldMetadata["type"]> = {
    number: "number",
    bigint: "number",
    string: "string",
    date: "date",
    boolean: "boolean",
    json: "object",
    buffer: "object",
  };

  const type: FieldMetadata["type"] =
    (dataType && typeMap[dataType]) ?? (enumValues?.length ? "enum" : "object");

  const meta: FieldMetadata = { type, required: !!column.notNull && !column.hasDefault };
  if (enumValues?.length) meta.enum = [...enumValues];
  if (typeof column.length === "number") meta.maxLength = column.length;
  return meta;
}

// ============================================================================
// Adapter
// ============================================================================

export class DrizzleAdapter<TDoc = unknown> implements DataAdapter<TDoc> {
  readonly type = "drizzle" as const;
  readonly name: string;
  readonly table: DrizzleTableLike;
  readonly repository: RepositoryLike<TDoc>;
  private readonly schemaGenerator?: DrizzleAdapterOptions<TDoc>["schemaGenerator"];

  constructor(options: DrizzleAdapterOptions<TDoc>) {
    if (!options.table || typeof options.table !== "object") {
      throw new TypeError(
        "DrizzleAdapter: Invalid table. Expected a Drizzle table created with " +
          "sqliteTable / pgTable / mysqlTable.",
      );
    }
    if (!isRepository(options.repository)) {
      throw new TypeError(
        "DrizzleAdapter: Invalid repository. Expected an object implementing " +
          "MinimalRepo (getAll / getById / create / update / delete).",
      );
    }

    this.table = options.table;
    this.repository = options.repository;
    this.schemaGenerator = options.schemaGenerator;
    this.name = options.name ?? "DrizzleAdapter";
  }

  /**
   * Introspect Drizzle columns into arc's schema metadata shape.
   */
  getSchemaMetadata(): SchemaMetadata {
    const columns = getColumns(this.table);
    const fields: SchemaMetadata["fields"] = {};
    const indexes: NonNullable<SchemaMetadata["indexes"]> = [];

    for (const [name, column] of Object.entries(columns)) {
      fields[name] = columnToFieldMetadata(column);
      if (column.primary) indexes.push({ fields: [name], unique: true });
    }

    return {
      name: this.name,
      fields,
      ...(indexes.length > 0 ? { indexes } : {}),
    };
  }

  /**
   * Generate OpenAPI schemas. Delegates to the user-provided
   * `schemaGenerator` when available (strongly recommended — that's where
   * field rules, omit lists, and param-type narrowing live). The built-in
   * fallback emits a permissive entity + CRUD body shape so routes still
   * register when no generator is provided.
   *
   * After the kit generator runs, arc merges constraint-style field rules
   * (`minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `description`)
   * into the resulting property schemas so sqlitekit / pgkit behave
   * identically to mongoose here — rule-driven AJV constraints apply
   * regardless of backend.
   */
  generateSchemas(
    schemaOptions?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null {
    try {
      if (this.schemaGenerator) {
        const generated = this.schemaGenerator(this.table, schemaOptions, context);
        mergeFieldRuleConstraints(generated, schemaOptions);
        return generated;
      }

      const columns = getColumns(this.table);
      if (Object.keys(columns).length === 0) return null;

      const entityProperties: AnyRecord = {};
      const inputProperties: AnyRecord = {};
      const inputRequired: string[] = [];
      const updateProperties: AnyRecord = {};

      const fieldRules = schemaOptions?.fieldRules ?? {};
      const readonlySet = new Set(schemaOptions?.readonlyFields ?? []);
      const optionalSet = new Set(schemaOptions?.optionalFields ?? []);
      const blocked = new Set<string>([
        ...Object.entries(fieldRules)
          .filter(([, rules]) => rules.systemManaged || rules.hidden)
          .map(([field]) => field),
        ...(schemaOptions?.excludeFields ?? []),
        ...(schemaOptions?.hiddenFields ?? []),
      ]);

      for (const [fieldName, column] of Object.entries(columns)) {
        const schema = columnToJsonSchema(column);
        entityProperties[fieldName] = schema;

        if (blocked.has(fieldName)) continue;
        // Auto-generated integer primary keys skip the body.
        if (column.primary && column.columnType === "SQLiteInteger") continue;

        if (!readonlySet.has(fieldName)) {
          inputProperties[fieldName] = schema;
          const isRequired = !!column.notNull && !column.hasDefault && !optionalSet.has(fieldName);
          if (isRequired) inputRequired.push(fieldName);
          updateProperties[fieldName] = schema;
        }
      }

      return {
        createBody: {
          type: "object",
          properties: inputProperties,
          required: inputRequired.length > 0 ? inputRequired : undefined,
          additionalProperties: true,
        },
        updateBody: {
          type: "object",
          properties: updateProperties,
          additionalProperties: true,
        },
        response: {
          type: "object",
          properties: entityProperties,
          additionalProperties: true,
        },
      };
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    return typeof this.repository.getAll === "function";
  }
}

/**
 * Factory — preferred construction style for symmetry with
 * `createMongooseAdapter` / `createPrismaAdapter`.
 */
export function createDrizzleAdapter<TDoc = unknown>(
  options: DrizzleAdapterOptions<TDoc>,
): DrizzleAdapter<TDoc> {
  return new DrizzleAdapter<TDoc>(options);
}
