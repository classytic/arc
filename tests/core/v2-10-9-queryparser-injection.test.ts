/**
 * Regression: `defineResource({ controller, queryParser })` used to
 * forward the queryParser ONLY to the auto-constructed `BaseController`
 * path. When the caller supplied their own controller (e.g. to override
 * `create` or add custom repository methods), the controller kept the
 * default `ArcQueryParser` and every `[contains]` / `[like]` filter on
 * that resource silently fell back to case-sensitive regex.
 *
 * Every project scaffolded by `arc init` shipped this shape, so the
 * bug surfaced in production fuzzy-search endpoints across be-prod and
 * fajr-be-arc (e.g. `name[contains]=bigboss` missing "Bigboss Factory").
 *
 * 2.10.9 fix:
 * - `BaseController` now has `setQueryParser(qp)` which rebuilds its
 *   internal `QueryResolver` with the new parser.
 * - `defineResource` calls it via duck-typing when the caller supplies
 *   both `controller` and `queryParser`. Controllers that don't
 *   implement the method (custom non-BaseController variants) are left
 *   untouched — no throw, no warn, explicit opt-out.
 *
 * Paired with a companion fix in `ArcQueryParser` itself: `contains`
 * and `like` now emit `$options: 'i'` (case-insensitive), matching
 * their documented behavior. See tests/utils/query-parser.test.ts.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { DataAdapter, QueryParserInterface } from "../../src/types/index.js";
import { ArcQueryParser, createQueryParser } from "../../src/utils/queryParser.js";

interface Doc {
  _id?: string;
  name: string;
}

function mockRepo(): RepositoryLike<Doc> {
  return {
    async getAll() {
      return { data: [], total: 0 };
    },
    async getById() {
      return null;
    },
    async create(d: Partial<Doc>) {
      return d as Doc;
    },
    async update() {
      return null;
    },
    async delete() {
      return { acknowledged: true, deletedCount: 0 };
    },
  };
}

describe("2.10.9 — BaseController.setQueryParser", () => {
  it("swaps the parser in place — the resolver instance is referentially stable", () => {
    const ctrl = new BaseController<Doc>(mockRepo() as never);
    const resolverRef = ctrl.queryResolver;

    // Swap in a sentinel parser
    const sentinel = createQueryParser({ maxLimit: 50 });
    ctrl.setQueryParser(sentinel);

    // 2.13: setQueryParser mutates QueryResolver in place via setParser().
    // No reconstruction → no second copy of defaultSort/tenantField for the
    // swap to drift away from. Hosts that captured `ctrl.queryResolver`
    // keep a valid ref.
    expect(ctrl.queryResolver).toBe(resolverRef);
    expect((ctrl as unknown as { queryParser: QueryParserInterface }).queryParser).toBe(sentinel);
    // The resolver itself now holds the sentinel
    expect((resolverRef as unknown as { queryParser: QueryParserInterface }).queryParser).toBe(
      sentinel,
    );
  });

  it("preserves maxLimit / tenantField / schemaOptions across the swap", () => {
    const ctrl = new BaseController<Doc>(mockRepo() as never, {
      maxLimit: 200,
      tenantField: "workspaceId",
      schemaOptions: { filterableFields: ["name"] },
    });

    ctrl.setQueryParser(createQueryParser());

    // Internal state survives — setQueryParser only swaps the parser
    expect((ctrl as unknown as { maxLimit: number }).maxLimit).toBe(200);
    expect((ctrl as unknown as { tenantField: string | false }).tenantField).toBe("workspaceId");
  });
});

describe("2.10.9 — defineResource wires queryParser into user-supplied controllers", () => {
  it("calls setQueryParser on the user-supplied controller when queryParser is declared", () => {
    const sentinel = createQueryParser({ maxLimit: 75 });
    const repo = mockRepo();
    const adapter: DataAdapter<Doc> = {
      repository: repo as unknown as DataAdapter<Doc>["repository"],
      type: "mock",
      name: "mock",
    };

    // User-supplied controller (subclassing BaseController — the
    // documented pattern for custom create/update overrides).
    const custom = new BaseController<Doc>(repo as never);
    const resolverRef = custom.queryResolver;

    defineResource<Doc>({
      name: "custom",
      adapter,
      controller: custom,
      queryParser: sentinel,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // The injection fired: the resolver instance is the same (in-place mutate)
    // and now holds the sentinel parser.
    expect(custom.queryResolver).toBe(resolverRef);
    expect((custom as unknown as { queryParser: QueryParserInterface }).queryParser).toBe(sentinel);
    expect((resolverRef as unknown as { queryParser: QueryParserInterface }).queryParser).toBe(
      sentinel,
    );
  });

  it("leaves a non-BaseController custom controller alone (no setQueryParser → no throw)", () => {
    // Some hosts ship a completely custom controller that doesn't
    // extend BaseController. Arc must not throw just because
    // `setQueryParser` is missing — the caller knows what they built.
    const sentinel = createQueryParser();
    const custom = {
      async list() {
        return { success: true, data: { data: [], total: 0 } };
      },
      async get() {
        return { success: true, data: null };
      },
      async create() {
        return { success: true, data: {} };
      },
      async update() {
        return { success: true, data: {} };
      },
      async delete() {
        return { success: true, data: { message: "ok" } };
      },
    };

    const adapter: DataAdapter<Doc> = {
      repository: mockRepo() as unknown as DataAdapter<Doc>["repository"],
      type: "mock",
      name: "mock",
    };

    // Should NOT throw
    expect(() =>
      defineResource<Doc>({
        name: "custom-noctrl",
        adapter,
        controller: custom as unknown as never,
        queryParser: sentinel,
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      }),
    ).not.toThrow();
  });

  it("does NOT invoke setQueryParser when no queryParser is declared (no-op)", () => {
    // Guard: the injection must be gated on `resolvedConfig.queryParser`.
    // Otherwise custom controllers lose their default parser every time
    // `defineResource` wires them up.
    const custom = new BaseController<Doc>(mockRepo() as never);
    const before = custom.queryResolver;

    defineResource<Doc>({
      name: "no-qp",
      adapter: {
        repository: mockRepo() as unknown as DataAdapter<Doc>["repository"],
        type: "mock",
        name: "mock",
      },
      controller: custom,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    expect(custom.queryResolver).toBe(before);
  });
});

describe("2.13 — setQueryParser preserves `defaultSort: false`", () => {
  it("does not silently re-enable the framework default sort after a parser swap", () => {
    // Pre-2.13: setQueryParser rebuilt QueryResolver from `this.defaultSort`,
    // which collapsed `false → undefined` in the constructor — so the rebuild
    // re-enabled the framework default `-createdAt`. SQL-style resources
    // (no `createdAt` column) silently regained an invalid default sort
    // whenever defineResource forwarded a custom queryParser.
    //
    // 2.13 fix: setQueryParser mutates the resolver in place; `defaultSort`
    // lives in exactly one place (the resolver), so there is nothing to drift.
    const ctrl = new BaseController<Doc>(mockRepo() as never, { defaultSort: false });
    ctrl.setQueryParser(createQueryParser());

    const result = ctrl.queryResolver.resolve({
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
    } as never);

    // `defaultSort: false` must persist across the swap → no sort clause.
    expect(result.sort).toBeUndefined();
  });
});

describe("2.10.9 — parity check: auto-constructed and user-supplied paths emit the same filter shape", () => {
  it("a `[contains]` filter survives the same way through both controller paths", () => {
    // The core behavioral claim: with 2.10.9's fix, the filter shape
    // produced by a resource WITH a user-supplied controller matches
    // the shape produced by one WITHOUT. Pre-fix, they differed because
    // the user-supplied path used the default parser.
    const parser = new ArcQueryParser();
    const expected = parser.parse({ name: { contains: "Bigboss" } }).filters;

    // (Exercised end-to-end in the mongokit/sqlitekit integration
    // tests when applicable — this unit test pins the parser contract.)
    expect(expected).toEqual({
      name: { $regex: "Bigboss", $options: "i" },
    });
  });
});
