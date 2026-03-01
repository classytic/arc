/**
 * Schema Converter Tests
 *
 * Tests the detect-first, convert-only-when-needed schema converter
 * using Zod v4's native z.toJSONSchema().
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  isJsonSchema,
  isZodSchema,
  toJsonSchema,
  convertOpenApiSchemas,
  convertRouteSchema,
} from '../../src/utils/schemaConverter.js';

// ============================================================================
// Tests: isJsonSchema
// ============================================================================

describe('isJsonSchema', () => {
  it('returns true for objects with type property', () => {
    expect(isJsonSchema({ type: 'string' })).toBe(true);
    expect(isJsonSchema({ type: 'object', properties: {} })).toBe(true);
  });

  it('returns true for objects with properties property', () => {
    expect(isJsonSchema({ properties: { name: { type: 'string' } } })).toBe(true);
  });

  it('returns true for $ref schemas', () => {
    expect(isJsonSchema({ $ref: '#/components/schemas/User' })).toBe(true);
  });

  it('returns true for allOf/anyOf/oneOf schemas', () => {
    expect(isJsonSchema({ allOf: [{ type: 'string' }] })).toBe(true);
    expect(isJsonSchema({ anyOf: [{ type: 'string' }] })).toBe(true);
    expect(isJsonSchema({ oneOf: [{ type: 'string' }] })).toBe(true);
  });

  it('returns true for enum schemas', () => {
    expect(isJsonSchema({ enum: ['a', 'b'] })).toBe(true);
  });

  it('returns false for Zod v4 schemas', () => {
    expect(isJsonSchema(z.string())).toBe(false);
    expect(isJsonSchema(z.object({ name: z.string() }))).toBe(false);
  });

  it('returns false for null/undefined/primitives', () => {
    expect(isJsonSchema(null)).toBe(false);
    expect(isJsonSchema(undefined)).toBe(false);
    expect(isJsonSchema('string')).toBe(false);
    expect(isJsonSchema(42)).toBe(false);
  });

  it('returns false for empty objects', () => {
    expect(isJsonSchema({})).toBe(false);
  });
});

// ============================================================================
// Tests: isZodSchema
// ============================================================================

describe('isZodSchema', () => {
  it('returns true for Zod v4 schemas', () => {
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(z.number())).toBe(true);
    expect(isZodSchema(z.boolean())).toBe(true);
    expect(isZodSchema(z.object({ name: z.string() }))).toBe(true);
    expect(isZodSchema(z.array(z.string()))).toBe(true);
  });

  it('returns false for non-Zod values', () => {
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
    expect(isZodSchema('hello')).toBe(false);
    expect(isZodSchema(42)).toBe(false);
    expect(isZodSchema({})).toBe(false);
    expect(isZodSchema({ type: 'string' })).toBe(false);
  });
});

// ============================================================================
// Tests: toJsonSchema
// ============================================================================

describe('toJsonSchema', () => {
  it('returns undefined for null/undefined', () => {
    expect(toJsonSchema(null)).toBeUndefined();
    expect(toJsonSchema(undefined)).toBeUndefined();
  });

  it('passes through plain JSON Schema objects unchanged', () => {
    const jsonSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const result = toJsonSchema(jsonSchema);
    expect(result).toBe(jsonSchema); // Same reference — zero-cost passthrough
  });

  it('passes through $ref schemas unchanged', () => {
    const ref = { $ref: '#/components/schemas/User' };
    expect(toJsonSchema(ref)).toBe(ref);
  });

  it('converts Zod string schema', () => {
    const result = toJsonSchema(z.string());
    expect(result).toMatchObject({ type: 'string' });
  });

  it('converts Zod number schema', () => {
    const result = toJsonSchema(z.number());
    expect(result).toMatchObject({ type: 'number' });
  });

  it('converts Zod boolean schema', () => {
    const result = toJsonSchema(z.boolean());
    expect(result).toMatchObject({ type: 'boolean' });
  });

  it('converts Zod object schema with required fields', () => {
    const result = toJsonSchema(z.object({ name: z.string(), age: z.number() }));
    expect(result).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    });
    // Both fields should be required
    expect((result as any).required).toEqual(expect.arrayContaining(['name', 'age']));
  });

  it('converts Zod object with optional fields', () => {
    const result = toJsonSchema(z.object({
      email: z.string(),
      nickname: z.optional(z.string()),
    }));
    expect(result).toMatchObject({
      type: 'object',
      properties: {
        email: { type: 'string' },
      },
    });
    // email is required, nickname is not
    expect((result as any).required).toContain('email');
    expect((result as any).required).not.toContain('nickname');
    expect((result as any).properties.nickname).toBeDefined();
  });

  it('converts Zod string with email format', () => {
    const result = toJsonSchema(z.string().email());
    expect(result).toMatchObject({ type: 'string', format: 'email' });
  });

  it('converts Zod string with url format', () => {
    const result = toJsonSchema(z.string().url());
    expect(result).toMatchObject({ type: 'string', format: 'uri' });
  });

  it('converts Zod string with uuid format', () => {
    const result = toJsonSchema(z.string().uuid());
    expect(result).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('converts Zod array schema', () => {
    const result = toJsonSchema(z.array(z.string()));
    expect(result).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts Zod enum schema', () => {
    const result = toJsonSchema(z.enum(['active', 'inactive', 'pending']));
    expect(result).toMatchObject({
      type: 'string',
      enum: ['active', 'inactive', 'pending'],
    });
  });

  it('converts Zod record schema', () => {
    const result = toJsonSchema(z.record(z.string(), z.number()));
    expect(result).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('converts Zod intersection (e.g. Better Auth signUpEmail body)', () => {
    const left = z.object({ name: z.string(), email: z.string().email(), password: z.string() });
    const right = z.record(z.string(), z.string());
    const result = toJsonSchema(z.intersection(left, right));
    // Native z.toJSONSchema produces allOf for intersections
    expect(result).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            name: { type: 'string' },
            password: { type: 'string' },
          }),
        }),
      ]),
    });
  });

  it('converts Zod default values', () => {
    const result = toJsonSchema(z.object({
      rememberMe: z.boolean().default(true),
      email: z.string(),
    }));
    expect(result).toMatchObject({
      type: 'object',
      properties: {
        rememberMe: { type: 'boolean', default: true },
        email: { type: 'string' },
      },
    });
    // Both fields are in required (Zod v4 treats default fields as required in JSON Schema)
    expect((result as any).required).toContain('email');
    expect((result as any).required).toContain('rememberMe');
  });

  it('returns unrecognized objects as-is', () => {
    const unknown = { foo: 'bar', baz: 42 };
    expect(toJsonSchema(unknown)).toBe(unknown);
  });

  it('falls back to { type: "object" } for broken Zod-like objects', () => {
    // Object with _zod marker but not a valid Zod schema — z.toJSONSchema() will throw
    const fakeZod = { _zod: { invalid: true } };
    const result = toJsonSchema(fakeZod);
    expect(result).toEqual({ type: 'object' });
  });
});

// ============================================================================
// Tests: convertOpenApiSchemas
// ============================================================================

describe('convertOpenApiSchemas', () => {
  it('passes through plain JSON Schema fields unchanged', () => {
    const schemas = {
      createBody: { type: 'object', properties: { name: { type: 'string' } } },
      response: { type: 'object', properties: { _id: { type: 'string' } } },
    };
    const result = convertOpenApiSchemas(schemas);
    expect(result.createBody).toBe(schemas.createBody); // Same reference
    expect(result.response).toBe(schemas.response);
  });

  it('converts Zod schemas in fields', () => {
    const schemas = {
      createBody: z.object({ name: z.string(), email: z.string().email() }),
      response: { type: 'object', properties: { _id: { type: 'string' } } },
    };
    const result = convertOpenApiSchemas(schemas);
    expect(result.createBody).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: expect.objectContaining({ type: 'string', format: 'email' }),
      },
    });
    // response stays as-is
    expect(result.response).toBe(schemas.response);
  });

  it('handles mixed Zod + JSON Schema fields', () => {
    const schemas = {
      createBody: z.object({ title: z.string() }),
      listQuery: { type: 'object', properties: { page: { type: 'integer' } } },
      updateBody: z.object({ title: z.optional(z.string()) }),
    };
    const result = convertOpenApiSchemas(schemas);
    expect(result.createBody).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    expect(result.listQuery).toBe(schemas.listQuery);
    expect(result.updateBody).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
    });
  });

  it('preserves extra fields', () => {
    const schemas = {
      createBody: { type: 'object' },
      customField: { type: 'object', description: 'custom' },
    };
    const result = convertOpenApiSchemas(schemas);
    expect(result.customField).toBe(schemas.customField);
  });

  it('handles empty schemas', () => {
    const result = convertOpenApiSchemas({});
    expect(result).toEqual({});
  });
});

// ============================================================================
// Tests: convertRouteSchema
// ============================================================================

describe('convertRouteSchema', () => {
  it('passes through plain JSON Schema body/querystring unchanged', () => {
    const schema = {
      body: { type: 'object', properties: { name: { type: 'string' } } },
      querystring: { type: 'object', properties: { page: { type: 'integer' } } },
    };
    const result = convertRouteSchema(schema);
    expect(result.body).toBe(schema.body);
    expect(result.querystring).toBe(schema.querystring);
  });

  it('converts Zod body schema', () => {
    const schema = {
      body: z.object({ items: z.array(z.string()) }),
    };
    const result = convertRouteSchema(schema);
    expect(result.body).toMatchObject({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['items'],
    });
  });

  it('converts Zod querystring schema', () => {
    const schema = {
      querystring: z.object({ dryRun: z.optional(z.boolean()) }),
    };
    const result = convertRouteSchema(schema);
    expect(result.querystring).toMatchObject({
      type: 'object',
      properties: {
        dryRun: { type: 'boolean' },
      },
    });
  });

  it('converts params and headers', () => {
    const schema = {
      params: z.object({ id: z.string() }),
      headers: z.object({ authorization: z.string() }),
    };
    const result = convertRouteSchema(schema);
    expect(result.params).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    expect(result.headers).toMatchObject({
      type: 'object',
      properties: { authorization: { type: 'string' } },
      required: ['authorization'],
    });
  });

  it('converts response schemas by status code', () => {
    const schema = {
      response: {
        200: z.object({ success: z.boolean() }),
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    };
    const result = convertRouteSchema(schema);
    const response = result.response as Record<string, unknown>;
    expect(response['200']).toMatchObject({
      type: 'object',
      properties: { success: { type: 'boolean' } },
      required: ['success'],
    });
    // 404 is already JSON Schema — passthrough
    expect(response['404']).toBe((schema.response as Record<string, unknown>)['404']);
  });

  it('preserves non-schema fields (tags, summary, etc.)', () => {
    const schema = {
      tags: ['Test'],
      summary: 'Test route',
      body: z.object({ name: z.string() }),
    };
    const result = convertRouteSchema(schema);
    expect(result.tags).toEqual(['Test']);
    expect(result.summary).toBe('Test route');
    expect(result.body).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });
});
