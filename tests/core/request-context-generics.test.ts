/**
 * IRequestContext / ControllerHandler generics — type-level flexibility pin.
 *
 * IRequestContext was historically non-generic: req.body was always `unknown`,
 * req.params was always `Record<string, string>`, req.metadata was always
 * `Record<string, unknown>`. Custom controller handlers had to cast to get
 * type-safe access to their own request data — a major DX gap.
 *
 * The fix: IRequestContext + ControllerHandler are now generic in body,
 * params, query, user, and metadata, with permissive defaults so every
 * existing call site keeps working. This test pins the new contract using
 * @ts-expect-error / type assertions — no runtime work, just type-level
 * regression coverage.
 */

import { describe, expect, it } from "vitest";
import type { UserBase } from "../../src/permissions/types.js";
import type { ControllerHandler, IRequestContext } from "../../src/types/handlers.js";
import type { ArcInternalMetadata } from "../../src/types/index.js";

describe("IRequestContext generics — type-level flexibility", () => {
  it("default IRequestContext keeps the historical untyped shape (backward-compat)", () => {
    // Build a value that satisfies the default shape — req.body is `unknown`,
    // req.params is `Record<string, string>`, req.query is `Record<string, unknown>`.
    const req: IRequestContext = {
      params: { id: "abc" },
      query: { search: "foo", limit: 10 },
      body: { anything: "goes" },
      user: null,
      headers: {},
    };

    // body is unknown — narrowing required
    const body = req.body as { anything: string };
    expect(body.anything).toBe("goes");

    // params is Record<string, string> — `id` is typed as string
    expect(typeof req.params.id).toBe("string");
  });

  it("typed body — req.body has the supplied type (no narrowing needed)", () => {
    interface CreateProductInput {
      name: string;
      price: number;
    }

    const req: IRequestContext<CreateProductInput> = {
      params: {},
      query: {},
      body: { name: "Widget", price: 9.99 },
      user: null,
      headers: {},
    };

    // No `as` cast — direct field access works.
    expect(req.body.name).toBe("Widget");
    expect(req.body.price).toBe(9.99);
  });

  it("typed params — id is typed exactly as declared", () => {
    const req: IRequestContext<unknown, { id: string; slug: string }> = {
      params: { id: "p-1", slug: "widget" },
      query: {},
      body: undefined,
      user: null,
      headers: {},
    };

    expect(req.params.id).toBe("p-1");
    expect(req.params.slug).toBe("widget");
  });

  it("typed query — fields are typed exactly as declared", () => {
    const req: IRequestContext<
      unknown,
      Record<string, string>,
      { limit?: string; cursor?: string }
    > = {
      params: {},
      query: { limit: "20", cursor: "abc" },
      body: undefined,
      user: null,
      headers: {},
    };

    expect(req.query.limit).toBe("20");
    expect(req.query.cursor).toBe("abc");
  });

  it("typed metadata — ArcInternalMetadata gives typed access to _scope and _policyFilters", () => {
    const req: IRequestContext<
      unknown,
      Record<string, string>,
      Record<string, unknown>,
      UserBase, // user (default)
      ArcInternalMetadata
    > = {
      params: {},
      query: {},
      body: undefined,
      user: null,
      headers: {},
      metadata: {
        _scope: { kind: "public" },
        _policyFilters: { projectId: "p-1" },
      },
    };

    // Direct typed access — no `as` casts needed.
    expect(req.metadata?._scope?.kind).toBe("public");
    expect(req.metadata?._policyFilters).toEqual({ projectId: "p-1" });
  });

  it("custom user shape — user is typed as the supplied interface", () => {
    interface CompanyUser extends UserBase {
      companyId: string;
      tier: "free" | "pro" | "enterprise";
    }

    const req: IRequestContext<
      unknown,
      Record<string, string>,
      Record<string, unknown>,
      CompanyUser
    > = {
      params: {},
      query: {},
      body: undefined,
      user: { id: "u-1", companyId: "c-1", tier: "pro" },
      headers: {},
    };

    expect(req.user?.companyId).toBe("c-1");
    expect(req.user?.tier).toBe("pro");
  });

  it("ControllerHandler<TResponse> still works (single-generic backward-compat)", async () => {
    interface Product {
      _id: string;
      name: string;
    }

    const handler: ControllerHandler<Product> = async (req) => {
      // body is still `unknown` — must be narrowed
      const data = req.body as Partial<Product>;
      return { success: true, data: { _id: "1", name: data.name ?? "" }, status: 201 };
    };

    const req: IRequestContext = {
      params: {},
      query: {},
      body: { name: "Widget" },
      user: null,
      headers: {},
    };

    const result = await handler(req);
    expect(result.data?.name).toBe("Widget");
  });

  it("ControllerHandler<TResponse, TBody, TParams, TQuery> — fully typed end-to-end", async () => {
    interface Product {
      _id: string;
      name: string;
      price: number;
    }
    interface UpdateProductInput {
      name?: string;
      price?: number;
    }

    const handler: ControllerHandler<
      Product,
      UpdateProductInput,
      { id: string },
      { upsert?: string }
    > = async (req) => {
      // No narrowing — req.body, req.params.id, req.query.upsert all typed.
      const upsert = req.query.upsert === "true";
      return {
        success: true,
        data: {
          _id: req.params.id,
          name: req.body.name ?? "untitled",
          price: req.body.price ?? 0,
        },
        meta: { upsert },
      };
    };

    const result = await handler({
      params: { id: "p-1" },
      query: { upsert: "true" },
      body: { name: "New Name", price: 99 },
      user: null,
      headers: {},
    });

    expect(result.data).toEqual({ _id: "p-1", name: "New Name", price: 99 });
    expect(result.meta?.upsert).toBe(true);
  });
});
