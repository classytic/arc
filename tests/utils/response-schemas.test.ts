/**
 * Response Schema Tests
 *
 * Validates that response format helpers match actual runtime response format
 */

import { describe, it, expect, vi } from 'vitest';
import { sendControllerResponse } from '../../src/core/fastifyAdapter.js';
import {
  listResponse,
  itemResponse,
  wrapResponse,
  paginationSchema,
  // Aliases for backwards compatibility
  itemWrapper,
  paginateWrapper,
  messageWrapper,
} from '../../src/utils/responseSchemas.js';

describe('Response Format Consistency', () => {
  describe('Paginated List Response', () => {
    it('should return docs array (not data) for list responses', () => {
      // Mock controller response with paginated data (what BaseController.list returns)
      const mockPaginatedResponse = {
        success: true,
        data: {
          docs: [{ _id: '1', name: 'Test' }],
          page: 1,
          limit: 10,
          total: 1,
          pages: 1,
          hasNext: false,
          hasPrev: false,
        },
        status: 200,
      };

      // Mock reply to capture sent payload
      let sentPayload: any;
      const mockReply = {
        code: (_c: number) => mockReply,
        send: (payload: any) => { sentPayload = payload; },
      };

      sendControllerResponse(mockReply as any, mockPaginatedResponse);

      // ACTUAL runtime format - should have 'docs' not 'data'
      expect(sentPayload).toHaveProperty('docs');
      expect(sentPayload).not.toHaveProperty('data');
      expect(sentPayload.docs).toEqual([{ _id: '1', name: 'Test' }]);

      // Pagination should be flat (not nested)
      expect(sentPayload.page).toBe(1);
      expect(sentPayload.limit).toBe(10);
      expect(sentPayload.total).toBe(1);
      expect(sentPayload.pages).toBe(1);
      expect(sentPayload.hasNext).toBe(false);
      expect(sentPayload.hasPrev).toBe(false);
    });

    it('schema helpers should match runtime format', () => {
      // Get the schema from responseSchemas.ts
      const schema = listResponse({ type: 'object', properties: { name: { type: 'string' } } });

      // Schema should now match runtime format
      const schemaProps = schema.properties || {};

      // Should have 'docs' property (not 'data')
      expect(schemaProps).toHaveProperty('docs');
      expect(schemaProps).not.toHaveProperty('data');

      // Pagination fields should be flat (not nested)
      expect(schemaProps).toHaveProperty('page');
      expect(schemaProps).toHaveProperty('limit');
      expect(schemaProps).toHaveProperty('total');
      expect(schemaProps).toHaveProperty('pages');
      expect(schemaProps).toHaveProperty('hasNext');
      expect(schemaProps).toHaveProperty('hasPrev');

      // Should NOT have nested pagination object
      expect(schemaProps).not.toHaveProperty('pagination');

      // Pagination schema should use correct field names
      const paginationProps = paginationSchema.properties || {};
      expect(paginationProps).toHaveProperty('pages'); // not 'totalPages'
      expect(paginationProps).toHaveProperty('hasNext'); // not 'hasNextPage'
      expect(paginationProps).toHaveProperty('hasPrev'); // not 'hasPrevPage'
      expect(paginationProps).not.toHaveProperty('totalPages');
      expect(paginationProps).not.toHaveProperty('hasNextPage');
      expect(paginationProps).not.toHaveProperty('hasPrevPage');
    });
  });

  describe('Single Item Response', () => {
    it('should return data for single item responses', () => {
      // Mock controller response for single item (what BaseController.get returns)
      const mockItemResponse = {
        success: true,
        data: { _id: '1', name: 'Test Item' },
        status: 200,
      };

      let sentPayload: any;
      const mockReply = {
        code: (_c: number) => mockReply,
        send: (payload: any) => { sentPayload = payload; },
      };

      sendControllerResponse(mockReply as any, mockItemResponse);

      // Single item uses 'data' (correct)
      expect(sentPayload).toHaveProperty('data');
      expect(sentPayload.data).toEqual({ _id: '1', name: 'Test Item' });
    });

    it('itemResponse schema should match runtime format', () => {
      const schema = itemResponse({ type: 'object', properties: { name: { type: 'string' } } });

      // itemResponse uses 'data' which is CORRECT for single items
      expect(schema.properties).toHaveProperty('data');
      expect(schema.properties).toHaveProperty('success');
    });
  });

  describe('Backwards Compatibility Aliases', () => {
    it('itemWrapper should be an alias for itemResponse', () => {
      const schema = { type: 'object' as const, properties: { name: { type: 'string' } } };
      const itemResult = itemResponse(schema);
      const wrapperResult = itemWrapper(schema);

      expect(itemResult).toEqual(wrapperResult);
    });

    it('paginateWrapper should be an alias for listResponse', () => {
      const schema = { type: 'object' as const, properties: { name: { type: 'string' } } };
      const listResult = listResponse(schema);
      const wrapperResult = paginateWrapper(schema);

      expect(listResult).toEqual(wrapperResult);
    });

    it('messageWrapper should return same schema as deleteResponse', () => {
      const messageResult = messageWrapper();

      expect(messageResult.properties).toHaveProperty('success');
      expect(messageResult.properties).toHaveProperty('message');
    });
  });
});
