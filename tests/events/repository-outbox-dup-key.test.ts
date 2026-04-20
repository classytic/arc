/**
 * Regression: the repository → outbox adapter must only treat genuine
 * duplicate-key errors (code 11000 / codeName "DuplicateKey") as idempotent
 * saves. A prior version also matched `name === "MongoServerError"`, which
 * silently swallowed WriteConflict and other transient Mongo errors and lost
 * the event.
 */

import { describe, expect, it } from "vitest";

import type { RepositoryLike } from "../../src/adapters/interface.js";

async function getOutbox() {
  const { EventOutbox } = await import("../../src/events/outbox.js");
  return EventOutbox;
}

function makeRepository(
  createImpl: (doc: unknown) => Promise<unknown>,
  isDuplicateKeyError?: (err: unknown) => boolean,
): RepositoryLike {
  return {
    create: createImpl,
    getOne: async () => null,
    // 2.10.2 switched from findAll → getAll for bounded reads (mongokit's
    // findAll has no skip/limit). Return a pagination envelope so the adapter
    // unwraps .docs correctly.
    getAll: async () => ({ docs: [], total: 0, page: 1, limit: 0, pages: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    findOneAndUpdate: async () => null,
    ...(isDuplicateKeyError ? { isDuplicateKeyError } : {}),
  } as unknown as RepositoryLike;
}

describe("repositoryAsOutboxStore — dup-key handling", () => {
  it("swallows E11000 as an idempotent save (code 11000)", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(async () => {
      const err = Object.assign(new Error("E11000 duplicate key"), {
        name: "MongoServerError",
        code: 11000,
      });
      throw err;
    });

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-dup-1", timestamp: new Date() },
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows DuplicateKey codeName as an idempotent save", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(async () => {
      const err = Object.assign(new Error("duplicate key"), {
        name: "MongoServerError",
        codeName: "DuplicateKey",
      });
      throw err;
    });

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-dup-2", timestamp: new Date() },
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates WriteConflict (MongoServerError, code 112) — NOT a dup-key", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(async () => {
      const err = Object.assign(new Error("WriteConflict"), {
        name: "MongoServerError",
        code: 112,
        codeName: "WriteConflict",
      });
      throw err;
    });

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-conflict", timestamp: new Date() },
      }),
    ).rejects.toThrow(/WriteConflict/);
  });

  it("propagates NotWritablePrimary (MongoServerError, code 10107) — NOT a dup-key", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(async () => {
      const err = Object.assign(new Error("not primary"), {
        name: "MongoServerError",
        code: 10107,
        codeName: "NotWritablePrimary",
      });
      throw err;
    });

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-notprimary", timestamp: new Date() },
      }),
    ).rejects.toThrow(/not primary/);
  });

  it("uses repository.isDuplicateKeyError when provided (Prisma P2002)", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(
      async () => {
        const err = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        throw err;
      },
      (err) => (err as { code?: string }).code === "P2002",
    );

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-prisma-dup", timestamp: new Date() },
      }),
    ).resolves.toBeUndefined();
  });

  it("kit predicate overrides the Mongo fallback — non-11000 errors can be dup-keys", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(
      async () => {
        // Postgres-style error the default would not match
        const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
        throw err;
      },
      (err) => (err as { code?: string }).code === "23505",
    );

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-pg-dup", timestamp: new Date() },
      }),
    ).resolves.toBeUndefined();
  });

  it("kit predicate returning false suppresses the Mongo fallback — 11000 propagates", async () => {
    const EventOutbox = await getOutbox();
    const repository = makeRepository(
      async () => {
        const err = Object.assign(new Error("E11000 duplicate key"), {
          name: "MongoServerError",
          code: 11000,
        });
        throw err;
      },
      () => false, // kit says "not a dup-key" — must win over default
    );

    const outbox = new EventOutbox({ repository });
    await expect(
      outbox.store({
        type: "order.created",
        payload: {},
        meta: { id: "evt-override-false", timestamp: new Date() },
      }),
    ).rejects.toThrow(/E11000/);
  });
});
