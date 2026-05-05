/**
 * Tests for the per-request entity helpers used by action handlers.
 */

import { describe, expect, it } from "vitest";
import {
  getEntityId,
  getEntityIdField,
  getEntityQuery,
} from "../../src/core/entityHelpers.js";
import type { RequestWithExtras } from "../../src/types/index.js";

function reqWith(arc?: RequestWithExtras["arc"], params?: Record<string, unknown>) {
  return { arc, params } as unknown as RequestWithExtras;
}

describe("getEntityIdField", () => {
  it("returns `_id` when the route hasn't bound an idField", () => {
    expect(getEntityIdField(reqWith())).toBe("_id");
  });

  it("returns the bound idField when set on req.arc", () => {
    expect(getEntityIdField(reqWith({ idField: "reportId" }))).toBe("reportId");
  });
});

describe("getEntityId", () => {
  it("reads req.arc.entityId when present", () => {
    expect(getEntityId(reqWith({ entityId: "ANB-2026-0001" }))).toBe("ANB-2026-0001");
  });

  it("falls back to req.params.id when arc metadata is absent", () => {
    expect(getEntityId(reqWith(undefined, { id: "raw-param" }))).toBe("raw-param");
  });

  it("returns undefined when no entity context available (collection routes)", () => {
    expect(getEntityId(reqWith())).toBeUndefined();
  });
});

describe("getEntityQuery", () => {
  it("composes `{ [idField]: entityId }` for the standard custom-handle case", () => {
    expect(
      getEntityQuery(
        reqWith({ idField: "reportId", entityId: "ANB-2026-0001" }),
      ),
    ).toEqual({ reportId: "ANB-2026-0001" });
  });

  it("defaults to `_id` when idField isn't bound", () => {
    expect(
      getEntityQuery(reqWith({ entityId: "507f1f77bcf86cd799439011" })),
    ).toEqual({ _id: "507f1f77bcf86cd799439011" });
  });

  it("returns {} when entity context isn't available", () => {
    expect(getEntityQuery(reqWith())).toEqual({});
  });

  it("works for slug-driven resources too", () => {
    expect(
      getEntityQuery(reqWith({ idField: "slug", entityId: "premium-headphones" })),
    ).toEqual({ slug: "premium-headphones" });
  });
});
