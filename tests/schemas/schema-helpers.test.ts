import { describe, expect, it } from "vitest";
import {
  Type,
  ArcListResponse,
  ArcItemResponse,
  ArcMutationResponse,
  ArcDeleteResponse,
  ArcErrorResponse,
  ArcPaginationQuery,
} from "../../src/schemas/index.js";

describe("ArcListResponse()", () => {
  it("returns a schema with docs array and pagination fields", () => {
    const schema = ArcListResponse(Type.Object({ name: Type.String() }));
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("docs");
    expect(schema.properties).toHaveProperty("total");
    expect(schema.properties).toHaveProperty("page");
    expect(schema.properties).toHaveProperty("limit");
    expect(schema.properties).toHaveProperty("pages");
    expect(schema.properties).toHaveProperty("hasNext");
    expect(schema.properties).toHaveProperty("hasPrev");
    expect(schema.properties).toHaveProperty("success");
  });
});

describe("ArcItemResponse()", () => {
  it("returns a schema with success and data", () => {
    const schema = ArcItemResponse(Type.Object({ id: Type.String() }));
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("success");
    expect(schema.properties).toHaveProperty("data");
  });
});

describe("ArcMutationResponse()", () => {
  it("returns a schema with success, data, and optional message", () => {
    const schema = ArcMutationResponse(Type.Object({ id: Type.String() }));
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("success");
    expect(schema.properties).toHaveProperty("data");
    expect(schema.properties).toHaveProperty("message");
  });
});

describe("ArcDeleteResponse()", () => {
  it("returns a schema with success and optional message", () => {
    const schema = ArcDeleteResponse();
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("success");
    expect(schema.properties).toHaveProperty("message");
  });
});

describe("ArcErrorResponse()", () => {
  it("returns a schema with error and optional code/message", () => {
    const schema = ArcErrorResponse();
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("error");
    expect(schema.properties).toHaveProperty("code");
    expect(schema.properties).toHaveProperty("success");
  });
});

describe("ArcPaginationQuery()", () => {
  it("returns a schema with page, limit, sort, select params", () => {
    const schema = ArcPaginationQuery();
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("page");
    expect(schema.properties).toHaveProperty("limit");
    expect(schema.properties).toHaveProperty("sort");
    expect(schema.properties).toHaveProperty("select");
  });
});
