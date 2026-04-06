/**
 * defineEvent — Typed Event Definitions with Optional Schema Validation
 *
 * Provides:
 * 1. defineEvent() — declare an event with name, schema, version, description
 * 2. EventRegistry — catalog of all known events + payload validation
 * 3. .create() helper — build DomainEvent with auto-generated metadata
 *
 * The built-in validator checks: object type, required fields, and top-level
 * property types. It does NOT recurse into nested objects, validate arrays,
 * enums, patterns, formats, or $ref. This is intentional — it's a lightweight
 * guard, not a full JSON Schema engine.
 *
 * For full validation, pass a custom `validate` function to `createEventRegistry()`:
 *
 * @example
 * ```typescript
 * import Ajv from 'ajv';
 * const ajv = new Ajv();
 *
 * const registry = createEventRegistry({
 *   validate: (schema, payload) => {
 *     const valid = ajv.validate(schema, payload);
 *     return valid
 *       ? { valid: true }
 *       : { valid: false, errors: ajv.errorsText().split(', ') };
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * import { defineEvent, createEventRegistry } from '@classytic/arc/events';
 *
 * const OrderCreated = defineEvent({
 *   name: 'order.created',
 *   version: 1,
 *   schema: {
 *     type: 'object',
 *     properties: {
 *       orderId: { type: 'string' },
 *       total: { type: 'number' },
 *     },
 *     required: ['orderId', 'total'],
 *   },
 * });
 *
 * // Type-safe event creation
 * const event = OrderCreated.create({ orderId: 'o-1', total: 100 });
 * await fastify.events.publish(event.type, event.payload, event.meta);
 *
 * // Registry for introspection + validation
 * const registry = createEventRegistry();
 * registry.register(OrderCreated);
 * const result = registry.validate('order.created', payload);
 * ```
 */

import { createEvent, type DomainEvent } from "./EventTransport.js";

// ============================================================================
// Types
// ============================================================================

