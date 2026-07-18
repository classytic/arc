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

    it("listResponse schema is one merged permissive shape covering every canonical wire variant", () => {
      // 2.13 modelled the full union as a top-level oneOf; 2.22 merged it
      // into ONE permissive object because fast-json-stringify implements
      // oneOf via per-response AJV branch validation — on the hottest
      // route. Wire bytes are identical (pinned by
      // list-response-serialization.test.ts); this test pins the schema
      // SHAPE contract: every variant's fields declared, only `data`
      // required, no envelope, no oneOf.
      const schema = listResponse({ type: "object", properties: { name: { type: "string" } } });
      expect(schema.oneOf).toBeUndefined();
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["data"]);
      expect(schema.additionalProperties).toBe(true);

      const props = (schema.properties ?? {}) as Record<string, unknown>;
      // Offset/aggregate counters + keyset cursor fields all declared so
      // fast-json-stringify serializes them typed (not via the
      // additionalProperties slow path).
      for (const field of [
        "method",
        "data",
        "page",
        "limit",
        "total",
        "pages",
        "hasNext",
        "hasPrev",
        "hasMore",
        "next",
      ]) {
        expect(props).toHaveProperty(field);
      }
      expect(props).not.toHaveProperty("success");

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
