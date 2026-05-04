/**
 * Response Schema Tests
 *
 * Validates that response format helpers match the no-envelope wire contract:
 *   - Single-doc responses are emitted RAW (no `data` wrapper).
 *   - Paginated responses follow `{ method, data: T[], page, limit, total, pages, hasNext, hasPrev }`.
 *   - Bare lists are `{ data: T[] }`.
 *
 * HTTP status discriminates success vs error; there is no `success` field
 * on any payload.
 */

import { describe, expect, it } from "vitest";
import { sendControllerResponse } from "../../src/core/fastifyAdapter.js";
import { listResponse, paginationSchema } from "../../src/utils/responseSchemas.js";

describe("Response Format Consistency", () => {
  describe("Paginated List Response", () => {
    it("emits the canonical paginated wire shape", () => {
      // Mock controller response with paginated data (what BaseController.list returns)
      const mockPaginatedResponse = {
        data: {
          method: "offset" as const,
          data: [{ _id: "1", name: "Test" }],
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
        send: (payload: any) => {
          sentPayload = payload;
        },
      };

      sendControllerResponse(mockReply as any, mockPaginatedResponse);

      // No-envelope contract: pagination fields are flat at the top level.
      expect(sentPayload).not.toHaveProperty("success");
      expect(sentPayload).toHaveProperty("data");
      expect(sentPayload.data).toEqual([{ _id: "1", name: "Test" }]);

      expect(sentPayload.page).toBe(1);
      expect(sentPayload.limit).toBe(10);
      expect(sentPayload.total).toBe(1);
      expect(sentPayload.pages).toBe(1);
      expect(sentPayload.hasNext).toBe(false);
      expect(sentPayload.hasPrev).toBe(false);
    });

    it("listResponse schema is a oneOf union of every canonical wire shape", () => {
      // 2.13: listResponse() now models the FULL union toCanonicalList
      // can emit (offset / keyset / aggregate / bare) instead of only
      // offset. Hosts that pin a single variant use the per-shape
      // helpers below; the default helper accepts any kit-shaped result.
      const schema = listResponse({ type: "object", properties: { name: { type: "string" } } });
      expect(schema.oneOf).toBeDefined();
      expect(schema.oneOf).toHaveLength(4);

      // Each branch is keyed by `data: array`, no `success` field anywhere.
      for (const branch of schema.oneOf ?? []) {
        const props = (branch as { properties?: Record<string, unknown> }).properties ?? {};
        expect(props).toHaveProperty("data");
        expect(props).not.toHaveProperty("success");
      }

      // Branches discriminate via `method` (or its absence for the bare list).
      const methods = (schema.oneOf ?? [])
        .map((b) => {
          const m = (b as { properties?: Record<string, { const?: string }> }).properties?.method;
          return m?.const;
        })
        .sort((a, b) => String(a).localeCompare(String(b)));
      expect(methods).toEqual(["aggregate", "keyset", "offset", undefined]);

      // paginationSchema (legacy flat helper) still uses canonical field names.
      const paginationProps = paginationSchema.properties || {};
      expect(paginationProps).toHaveProperty("pages");
      expect(paginationProps).toHaveProperty("hasNext");
      expect(paginationProps).toHaveProperty("hasPrev");
      expect(paginationProps).not.toHaveProperty("totalPages");
      expect(paginationProps).not.toHaveProperty("hasNextPage");
      expect(paginationProps).not.toHaveProperty("hasPrevPage");
    });
  });

  describe("Single Item Response", () => {
    it("emits the document raw at the top level (no envelope)", () => {
      // Mock controller response for single item (what BaseController.get returns)
      const mockItemResponse = {
        data: { _id: "1", name: "Test Item" },
        status: 200,
      };

      let sentPayload: any;
      const mockReply = {
        code: (_c: number) => mockReply,
        send: (payload: any) => {
          sentPayload = payload;
        },
      };

      sendControllerResponse(mockReply as any, mockItemResponse);

      // No-envelope contract: the doc IS the body.
      expect(sentPayload).not.toHaveProperty("success");
      expect(sentPayload).toEqual({ _id: "1", name: "Test Item" });
    });

    // 2.13: no `itemResponse()` helper — single-doc responses ARE the
    // doc shape. Hosts pass their schema directly to Fastify's
    // `response: { 200: schema }`. The runtime contract above already
    // proves the wire shape; `tests/schemas/schema-helpers.test.ts`
    // pins the same contract on the TypeBox side.
  });
});
