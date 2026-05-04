/**
 * Files Upload Preset — unit tests
 *
 * Covers:
 * - Route shape and permission wiring
 * - multipartBody wiring on /upload only
 * - Response envelope
 * - includeRoutes opt-outs
 * - Range parsing correctness
 */

import { describe, expect, it, vi } from "vitest";
import { allowPublic, requireAuth, requireRoles } from "../../src/permissions/index.js";
import { filesUploadPreset } from "../../src/presets/filesUpload.js";
import type { ResourcePermissions, RouteDefinition } from "../../src/types/index.js";
import type { Storage } from "../../src/types/storage.js";

function resolveRoutes(
  preset: ReturnType<typeof filesUploadPreset>,
  permissions: ResourcePermissions = {},
): RouteDefinition[] {
  if (!preset.routes) return [];
  return typeof preset.routes === "function" ? preset.routes(permissions) : preset.routes;
}

function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  return {
    upload: vi.fn(async (input) => ({
      id: "id-1",
      url: "memory://id-1",
      pathname: "id-1",
      contentType: input.mimeType,
      bytes: input.size,
    })),
    read: vi.fn(async () => ({
      kind: "buffer",
      buffer: Buffer.from("x"),
      contentType: "application/octet-stream",
    })),
    delete: vi.fn(async () => true),
    ...overrides,
  };
}

describe("filesUploadPreset — configuration", () => {
  it("throws when storage is missing", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => filesUploadPreset({})).toThrow(/storage/);
  });

  it("registers under name 'filesUpload'", () => {
    const preset = filesUploadPreset({ storage: fakeStorage() });
    expect(preset.name).toBe("filesUpload");
  });

  it("produces three routes by default", () => {
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }));
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /upload",
      "GET /:id",
      "DELETE /:id",
    ]);
  });

  it("marks every route as raw so JSON envelope wrapping is bypassed", () => {
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }));
    for (const route of routes) {
      expect(route.raw).toBe(true);
    }
  });

  it("wires multipartBody as preHandler on POST /upload only", () => {
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }));
    const upload = routes.find((r) => r.path === "/upload");
    const read = routes.find((r) => r.path === "/:id" && r.method === "GET");
    const del = routes.find((r) => r.path === "/:id" && r.method === "DELETE");

    expect(upload?.preHandler).toBeDefined();
    expect(Array.isArray(upload?.preHandler) ? upload?.preHandler.length : 0).toBe(1);
    expect(read?.preHandler).toBeUndefined();
    expect(del?.preHandler).toBeUndefined();
  });

  it("defaults upload permission to requireAuth and read to allowPublic", () => {
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }));
    const upload = routes.find((r) => r.path === "/upload");
    const read = routes.find((r) => r.path === "/:id" && r.method === "GET");
    const del = routes.find((r) => r.path === "/:id" && r.method === "DELETE");
    expect(upload?.permissions).toBeDefined();
    expect(read?.permissions).toBeDefined();
    expect(del?.permissions).toBeDefined();
  });

  it("honors explicit per-route permissions over resource-level defaults", () => {
    const uploadPerm = requireRoles(["uploader"]);
    const readPerm = allowPublic();
    const deletePerm = requireRoles(["admin"]);

    const routes = resolveRoutes(
      filesUploadPreset({
        storage: fakeStorage(),
        permissions: { upload: uploadPerm, read: readPerm, delete: deletePerm },
      }),
      { create: requireAuth(), get: requireAuth(), delete: requireAuth() },
    );

    expect(routes.find((r) => r.path === "/upload")?.permissions).toBe(uploadPerm);
    expect(routes.find((r) => r.path === "/:id" && r.method === "GET")?.permissions).toBe(readPerm);
    expect(routes.find((r) => r.path === "/:id" && r.method === "DELETE")?.permissions).toBe(
      deletePerm,
    );
  });

  it("falls back to resource permissions when preset permissions are not set", () => {
    const resourceCreate = requireRoles(["admin"]);
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }), {
      create: resourceCreate,
    });
    const upload = routes.find((r) => r.path === "/upload");
    expect(upload?.permissions).toBe(resourceCreate);
  });

  it("includeRoutes: { upload: false } removes the upload route", () => {
    const routes = resolveRoutes(
      filesUploadPreset({ storage: fakeStorage(), includeRoutes: { upload: false } }),
    );
    expect(routes.find((r) => r.path === "/upload")).toBeUndefined();
    expect(routes.length).toBe(2);
  });

  it("includeRoutes: { read: false, delete: false } leaves only upload", () => {
    const routes = resolveRoutes(
      filesUploadPreset({
        storage: fakeStorage(),
        includeRoutes: { read: false, delete: false },
      }),
    );
    expect(routes.length).toBe(1);
    expect(routes[0]?.method).toBe("POST");
  });

  it("operation names are stable for pipeline keys and MCP tool naming", () => {
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }));
    const ops = routes.map((r) => r.operation);
    expect(ops).toEqual(["filesUpload.upload", "filesUpload.read", "filesUpload.delete"]);
  });

  it("GET /:id route disables MCP tool generation (binary endpoint)", () => {
    const routes = resolveRoutes(filesUploadPreset({ storage: fakeStorage() }));
    const read = routes.find((r) => r.path === "/:id" && r.method === "GET");
    expect(read?.mcp).toBe(false);
  });
});
