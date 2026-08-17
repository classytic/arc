/**
 * TRANSACTIONAL WRITE ENVELOPE — `defineResource({ transactional: true })`.
 *
 * Pinned contract (Phase 1c of the transactional core):
 *   1. The PERSISTENCE step (repository call OR declared verb) runs inside
 *      `withTransaction`, receives the TX-BOUND repository, and re-runs on
 *      kit-classified TRANSIENT conflicts only.
 *   2. Hooks stay OUTSIDE the retry: before-hooks run ONCE (their side
 *      effects must not repeat), after-hooks run ONCE, post-commit.
 *   3. `VersionConflictError` is NOT transient — it surfaces, no retry.
 *   4. `transactional: true` on a repository without `withTransaction` is
 *      BOOT-fatal at registration, not a first-request surprise.
 *   5. Untouched default: without the flag, no transaction is started.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import { VersionConflictError } from "@classytic/repo-core/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import { allowPublic } from "../../src/permissions/core.js";
import type { IRequestContext } from "../../src/types/index.js";
import { mockUser, setupGlobalHooks } from "../setup.js";

setupGlobalHooks();

function createReq(hooks: HookSystem, overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    query: {},
    body: {},
    params: {},
    user: mockUser,
    headers: {},
    metadata: { arc: { hooks } },
    ...overrides,
  } as IRequestContext;
}

const transientErr = () =>
  Object.assign(new Error("write conflict"), { errorLabels: ["TransientTransactionError"] });

/**
 * Repo double with a REAL withTransaction shape: hands the callback a
 * distinct tx-bound repo object, so tests can assert which one the
 * persistence step actually used.
 */
function txCapableRepo() {
  const txRepo = {
    __tx: true,
    getById: vi.fn().mockResolvedValue({ _id: "inv-1", status: "draft" }),
    create: vi.fn(async (d: Record<string, unknown>) => ({ _id: "inv-new", ...d })),
    update: vi.fn(async (_id: string, d: Record<string, unknown>) => ({ _id: "inv-1", ...d })),
    delete: vi.fn().mockResolvedValue({ success: true }),
    // biome-ignore lint/suspicious/noExplicitAny: test double
  } as any;
  const repo = {
    getById: vi.fn().mockResolvedValue({ _id: "inv-1", status: "draft" }),
    getAll: vi.fn().mockResolvedValue({ method: "offset", data: [], total: 0 }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    isTransientConflictError: (err: unknown) =>
      Boolean(
        err &&
          typeof err === "object" &&
          Array.isArray((err as { errorLabels?: unknown }).errorLabels) &&
          ((err as { errorLabels: unknown[] }).errorLabels as string[]).includes(
            "TransientTransactionError",
          ),
      ),
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepo)),
    // This double runs the callback ONCE per withTransaction call, so
    // `'caller'` is its honest declaration — the envelope owns the retry
    // loop. A kit whose driver retries internally (mongokit) declares
    // `'managed'` and is invoked exactly once; declaring the wrong one here
    // would test a composition that ships nowhere.
    capabilities: { transactions: true, transactionRetry: "caller" },
    // biome-ignore lint/suspicious/noExplicitAny: test double
  } as any;
  return { repo, txRepo };
}