export interface EventSchema {
  type: "object";
  properties?: Record<string, { type?: string; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

export interface EventDefinitionInput {
  /** Event type name (e.g., 'order.created') */
  name: string;
  /** JSON Schema for payload validation */
  schema?: EventSchema;
  /** Event version for schema evolution (default: 1) */
  version?: number;
  /** Human-readable description */
  description?: string;
}

export interface EventDefinitionOutput<T = unknown> {
  /** Event type name */
  readonly name: string;
  /** JSON Schema for payload validation */
  readonly schema?: EventSchema;
  /** Event version */
  readonly version: number;
  /** Human-readable description */
  readonly description?: string;
  /** Create a DomainEvent with this type + auto-generated metadata */
  create(payload: T, meta?: Partial<DomainEvent["meta"]>): DomainEvent<T>;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/** Custom validator function — replaces the built-in minimal validator. */
export type CustomValidator = (schema: EventSchema, payload: unknown) => ValidationResult;

export interface EventRegistryOptions {
  /**
   * Custom validator to replace the built-in minimal validator.
   * Use this for full JSON Schema validation (AJV, Zod, etc.).
   *
   * @example
   * ```typescript
   * import Ajv from 'ajv';
   * const ajv = new Ajv();
   *
   * const registry = createEventRegistry({
   *   validate: (schema, payload) => {
   *     const valid = ajv.validate(schema, payload);
   *     return valid
   *       ? { valid: true }
   *       : { valid: false, errors: ajv.errorsText().split(', ') };
   *   },
   * });
   * ```
   */
  validate?: CustomValidator;
}

export interface EventRegistry {
  /** Register an event definition */
  register(definition: EventDefinitionOutput): void;
  /** Get event definition by name (latest version if no version specified) */
  get(name: string, version?: number): EventDefinitionOutput | undefined;
  /** Get full catalog of registered events */
  catalog(): ReadonlyArray<{
    name: string;
    version: number;
    description?: string;
    schema?: EventSchema;
  }>;
  /** Validate a payload against a registered event's schema */
  validate(name: string, payload: unknown): ValidationResult;
}

// ============================================================================
// defineEvent
// ============================================================================

/**
 * Define a typed event with optional schema validation.
 *
 * @example
 * const OrderCreated = defineEvent({
 *   name: 'order.created',
 *   schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
 * });
 *
 * const event = OrderCreated.create({ orderId: '123' });
 */
export function defineEvent<T = unknown>(input: EventDefinitionInput): EventDefinitionOutput<T> {
  const { name, schema, version = 1, description } = input;

  return {
    name,
    schema,
    version,
    description,
    create(payload: T, meta?: Partial<DomainEvent["meta"]>): DomainEvent<T> {
      return createEvent(name, payload, meta);
    },
  };
}

// ============================================================================
// EventRegistry
// ============================================================================

/**
 * Create an event registry for cataloging and validating events.
 *
 * The registry is opt-in — unregistered events pass validation.
 * This allows gradual adoption without breaking existing code.
 *
 * @param options.validate - Custom validator replacing the built-in minimal validator.
 *   The built-in validator only checks top-level object structure (type, required, property types).
 *   For nested objects, arrays, enums, patterns, or $ref, provide AJV or similar.
 */
export function createEventRegistry(options?: EventRegistryOptions): EventRegistry {
  const customValidator = options?.validate;
  // Key: "name:version" for versioned lookup
  const definitions = new Map<string, EventDefinitionOutput>();

  function registryKey(name: string, version: number): string {
    return `${name}:v${version}`;
  }

  return {
    register(definition: EventDefinitionOutput): void {
      const key = registryKey(definition.name, definition.version);
      if (definitions.has(key)) {
        throw new Error(
          `Event '${definition.name}' v${definition.version} is already registered. ` +
            `Use a different version number for schema evolution.`,
        );
      }
      definitions.set(key, definition);
    },

    get(name: string, version?: number): EventDefinitionOutput | undefined {
      if (version !== undefined) {
        return definitions.get(registryKey(name, version));
      }
      // Find latest version
      let latest: EventDefinitionOutput | undefined;
      let latestVersion = -1;
      for (const def of definitions.values()) {
        if (def.name === name && def.version > latestVersion) {
          latest = def;
          latestVersion = def.version;
        }
      }
      return latest;
    },

    catalog(): ReadonlyArray<{
      name: string;
      version: number;
      description?: string;
      schema?: EventSchema;
    }> {
      return Array.from(definitions.values()).map((def) => ({
        name: def.name,
        version: def.version,
        description: def.description,
        schema: def.schema,
      }));
    },

    validate(name: string, payload: unknown): ValidationResult {
      // Find latest version of this event
      let latest: EventDefinitionOutput | undefined;
      let latestVersion = -1;
      for (const def of definitions.values()) {
        if (def.name === name && def.version > latestVersion) {
          latest = def;
          latestVersion = def.version;
        }
      }

      // Unknown events pass (registry is opt-in)
      if (!latest) return { valid: true };

      // Events without schema pass (schema is optional)
      if (!latest.schema) return { valid: true };

      // Use custom validator if provided, otherwise fall back to built-in minimal validator
      if (customValidator) {
        return customValidator(latest.schema, payload);
      }
      return validatePayload(payload, latest.schema);
    },
  };
}

// ============================================================================
// Minimal JSON Schema Validator
// ============================================================================

/**
 * Built-in minimal validator — lightweight guard, NOT a full JSON Schema engine.
 *
 * Checks:
 * - payload is an object (not null, not array)
 * - required fields are present
 * - top-level property types match (string, number, boolean, array, object)
 *
 * Does NOT check:
 * - nested object properties
 * - array item types
 * - enum, pattern, format, minLength, minimum, $ref
 *
 * For full validation, pass a custom `validate` function to `createEventRegistry()`.
 */
function validatePayload(payload: unknown, schema: EventSchema): ValidationResult {
  const errors: string[] = [];

  if (schema.type === "object") {
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return { valid: false, errors: ["Payload must be an object"] };
    }

    const record = payload as Record<string, unknown>;

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in record) || record[field] === undefined) {
          errors.push(`Missing required field: '${field}'`);
        }
      }
    }

    // Check property types (when properties are defined)
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in record && record[key] !== undefined && record[key] !== null) {
          const expectedType = propSchema.type;
          if (expectedType) {
            const actualType = Array.isArray(record[key]) ? "array" : typeof record[key];
            if (expectedType !== actualType) {
              errors.push(`Field '${key}': expected ${expectedType}, got ${actualType}`);
            }
          }
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
