/**
 * Portability proof — SQL kit without a `createdAt` column.
 *
 * Arc's framework default sort is `-createdAt` (Mongo convention). A SQL
 * schema that doesn't declare that column would otherwise compile to
 * `ORDER BY "createdAt" DESC` against a missing column and 500. This
 * test asserts the explicit opt-out works:
 *
 *   `defineResource({ defaultSort: false })`
 *
 * If it passes, the "DB-agnostic framework" claim holds for arbitrary
 * SQL schemas — not just the ones that happen to carry the Mongo
 * convention columns.
 */

import { SqliteRepository } from "@classytic/sqlitekit/repository";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataAdapter } from "../../src/adapters/index.js";
import { allowPublic, defineResource } from "../../src/index.js";

// A deliberately minimal schema — no timestamps, no Mongo-shaped columns.
const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
});

type TagDoc = {
  id: string;
  label: string;
};

describe("Arc + sqlitekit — schema without `createdAt`", () => {
  let db: Database.Database;
  let repo: SqliteRepository<TagDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
    `);
    const drizzleDb = drizzle(db);
    repo = new SqliteRepository<TagDoc>({ db: drizzleDb, table: tags });

    const adapter: DataAdapter<TagDoc> = {
      repository: repo as unknown as DataAdapter<TagDoc>["repository"],
      type: "drizzle",
      name: "tags-drizzle",
    };

    const tagResource = defineResource<TagDoc>({
      name: "tag",
      idField: "id",
      adapter,
      // Opt out of `-createdAt` default — the column doesn't exist here.
      defaultSort: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const fastify = Fastify({ logger: { level: "error" } });
    await fastify.register(tagResource.toPlugin());
    return fastify;
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("lists rows without blowing up on a missing createdAt column", async () => {
    // Seed via POST so we also exercise the create path.
    await app.inject({
      method: "POST",
      url: "/tags",
      payload: { id: "t1", label: "hot" },
    });
    await app.inject({
      method: "POST",
      url: "/tags",
      payload: { id: "t2", label: "new" },
    });

    const res = await app.inject({ method: "GET", url: "/tags" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { docs: TagDoc[]; total: number };
    expect(body.total).toBe(2);
    expect(body.docs.map((d) => d.id).sort()).toEqual(["t1", "t2"]);
  });

  it("still honors an explicit sort when the request passes one", async () => {
    await app.inject({ method: "POST", url: "/tags", payload: { id: "a", label: "zebra" } });
    await app.inject({ method: "POST", url: "/tags", payload: { id: "b", label: "apple" } });

    const res = await app.inject({ method: "GET", url: "/tags?sort=label" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { docs: TagDoc[] };
    expect(body.docs.map((d) => d.label)).toEqual(["apple", "zebra"]);
  });
});