describe("transactional write envelope", () => {
  let hooks: HookSystem;
  beforeEach(() => {
    hooks = new HookSystem();
  });

  it("persistence uses the TX-BOUND repository, not the live one", async () => {
    const { repo, txRepo } = txCapableRepo();
    const controller = new BaseController(repo, {
      resourceName: "invoice",
      transactional: true,
    });

    await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));

    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(txRepo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("a declared VERB receives the tx-bound repository AND the TransactionHandle in ctx", async () => {
    const { repo, txRepo } = txCapableRepo();
    // Kit contract (repo-core 0.23): withTransaction hands (txRepo, { session }).
    repo.withTransaction.mockImplementation(
      async (fn: (tx: unknown, uow?: unknown) => Promise<unknown>) =>
        fn(txRepo, { session: "driver-session" }),
    );
    let seenRepo: unknown;
    let seenUow: unknown;
    const controller = new BaseController(repo, {
      resourceName: "invoice",
      transactional: true,
      writes: {
        create: async (_data, ctx) => {
          seenRepo = ctx.repository;
          seenUow = ctx.uow;
          return { _id: "x" } as never;
        },
      },
    });

    await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));
    expect(seenRepo).toBe(txRepo);
    // The outbox join point: outbox.store(event, { session: ctx.uow.session }).
    expect(seenUow).toEqual({ session: "driver-session" });
  });

  it("WITHOUT the flag, ctx.uow is absent — no phantom transaction implied", async () => {
    const { repo } = txCapableRepo();
    let seenUow: unknown = "sentinel";
    const controller = new BaseController(repo, {
      resourceName: "invoice",
      writes: {
        create: async (_data, ctx) => {
          seenUow = ctx.uow;
          return { _id: "x" } as never;
        },
      },
    });
    await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));
    expect(seenUow).toBeUndefined();
  });

  it("a TRANSIENT conflict re-runs persistence; before-hook and after-hook run ONCE", async () => {
    const { repo, txRepo } = txCapableRepo();
    let attempts = 0;
    txRepo.create.mockImplementation(async (d: Record<string, unknown>) => {
      attempts++;
      if (attempts === 1) throw transientErr();
      return { _id: "inv-new", ...d };
    });

    const order: string[] = [];
    hooks.register({
      resource: "invoice",
      operation: "create",
      phase: "before",
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape
      handler: (ctx: any) => {
        order.push("before");
        return ctx.data;
      },
    });
    hooks.register({
      resource: "invoice",
      operation: "create",
      phase: "after",
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape
      handler: (ctx: any) => {
        order.push("after");
        return ctx.data;
      },
    });

    const controller = new BaseController(repo, {
      resourceName: "invoice",
      transactional: true,
    });
    const res = await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));

    expect(res.status).toBe(201);
    expect(attempts).toBe(2); // persistence re-ran
    expect(order).toEqual(["before", "after"]); // hooks did NOT
    expect(repo.withTransaction).toHaveBeenCalledTimes(2); // one tx per attempt
  });

  it("VersionConflictError surfaces WITHOUT retry — CAS losers must re-read, not re-run", async () => {
    const { repo, txRepo } = txCapableRepo();
    txRepo.update.mockRejectedValue(new VersionConflictError({ expectedVersion: 3, id: "inv-1" }));

    const controller = new BaseController(repo, {
      resourceName: "invoice",
      transactional: true,
    });

    await expect(
      controller.update(createReq(hooks, { params: { id: "inv-1" }, body: { n: 1 } })),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(txRepo.update).toHaveBeenCalledTimes(1);
  });

  it("WITHOUT the flag nothing changes: live repo, no transaction", async () => {
    const { repo, txRepo } = txCapableRepo();
    repo.create.mockResolvedValue({ _id: "inv-new" });
    const controller = new BaseController(repo, { resourceName: "invoice" });

    await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));

    expect(repo.withTransaction).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(txRepo.create).not.toHaveBeenCalled();
  });
});

describe("retry ownership — arc must not stack a second policy", () => {
  /**
   * The mongokit shape: `session.withTransaction()` re-runs the callback
   * INTERNALLY on TransientTransactionError for up to 120s. Arc wrapping that
   * in `retryingTransaction` created nested retry authority — the callback's
   * execution count stopped being bounded by maxAttempts, `onRetry` saw a
   * fraction of the real attempts, and every outer attempt opened a NEW
   * session. Retry ownership is declared by the kit, and arc honours it.
   */
  function managedRepo(internalAttempts: number) {
    const txRepo = {
      __tx: true,
      getById: vi.fn().mockResolvedValue({ _id: "inv-1", status: "draft" }),
      create: vi.fn(async () => {
        throw Object.assign(new Error("write conflict"), {
          errorLabels: ["TransientTransactionError"],
        });
      }),
      update: vi.fn(),
      delete: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any;
    const repo = {
      getById: vi.fn().mockResolvedValue({ _id: "inv-1", status: "draft" }),
      getAll: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      capabilities: { transactions: true, transactionRetry: "managed" },
      isTransientConflictError: () => true,
      withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        let lastErr: unknown;
        for (let i = 0; i < internalAttempts; i++) {
          try {
            return await fn(txRepo);
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
      }),
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any;
    return { repo, txRepo };
  }

  it("calls withTransaction ONCE for a self-retrying kit — the kit's attempts, not arc's × the kit's", async () => {
    const hooks = new HookSystem();
    const { repo, txRepo } = managedRepo(3);
    const controller = new BaseController(repo, { resourceName: "invoice", transactional: true });

    await expect(
      controller.create(createReq(hooks, { body: { partnerName: "Acme" } })),
    ).rejects.toThrow(/write conflict/);

    // The kit ran its own 3 attempts. Arc opened ONE transaction, not 5.
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(txRepo.create).toHaveBeenCalledTimes(3);
  });
});

describe("transactional: true at registration", () => {
  const PERMISSIONS = {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  };

  it("BOOT-fatal when the repository has no withTransaction", () => {
    const bare = {
      getById: async () => null,
      getAll: async () => [],
      create: async (d: unknown) => d,
      update: async () => null,
      delete: async () => false,
    };
    const adapter = { type: "custom", name: "mem", repository: bare } as unknown as DataAdapter<
      Record<string, unknown>
    >;
    expect(() =>
      defineResource({
        name: "invoice",
        adapter,
        permissions: PERMISSIONS,
        transactional: true,
      }),
    ).toThrow(/withTransaction/);
  });

  it("registers when the repository is transactional", () => {
    const { repo } = txCapableRepo();
    const adapter = { type: "custom", name: "mem", repository: repo } as unknown as DataAdapter<
      Record<string, unknown>
    >;
    expect(() =>
      defineResource({
        name: "invoice",
        adapter,
        permissions: PERMISSIONS,
        transactional: true,
      }),
    ).not.toThrow();
  });
});
