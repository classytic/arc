/**
 * Audit ↔ transaction session propagation.
 *
 * The `repository` audit store must write its row WITH the ambient Unit-of-Work
 * session so the audit entry commits/rolls back atomically with the domain
 * write that produced it (no unaudited successful write; no orphan audit for a
 * rolled-back write). This mirrors the outbox's `sessionProvider` integration.
 *
 * Rollback atomicity itself is a property of the kit honoring the write session
 * (mongokit does); it's exercised end-to-end in the mongodb-memory-server
 * replica-set suite. Here we prove the critical link: the session actually
 * reaches `repository.create()`.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import { repositoryAsAuditStore } from "../../src/audit/repository-audit-adapter.js";
import type { AuditEntry } from "../../src/audit/stores/interface.js";
import { transactionContext } from "../../src/context/transactionContext.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";

function fakeRepo() {
  const create = vi.fn(async (doc: unknown) => doc);
  return { repo: { idField: "_id", create } as never, create };
}

const entry: AuditEntry = {
  id: "a1",
  resource: "config",
  documentId: "logistics:company",
  action: "update",
  timestamp: new Date(),
};

describe("repository audit store — transaction session propagation", () => {
  it("passes the sessionProvider's session into repository.create()", async () => {
    const { repo, create } = fakeRepo();
    const session = { id: "sess-1" };
    const store = repositoryAsAuditStore(repo, { sessionProvider: () => session });

    await store.log(entry);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({ session });
  });

  it("writes session-less when no provider is configured (legacy behaviour)", async () => {
    const { repo, create } = fakeRepo();
    const store = repositoryAsAuditStore(repo);

    await store.log(entry);

    expect(create.mock.calls[0][1]).toBeUndefined();
  });

  it("writes session-less when the provider returns undefined (outside a transaction)", async () => {
    const { repo, create } = fakeRepo();
    const store = repositoryAsAuditStore(repo, { sessionProvider: () => undefined });

    await store.log(entry);

    expect(create.mock.calls[0][1]).toBeUndefined();
  });

  it("picks up arc's transactionContext session inside a run() scope, undefined outside", async () => {
    const { repo, create } = fakeRepo();
    const store = repositoryAsAuditStore(repo, {
      sessionProvider: () => transactionContext.get(),
    });
    const session = { id: "uow-1" };

    await transactionContext.run(session, async () => {
      await store.log(entry);
    });
    expect(create.mock.calls[0][1]).toEqual({ session });

    // Same store, now outside any transaction scope → session-less.
    await store.log(entry);
    expect(create.mock.calls[1][1]).toBeUndefined();
  });

  it("auditPlugin sessionProvider:false explicitly opts out of the ambient session", async () => {
    const { repo, create } = fakeRepo();
    const app = Fastify({ logger: false });
    await app.register(arcCorePlugin);
    await app.register(auditPlugin, {
      enabled: true,
      repository: repo,
      autoAudit: false,
      sessionProvider: false,
    });
    await app.ready();

    await transactionContext.run({ id: "ambient" }, async () => {
      await app.audit.custom("config", "logistics:company", "update");
    });

    expect(create.mock.calls[0][1]).toBeUndefined();
    await app.close();
  });
});
