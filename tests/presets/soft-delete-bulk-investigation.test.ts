/**
 * Investigation: soft-delete + bulkDelete via BaseController
 *
 * Goal: figure out whether this is a MongoKit bug, a plugin-order issue,
 * or a BaseController issue. We'll exercise the same code path in two ways:
 *
 *   A) Direct MongoKit Repository.deleteMany — bypassing BaseController
 *   B) Via BaseController.bulkDelete with the same args
 *
 * If A works and B doesn't, the bug is in BaseController.
 * If both fail the same way, the bug is in MongoKit (or our plugin order).
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  Repository,
  softDeletePlugin,
} from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

interface IItem {
  name: string;
  status: string;
  deletedAt?: Date | null;
}

const ItemSchema = new Schema<IItem>(
  {
    name: { type: String, required: true },
    status: { type: String, required: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.SDInvest || mongoose.model<IItem>("SDInvest", ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ItemModel.deleteMany({});
});

describe("Soft-delete + bulkDelete root cause investigation", () => {
  it("A) Direct MongoKit Repository.deleteMany WITH softDeletePlugin", async () => {
    const repo = new Repository<IItem>(ItemModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" }),
    ]);

    await ItemModel.create([
      { name: "A1", status: "draft" },
      { name: "A2", status: "draft" },
      { name: "A3", status: "active" },
    ]);

    // biome-ignore lint: dynamic
    const repoDeleteMany = (repo as any).deleteMany;
    expect(typeof repoDeleteMany).toBe("function");

    const result = await repoDeleteMany.call(repo, { status: "draft" });
    console.log("DIRECT repo.deleteMany result:", JSON.stringify(result));

    const allDocs = await ItemModel.find({}).lean();
    const softDeleted = allDocs.filter((d) => d.deletedAt !== null);
    console.log(
      "After deleteMany — total data:",
      allDocs.length,
      "soft-deleted:",
      softDeleted.length,
    );

    // Soft-delete should mark deletedAt on the 2 draft items
    expect(allDocs.length).toBe(3); // all still in DB (soft-delete preserves)
    expect(softDeleted.length).toBe(2);
  });

  it("B) BaseController.bulkDelete WITH softDeletePlugin", async () => {
    const repo = new Repository<IItem>(ItemModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" }),
    ]);
    const controller = new BaseController(repo, {
      resourceName: "item",
      tenantField: false, // disable org-scope so the test isolates the soft-delete bug
    });
    const hooks = new HookSystem();

    await ItemModel.create([
      { name: "B1", status: "draft" },
      { name: "B2", status: "draft" },
      { name: "B3", status: "active" },
    ]);

    const result = await controller.bulkDelete({
      params: {},
      query: {},
      body: { filter: { status: "draft" } },
      headers: {},
      // biome-ignore lint: minimal request shape
      metadata: { arc: { hooks } } as any,
      // biome-ignore lint: minimal request shape
      user: undefined as any,
    });
    console.log("BaseController.bulkDelete result:", JSON.stringify(result));

    const allDocs = await ItemModel.find({}).lean();
    const softDeleted = allDocs.filter((d) => d.deletedAt !== null);
    console.log(
      "After bulkDelete — total data:",
      allDocs.length,
      "soft-deleted:",
      softDeleted.length,
    );

    expect(allDocs.length).toBe(3);
    expect(softDeleted.length).toBe(2);
  });

  it("C) BaseController.bulkDelete with multi-tenant filter merge + soft-delete", async () => {
    // Reproduces the original failing scenario: multi-tenant + soft-delete + bulk
    interface IItemMT extends IItem {
      organizationId: string;
    }
    const ItemMTSchema = new Schema<IItemMT>(
      {
        name: { type: String, required: true },
        status: { type: String, required: true },
        organizationId: { type: String, required: true, index: true },
        deletedAt: { type: Date, default: null, index: true },
      },
      { timestamps: true },
    );
    const ItemMTModel =
      mongoose.models.SDInvestMT || mongoose.model<IItemMT>("SDInvestMT", ItemMTSchema);
    await ItemMTModel.deleteMany({});

    const repo = new Repository<IItemMT>(ItemMTModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" }),
    ]);
    const controller = new BaseController(repo, {
      resourceName: "item",
      // tenantField defaults to 'organizationId'
    });
    const hooks = new HookSystem();

    await ItemMTModel.create([
      { name: "A1", status: "draft", organizationId: "org-a" },
      { name: "A2", status: "draft", organizationId: "org-a" },
      { name: "B1", status: "draft", organizationId: "org-b" },
    ]);

    // Org A user bulk-deletes by status
    const result = await controller.bulkDelete({
      params: {},
      query: {},
      body: { filter: { status: "draft" } },
      headers: {},
      // biome-ignore lint: minimal
      metadata: {
        arc: { hooks },
        _scope: { kind: "member", organizationId: "org-a", orgRoles: [] },
        // biome-ignore lint: minimal
      } as any,
      // biome-ignore lint: minimal
      user: undefined as any,
    });
    console.log("Multi-tenant bulkDelete result:", JSON.stringify(result));

    const orgA = await ItemMTModel.find({ organizationId: "org-a" }).lean();
    const orgB = await ItemMTModel.find({ organizationId: "org-b" }).lean();
    const orgASoftDeleted = orgA.filter((d) => d.deletedAt !== null);
    const orgBSoftDeleted = orgB.filter((d) => d.deletedAt !== null);

    console.log(
      "Org A data:",
      orgA.length,
      "soft-deleted:",
      orgASoftDeleted.length,
      "| Org B data:",
      orgB.length,
      "soft-deleted:",
      orgBSoftDeleted.length,
    );

    // Org A's 2 draft items should be soft-deleted (deletedAt set)
    expect(orgASoftDeleted.length).toBe(2);
    // Org B's draft item must NOT be touched (security)
    expect(orgBSoftDeleted.length).toBe(0);

    await ItemMTModel.deleteMany({});
  });
});
