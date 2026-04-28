/**
 * Scaffolded `createAdapter` glue — type-only regression for the mongokit
 * filter-IR drift the CLI feedback reported.
 *
 * The CLI's `init` template generates a `shared/adapter.ts` of the form:
 *
 *   export function createAdapter<TDoc = unknown>(
 *     model: Model<TDoc>,
 *     repository: Repository<TDoc>,   // mongokit's class
 *   ) { return createMongooseAdapter({ model, repository }); }
 *
 * Before the `AdapterRepositoryInput` widening this required
 * `repository as unknown as RepositoryLike<TDoc>` because mongokit's
 * `Repository.getAll` types `filters: Record<string, unknown>` while arc's
 * IR-aware `RepositoryLike.getAll` types `filters: Filter | Record<…>`.
 *
 * If this file compiles, scaffolded glue stays cast-free across mongokit
 * versions that lag repo-core's `Filter` IR rollout.
 */

import { Repository } from "@classytic/mongokit";
import type { Model } from "mongoose";
import { describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { createMockModel } from "../setup.js";

interface IProduct {
  _id?: string;
  name: string;
  price: number;
}

// Verbatim shape the CLI scaffolds — no host-side casts on `repository`.
function createAdapter<TDoc = unknown>(model: Model<TDoc>, repository: Repository<TDoc>) {
  return createMongooseAdapter({ model, repository });
}

describe("scaffolded createAdapter glue compiles without host-side casts", () => {
  it("createMongooseAdapter accepts mongokit Repository<TDoc> directly", () => {
    const model = createMockModel("ScaffoldMongokit") as unknown as Model<IProduct>;
    const repository = new Repository<IProduct>(model);
    const adapter = createAdapter<IProduct>(model, repository);
    expect(adapter.type).toBe("mongoose");
  });
});
