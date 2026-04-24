/**
 * createMongooseAdapter — signature surface smoke test.
 *
 * A downstream review raised: "Arc 2.11 docs the positional form; is the
 * object form legacy?" This file locks in BOTH supported signatures + the
 * `OpenApiSchemas` type-import surface that the object-form `schemaGenerator`
 * field depends on. If any of these shift silently (signature narrowing,
 * type relocation, schemaGenerator removal), this file won't compile.
 *
 * Runtime tests run too — they prove both signatures return a usable
 * `DataAdapter` at runtime, not just a type.
 */

import type { Model } from "mongoose";
import { describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import type { OpenApiSchemas, RepositoryLike, RouteSchemaOptions } from "../../src/types/index.js";
import { createMockModel, createMockRepository } from "../setup.js";

describe("createMongooseAdapter — signature surface", () => {
  it("accepts positional (Model, repository) — shorthand 2-arg form", () => {
    const Model = createMockModel("AdSigPositional");
    const repo = createMockRepository(Model);

    const adapter = createMongooseAdapter(Model, repo);
    expect(adapter.type).toBe("mongoose");
    // biome-ignore lint/suspicious/noExplicitAny: adapter surface varies
    expect((adapter as any).model).toBe(Model);
  });

  it("accepts object form ({ model, repository }) — explicit", () => {
    const Model = createMockModel("AdSigObject");
    const repo = createMockRepository(Model);

    const adapter = createMongooseAdapter({
      model: Model,
      repository: repo,
    });
    expect(adapter.type).toBe("mongoose");
    // biome-ignore lint/suspicious/noExplicitAny: adapter surface varies
    expect((adapter as any).model).toBe(Model);
  });

  it("object form accepts a `schemaGenerator` that returns OpenApiSchemas", () => {
    // Type-level check as much as runtime: the `schemaGenerator` option
    // takes `(model, options?, context?) => OpenApiSchemas | Record<string, unknown>`.
    // If the signature narrows (e.g. removes `options` or changes the
    // return type), this test fails at compile time.
    const Model = createMockModel("AdSigSchemaGen");
    const repo = createMockRepository(Model);

    const schemaGen = (
      _model: Model<unknown>,
      _options?: RouteSchemaOptions,
    ): OpenApiSchemas => {
      return {
        entity: { type: "object", properties: {} },
        createBody: { type: "object", properties: {} },
        updateBody: { type: "object", properties: {} },
      };
    };

    const adapter = createMongooseAdapter({
      model: Model,
      repository: repo,
      schemaGenerator: schemaGen,
    });
    expect(adapter.type).toBe("mongoose");
  });

  it("2-arg form throws when repository is missing (defensive — TS catches this)", () => {
    const Model = createMockModel("AdSigMissingRepo");
    expect(() =>
      // Bypass TS to exercise the runtime guard — hosts on JS or with
      // `as any` casts should still get a helpful error.
      (createMongooseAdapter as unknown as (m: unknown) => unknown)(Model),
    ).toThrow(/repository is required/);
  });
});

describe("OpenApiSchemas — type export", () => {
  it("is importable from @classytic/arc/types (wasn't moved by the types-only cleanup)", () => {
    // Pure type-level check — if the type was relocated or renamed, the
    // import statement above would fail to compile. Presence of this test
    // case + successful typecheck is the proof.
    //
    // The runtime portion just ensures the test body has at least one
    // assertion so vitest records it as a real pass.
    const shape: OpenApiSchemas = {
      entity: { type: "object" },
      createBody: { type: "object" },
      updateBody: { type: "object" },
    };
    expect(shape.entity).toBeDefined();
  });

  it("has entity / createBody / updateBody fields (public contract)", () => {
    // Locks the shape the adapter consumer produces. If any of these
    // fields get renamed, the compile breaks; if they get added to the
    // required set, the object literal above fails.
    const schemaGen = (_m: unknown): OpenApiSchemas => ({
      entity: {},
      createBody: {},
      updateBody: {},
    });
    const result = schemaGen({});
    expect(result).toMatchObject({
      entity: expect.any(Object),
      createBody: expect.any(Object),
      updateBody: expect.any(Object),
    });
  });
});

describe("RepositoryLike — type contract", () => {
  it("createMongooseAdapter's repository parameter accepts any RepositoryLike shape", () => {
    // Type smoke: RepositoryLike is intentionally permissive
    // (`MinimalRepo & Partial<StandardRepo>`). A repo that only has the
    // minimum surface (create / getById / getAll) should satisfy the
    // adapter factory's type.
    const Model = createMockModel("AdSigRepoLike");
    const minimalRepo: RepositoryLike = {
      create: async () => ({ _id: "new" }),
      getById: async () => null,
      getAll: async () => ({
        method: "offset",
        docs: [],
        total: 0,
        page: 1,
        limit: 20,
        pages: 0,
        hasNext: false,
        hasPrev: false,
      }),
      update: async () => ({ _id: "new" }),
      delete: async () => ({ success: true }),
    };

    const adapter = createMongooseAdapter({ model: Model, repository: minimalRepo });
    expect(adapter.type).toBe("mongoose");
  });
});
