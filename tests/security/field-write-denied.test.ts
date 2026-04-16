/**
 * Security Tests: Field-Level Write Permission Denial
 *
 * Verifies that requests carrying fields the caller can't write are
 * rejected by default (403) rather than silently stripped. Silent
 * stripping hides misconfigurations and makes real attacks invisible —
 * the 'reject' policy is a secure default (see 2026-Q2 security audit).
 *
 * Uses BodySanitizer directly — the same unit the controller chain uses,
 * so the policy is verified at the real enforcement point without needing
 * a full app boot.
 */

import { describe, expect, it } from "vitest";
import { BodySanitizer } from "../../src/core/BodySanitizer.js";
import { type FieldPermissionMap, fields } from "../../src/permissions/fields.js";
import { PUBLIC_SCOPE } from "../../src/scope/types.js";
import type { ArcInternalMetadata, IRequestContext } from "../../src/types/index.js";
import { ForbiddenError } from "../../src/utils/errors.js";

function makeReq(user: { role?: string[] } | undefined): IRequestContext {
  return {
    user,
    body: {},
    params: {},
    query: {},
    headers: {},
    metadata: {},
  } as unknown as IRequestContext;
}

function makeMeta(fieldPerms: FieldPermissionMap): ArcInternalMetadata {
  return {
    _scope: PUBLIC_SCOPE,
    arc: { fields: fieldPerms },
  } as unknown as ArcInternalMetadata;
}

describe("Security: Field-Level Write Denial", () => {
  const fieldPerms: FieldPermissionMap = {
    role: fields.writableBy(["admin"]),
    internalNotes: fields.writableBy(["admin"]),
    password: fields.hidden(),
  };

  describe("default policy (reject)", () => {
    it("throws ForbiddenError listing the denied writableBy field", () => {
      const sanitizer = new BodySanitizer({ schemaOptions: {} });
      const req = makeReq({ role: ["viewer"] });
      const meta = makeMeta(fieldPerms);

      expect(() =>
        sanitizer.sanitize({ name: "John", role: "admin" }, "update", req, meta),
      ).toThrow(ForbiddenError);
    });

    it("throws when a hidden field is provided", () => {
      const sanitizer = new BodySanitizer({ schemaOptions: {} });
      const req = makeReq({ role: ["admin"] });
      const meta = makeMeta(fieldPerms);

      expect(() =>
        sanitizer.sanitize({ name: "John", password: "attempt" }, "create", req, meta),
      ).toThrow(ForbiddenError);
    });

    it("error message lists every denied field", () => {
      const sanitizer = new BodySanitizer({ schemaOptions: {} });
      const req = makeReq({ role: ["viewer"] });
      const meta = makeMeta(fieldPerms);

      try {
        sanitizer.sanitize(
          { name: "John", role: "admin", internalNotes: "leak" },
          "update",
          req,
          meta,
        );
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as Error).message).toContain("role");
        expect((err as Error).message).toContain("internalNotes");
      }
    });

    it("allows the request when caller has the required role", () => {
      const sanitizer = new BodySanitizer({ schemaOptions: {} });
      const req = makeReq({ role: ["admin"] });
      const meta = makeMeta(fieldPerms);

      const result = sanitizer.sanitize({ name: "John", role: "editor" }, "update", req, meta);
      expect(result.role).toBe("editor");
    });

    it("allows the request when restricted fields are absent", () => {
      const sanitizer = new BodySanitizer({ schemaOptions: {} });
      const req = makeReq({ role: ["viewer"] });
      const meta = makeMeta(fieldPerms);

      const result = sanitizer.sanitize({ name: "John" }, "update", req, meta);
      expect(result.name).toBe("John");
    });
  });

  describe("legacy policy (strip)", () => {
    it("silently drops denied fields instead of throwing", () => {
      const sanitizer = new BodySanitizer({
        schemaOptions: {},
        onFieldWriteDenied: "strip",
      });
      const req = makeReq({ role: ["viewer"] });
      const meta = makeMeta(fieldPerms);

      const result = sanitizer.sanitize(
        { name: "John", role: "admin", password: "attempt" },
        "update",
        req,
        meta,
      );
      expect(result.name).toBe("John");
      expect(result).not.toHaveProperty("role");
      expect(result).not.toHaveProperty("password");
    });
  });
});
