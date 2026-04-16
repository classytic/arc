/**
 * RepositoryLike — aggregation builder surface
 *
 * Asserts that `buildAggregation()` and `buildLookup()` (added in arc v2.9
 * after mongokit 3.7 landed) are reachable through the adapter boundary and
 * round-trip a real aggregation pipeline on a mongodb-memory-server instance.
 *
 * This locks in three DX guarantees:
 *
 *   1. mongokit's `Repository` satisfies `RepositoryLike` WITHOUT casts, even
 *      though `buildAggregation` returns the kit-specific `AggregationBuilder`
 *      class. The declared return is `unknown` on arc's side so any kit can
 *      fit without forcing arc to depend on mongoose types.
 *
 *   2. A resource built on top of that repo can reach the builder methods
 *      (e.g. from a custom `action` handler) via `repo.buildAggregation?.()`
 *      — the optional-call pattern that prevents non-MongoDB adapters from
 *      throwing when they don't implement it.
 *
 *   3. The returned builder produces a pipeline that the repo's `aggregate`
 *      method accepts, closing the end-to-end loop.
 */

import { AggregationBuilder, LookupBuilder, Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryLike } from "../../src/adapters/interface.js";

interface ITask {
  title: string;
  status: "todo" | "done";
  tagId?: mongoose.Types.ObjectId;
}

interface ITag {
  _id: mongoose.Types.ObjectId;
  name: string;
}

const TaskSchema = new Schema<ITask>({
  title: { type: String, required: true },
  status: { type: String, enum: ["todo", "done"], default: "todo" },
  tagId: { type: Schema.Types.ObjectId, ref: "BuilderTag" },
});

const TagSchema = new Schema<ITag>({
  name: { type: String, required: true },
});

let mongoServer: MongoMemoryServer;
let TaskModel: Model<ITask>;
let TagModel: Model<ITag>;

describe("RepositoryLike — aggregation builders", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const conn = await mongoose.connect(mongoServer.getUri());
    TaskModel = conn.models.BuilderTask || conn.model<ITask>("BuilderTask", TaskSchema);
    TagModel = conn.models.BuilderTag || conn.model<ITag>("BuilderTag", TagSchema);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    // Per-test isolation — the mongodb-memory-server is shared across
    // tests in this file, so data from one test must not leak into the next.
    await TaskModel?.deleteMany({});
    await TagModel?.deleteMany({});
  });

  it("mongokit Repository satisfies RepositoryLike's builder surface without casts", () => {
    const repo = new Repository(TaskModel);

    // Assign to `RepositoryLike` — compile-time check. If this line fails to
    // type-check, the interface drifted and mongokit no longer structurally
    // matches. We don't need a runtime assertion for this — tsc does the work.
    const asLike: RepositoryLike = repo;

    expect(typeof asLike.buildAggregation).toBe("function");
    expect(typeof asLike.buildLookup).toBe("function");
  });

  it("buildAggregation() returns a builder usable to run a pipeline end-to-end", async () => {
    const repo = new Repository(TaskModel);
    const asLike = repo as RepositoryLike;

    await TaskModel.create([
      { title: "A", status: "done" },
      { title: "B", status: "done" },
      { title: "C", status: "todo" },
    ]);

    // Cast at the call site — same pattern we recommend in the JSDoc on
    // RepositoryLike.buildAggregation.
    const builder = asLike.buildAggregation?.() as AggregationBuilder;
    expect(builder).toBeInstanceOf(AggregationBuilder);

    const pipeline = builder
      .match({ status: "done" })
      .group({ _id: "$status", count: { $sum: 1 } })
      .build();

    const result = await TaskModel.aggregate(pipeline);
    expect(result).toEqual([{ _id: "done", count: 2 }]);
  });

  it("buildLookup() produces $lookup stages that integrate into a larger pipeline", async () => {
    const tagRepo = new Repository(TagModel);
    const taskRepo = new Repository(TaskModel);

    const tag = await TagModel.create({ name: "urgent" });
    await TaskModel.create([
      { title: "fix bug", status: "todo", tagId: tag._id },
      { title: "write test", status: "todo", tagId: tag._id },
    ]);

    // Cast at the call site. LookupBuilder here comes from mongokit, not arc.
    const lookup = (taskRepo as RepositoryLike).buildLookup?.("buildertags") as LookupBuilder;
    expect(lookup).toBeInstanceOf(LookupBuilder);

    const stages = lookup.localField("tagId").foreignField("_id").as("tag").single().build();

    const pipeline = [{ $match: { status: "todo" } }, ...stages];
    const results = await TaskModel.aggregate(pipeline);

    expect(results).toHaveLength(2);
    expect((results[0] as { tag?: { name: string } }).tag?.name).toBe("urgent");

    // tagRepo silences the unused-var lint; also proves repo parity for tags.
    expect(tagRepo).toBeInstanceOf(Repository);
  });

  it("optional-call pattern is safe on adapters that don't implement the builders", () => {
    // A non-mongokit RepositoryLike that deliberately omits buildAggregation
    // — e.g. an in-memory test stub or a SQL adapter. The optional-call in
    // the call site MUST not throw.
    const stub: RepositoryLike = {
      async getAll() {
        return { docs: [], total: 0, page: 1, pages: 0, hasNext: false, hasPrev: false };
      },
      async getById() {
        return null;
      },
      async create() {
        return {};
      },
      async update() {
        return {};
      },
      async delete() {
        return { success: true };
      },
    };

    expect(stub.buildAggregation).toBeUndefined();
    expect(stub.buildLookup).toBeUndefined();

    // The recommended call shape for user code:
    const builder = stub.buildAggregation?.();
    expect(builder).toBeUndefined();
  });
});
