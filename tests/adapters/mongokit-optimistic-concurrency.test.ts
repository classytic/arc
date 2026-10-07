/**
 * `concurrency` on a resource: ETag on reads, If-Match on updates (412 on a stale tag), and
 * EVERY update a CAS on the version it loaded — so a write between load and persist is a 409,
 * never a silent overwrite, and the version (and the ETag) moves on every write.
 */
import { Repository } from "@classytic/mongokit";
import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection, Schema, type Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/index.js";
import { allowPublic, defineResource } from "../../src/index.js";

interface NoteDoc {
  _id: Types.ObjectId;
  title: string;
  __v?: number;
}

describe("optimistic concurrency — ETag / If-Match over mongokit CAS", () => {
  let mongoServer: MongoMemoryServer;
  let connection: Connection;
  let Note: mongoose.Model<NoteDoc>;
  let repo: Repository<NoteDoc>;
  let app: FastifyInstance;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongoServer.getUri("occ"));
    await connection.asPromise();
    Note = connection.model<NoteDoc>(
      "OccNote",
      new Schema<NoteDoc>({ title: { type: String, required: true } }),
    );
    repo = new Repository<NoteDoc>(Note);
    const adapter: DataAdapter<NoteDoc> = {
      repository: repo as unknown as DataAdapter<NoteDoc>["repository"],
      type: "mongoose",
      name: "notes",
    };
    const resource = defineResource<NoteDoc>({
      name: "note",
      adapter,
      concurrency: {},
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
    app = await createApp({ auth: false, logger: false, resources: [resource] });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await connection?.close();
    await mongoServer?.stop();
  }, 30_000);

  let id: string;
  beforeEach(async () => {
    await Note.deleteMany({});
    id = String((await Note.create({ title: "first" }))._id);
  });

  const read = () => app.inject({ method: "GET", url: `/notes/${id}` });
  const patch = (title: string, ifMatch?: string) =>
    app.inject({
      method: "PATCH",
      url: `/notes/${id}`,
      payload: { title },
      ...(ifMatch ? { headers: { "if-match": ifMatch } } : {}),
    });

  it("a read carries the version as a strong ETag", async () => {
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"0"');
  });

  it("If-Match with the current ETag applies, and the ETag moves", async () => {
    const res = await patch("second", '"0"');
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect((await read()).headers.etag).toBe('"1"');
  });

  it("a stale If-Match is 412 and writes nothing", async () => {
    await patch("second");
    const res = await patch("stale", '"0"');
    expect(res.statusCode).toBe(412);
    expect((await Note.findById(id).lean())?.title).toBe("second");
  });

  it("an update without If-Match still bumps the version — the ETag never lies", async () => {
    await patch("second");
    expect((await read()).headers.etag).toBe('"1"');
  });

  it("a write landing between arc's load and its write is a 409, not an overwrite", async () => {
    // Simulate the race: bump the stored version after arc has loaded it.
    const original = repo.update.bind(repo);
    let raced = false;
    (repo as { update: typeof repo.update }).update = async (...args) => {
      if (!raced) {
        raced = true;
        await Note.updateOne({ _id: id }, { $set: { title: "concurrent" }, $inc: { __v: 1 } });
      }
      return original(...args);
    };
    try {
      const res = await patch("mine");
      expect(res.statusCode).toBe(409);
      expect((await Note.findById(id).lean())?.title).toBe("concurrent");
    } finally {
      (repo as { update: typeof repo.update }).update = original;
    }
  });
});

describe("optimistic concurrency — refused where it cannot be enforced", () => {
  it("boot fails on a repository without the optimisticConcurrency capability", async () => {
    const repository = {
      capabilities: { optimisticConcurrency: false },
      getAll: async () => [],
      getById: async () => null,
      create: async () => ({}),
      update: async () => null,
      delete: async () => ({ success: true }),
    };
    const resource = defineResource({
      name: "ledgerline",
      adapter: { repository, type: "custom", name: "no-cas" } as never,
      concurrency: {},
      permissions: { list: allowPublic(), get: allowPublic() },
      disabledRoutes: ["create", "update", "delete"],
    });
    await expect(
      createApp({ auth: false, logger: false, resources: [resource] }).then((a) => a.ready()),
    ).rejects.toThrow(/optimisticConcurrency/);
  });
});
