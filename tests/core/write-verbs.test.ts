/**
 * WRITE VERBS — the pipeline must survive the seam.
 *
 * The seam exists because a resource used to have to choose between the
 * kernel's guard and arc's pipeline, and losing either was silent. So the
 * assertions here are mostly about what a declared verb still gets handed:
 * sanitized data, the tenant field, the actor stamp, and the hook sandwich
 * around it. A verb that receives the RAW body is the defect this closes, one
 * layer over.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import type { IRequestContext } from "../../src/types/index.js";
import type { ResourceWrites } from "../../src/types/resource/writes.js";
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
  };
}

/**
 * Mirrors the resource that produced the live defect: system-managed fields a
 * client must never write, enforced only by arc's `BodySanitizer`.
 */
const SYSTEM_MANAGED_SCHEMA = {
  fieldRules: {
    status: { systemManaged: true },
    number: { systemManaged: true },
    totalAmount: { systemManaged: true },
  },
};

describe("write verbs", () => {
  let repository: any;
  let hooks: HookSystem;

  beforeEach(() => {
    hooks = new HookSystem();
    /**
     * An EXPLICIT repository double rather than the shared fixture.
     *
     * Two reasons, both learned from this file failing for the wrong reason:
     * the shared mock answers `getById` with `null`, which 404s in
     * `loadMutableTarget` before the seam is ever reached; and its methods are
     * not all `vi.fn()`s, so "did the repository get called?" — the question
     * every test in the last block asks — could not be answered at all.
     */
    repository = {
      getById: vi.fn().mockResolvedValue({ _id: "inv-1", partnerName: "Acme", status: "draft" }),
      getAll: vi.fn().mockResolvedValue({ method: "offset", data: [], total: 0 }),
      create: vi.fn(async (data: Record<string, unknown>) => ({ _id: "inv-new", ...data })),
      update: vi.fn(async (_id: string, data: Record<string, unknown>) => ({
        _id: "inv-1",
        ...data,
      })),
      delete: vi.fn().mockResolvedValue({ success: true, message: "Deleted" }),
    };
  });

  describe("the verb replaces persistence, and only persistence", () => {
    it("hands the verb SANITIZED data — system-managed fields never reach it", async () => {
      const seen: Array<Record<string, unknown>> = [];
      const writes: ResourceWrites = {
        create: async (data) => {
          seen.push(data as Record<string, unknown>);
          return { _id: "inv-1", ...(data as object) } as never;
        },
      };
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        schemaOptions: SYSTEM_MANAGED_SCHEMA,
        onFieldWriteDenied: "strip",
        writes,
      });

      await controller.create(
        createReq(hooks, {
          body: {
            partnerName: "Acme",
            status: "posted",
            number: "INV-FORGED-0001",
            totalAmount: 1,
          },
        }),
      );

      expect(seen).toHaveLength(1);
      const data = seen[0] as Record<string, unknown>;
      // The legitimate field arrives…
      expect(data.partnerName).toBe("Acme");
      // …and every declared system-managed one was stripped BEFORE the verb.
      expect(data.status).toBeUndefined();
      expect(data.number).toBeUndefined();
      expect(data.totalAmount).toBeUndefined();
    });

    /**
     * The exact live regression: `PATCH` on a draft wrote `status: "posted"`
     * and a forged `number` because the override skipped the sanitizer.
     */
    it("update: the same protection holds (the regression this closes)", async () => {
      let received: Record<string, unknown> | undefined;
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        schemaOptions: SYSTEM_MANAGED_SCHEMA,
        onFieldWriteDenied: "strip",
        writes: {
          update: async (_id, data) => {
            received = data as Record<string, unknown>;
            return { _id: "inv-1", ...(data as object) } as never;
          },
        },
      });

      await controller.update(
        createReq(hooks, {
          params: { id: "inv-1" },
          body: { partnerName: "Edited", status: "posted", number: "INV-FORGED-0001" },
        }),
      );

      expect(received?.partnerName).toBe("Edited");
      expect(received?.status).toBeUndefined();
      expect(received?.number).toBeUndefined();
    });

    it("REFUSES before the verb runs when the policy rejects the write", async () => {
      const verb = vi.fn();
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        // `immutable` is the rule that routes through a denial POLICY;
        // `systemManaged` always strips silently (asserted above).
        schemaOptions: { fieldRules: { partnerId: { immutable: true } } },
        onImmutableWrite: "reject",
        writes: { update: verb as never },
      });

      await expect(
        controller.update(
          createReq(hooks, { params: { id: "inv-1" }, body: { partnerId: "other" } }),
        ),
      ).rejects.toThrow();
      // A refused request has no command — the verb must not run at all.
      expect(verb).not.toHaveBeenCalled();
    });

    it("stamps the actor and injects the tenant before the verb sees the data", async () => {
      let received: Record<string, unknown> | undefined;
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        tenantField: "organizationId",
        writes: {
          create: async (data) => {
            received = data as Record<string, unknown>;
            return { _id: "x" } as never;
          },
        },
      });

      await controller.create(
        createReq(hooks, {
          body: { partnerName: "Acme" },
          metadata: {
            arc: { hooks },
            _scope: { kind: "member", organizationId: "org-42", userId: mockUser._id },
          },
        } as Partial<IRequestContext>),
      );

      expect(received?.organizationId).toBe("org-42");
      expect(received?.createdBy).toBeTruthy();
    });

    it("runs the hook sandwich AROUND the verb", async () => {
      const order: string[] = [];
      hooks.register({
        resource: "invoice",
        operation: "create",
        phase: "before",
        handler: (ctx: any) => {
          order.push("before");
          return ctx.data;
        },
      });
      hooks.register({
        resource: "invoice",
        operation: "create",
        phase: "after",
        handler: (ctx: any) => {
          order.push("after");
          return ctx.data;
        },
      });

      const controller = new BaseController(repository, {
        resourceName: "invoice",
        writes: {
          create: async () => {
            order.push("verb");
            return { _id: "x" } as never;
          },
        },
      });

      await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));
      expect(order).toEqual(["before", "verb", "after"]);
    });
  });

  describe("return contract — a command throws, it does not return null", () => {
    /**
     * `deleteDraft()` returns `void`. Reading that as the repository's
     * "null means miss" would answer 404 for a delete that really happened.
     */
    it("delete: an undefined return is SUCCESS, not a 404", async () => {
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        writes: { delete: async () => undefined },
      });

      const res = await controller.delete(createReq(hooks, { params: { id: "inv-1" } }));
      expect(res.status).toBe(200);
    });

    it("update: a void-returning verb still answers with the document", async () => {
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        writes: { update: async () => undefined },
      });

      const res = await controller.update(
        createReq(hooks, { params: { id: "inv-1" }, body: { partnerName: "Edited" } }),
      );
      // Re-read through the repository rather than reporting a false miss.
      expect(res.status).toBe(200);
      expect(res.data).toBeTruthy();
    });

    it("a verb that throws surfaces its error — the guard is the point", async () => {
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        writes: {
          update: async () => {
            throw Object.assign(new Error("only a draft invoice can be updated"), {
              statusCode: 409,
            });
          },
        },
      });

      await expect(
        controller.update(createReq(hooks, { params: { id: "inv-1" }, body: { x: 1 } })),
      ).rejects.toThrow(/only a draft/);
    });

    /**
     * `create` is the one slot where a nullish return is a CONTRACT VIOLATION
     * rather than a convention difference: nothing exists to re-read, so the
     * alternative is a 201 carrying `undefined` and after-hooks (audit,
     * events, cache invalidation) fed a non-document. TypeScript types the
     * contract; this throw enforces it for JS hosts, where a missing `return`
     * is one keystroke away.
     */
    it("create: a nullish return THROWS a contract violation, not a hollow 201", async () => {
      const afterHook = vi.fn();
      hooks.register({
        resource: "invoice",
        operation: "create",
        phase: "after",
        // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape
        handler: (ctx: any) => {
          afterHook(ctx.data);
          return ctx.data;
        },
      });
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the contract
        writes: { create: (async () => undefined) as any },
      });

      await expect(
        controller.create(createReq(hooks, { body: { partnerName: "Hollow" } })),
      ).rejects.toThrow(/must return the created document/);
      // The violation is caught BEFORE after-hooks observe a non-document.
      expect(afterHook).not.toHaveBeenCalled();
    });
  });

  describe("no verb declared — the default is untouched", () => {
    it("falls through to the repository for every op", async () => {
      const controller = new BaseController(repository, { resourceName: "invoice" });

      // Assert on the mock repository's own `vi.fn()`s. `vi.spyOn` here would
      // WRAP the existing mock and drop its implementation, so `update` would
      // resolve `undefined` and the test would fail for a reason that has
      // nothing to do with the seam.
      await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));
      expect(repository.create).toHaveBeenCalledTimes(1);

      await controller.update(
        createReq(hooks, { params: { id: "inv-1" }, body: { partnerName: "Edited" } }),
      );
      expect(repository.update).toHaveBeenCalledTimes(1);
    });

    it("declaring ONE verb leaves the other slots on the repository", async () => {
      const createVerb = vi.fn(async () => ({ _id: "x" }) as never);
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        writes: { create: createVerb },
      });

      await controller.create(createReq(hooks, { body: { partnerName: "Acme" } }));
      await controller.update(
        createReq(hooks, { params: { id: "inv-1" }, body: { partnerName: "Edited" } }),
      );

      expect(createVerb).toHaveBeenCalledTimes(1);
      // create went to the verb, so the repository never saw it…
      expect(repository.create).not.toHaveBeenCalled();
      // …while the undeclared slot still lands on the repository.
      expect(repository.update).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * THE ID A VERB RECEIVES IS THE REPOSITORY'S PRIMARY KEY.
   *
   * repo-core types `update(id, …)` as "update by primary key", and mongokit
   * resolves that against `options.idField ?? this.idField`. A resource
   * declaring `idField: 'slug'` therefore routes on the slug while its
   * repository keys off `_id`, and arc translates between them
   * (`resolveMutationRepoId`) before calling either.
   *
   * A verb stands exactly where the repository call stood, so it must receive
   * the same value — handing it the raw route param gives a domain command an
   * id its own repository cannot resolve. Invisible on a default-id resource,
   * where the two are equal, which is why every other test here agrees.
   */
  describe("id translation — the verb gets what the repository would have", () => {
    const STORED = { _id: "mongo-oid-999", slug: "acme-invoice", status: "draft" };

    function slugRepo() {
      return {
        // A custom idField requires `getOne` — `getById` would query by `_id`.
        getOne: vi.fn().mockResolvedValue(STORED),
        getById: vi.fn().mockResolvedValue(STORED),
        getAll: vi.fn().mockResolvedValue({ method: "offset", data: [], total: 0 }),
        create: vi.fn(),
        update: vi.fn(async (_id: string, data: Record<string, unknown>) => ({
          ...STORED,
          ...data,
        })),
        delete: vi.fn().mockResolvedValue({ success: true, message: "Deleted" }),
        // biome-ignore lint/suspicious/noExplicitAny: repository double
      } as any;
    }

    it("update: verb receives the repo primary key, not the route slug", async () => {
      const repo = slugRepo();
      let seen: string | undefined;
      const controller = new BaseController(repo, {
        resourceName: "invoice",
        idField: "slug",
        writes: {
          update: async (id) => {
            seen = id;
            return STORED as never;
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: idField is a resource-level option
      } as any);

      await controller.update(
        createReq(hooks, { params: { id: "acme-invoice" }, body: { note: "x" } }),
      );

      expect(seen).toBe("mongo-oid-999");
      expect(seen).not.toBe("acme-invoice");
    });

    it("delete: same translation", async () => {
      const repo = slugRepo();
      let seen: string | undefined;
      const controller = new BaseController(repo, {
        resourceName: "invoice",
        idField: "slug",
        writes: {
          delete: async (id) => {
            seen = id;
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: idField is a resource-level option
      } as any);

      await controller.delete(createReq(hooks, { params: { id: "acme-invoice" } }));

      expect(seen).toBe("mongo-oid-999");
    });

    it("ctx.id matches the verb argument, and the route param stays reachable", async () => {
      const repo = slugRepo();
      let ctxId: string | undefined;
      let routeId: unknown;
      const controller = new BaseController(repo, {
        resourceName: "invoice",
        idField: "slug",
        writes: {
          update: async (_id, _data, ctx) => {
            ctxId = ctx.id;
            routeId = (ctx.req.params as Record<string, unknown>).id;
            return STORED as never;
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: idField is a resource-level option
      } as any);

      await controller.update(
        createReq(hooks, { params: { id: "acme-invoice" }, body: { note: "x" } }),
      );

      expect(ctxId).toBe("mongo-oid-999");
      expect(routeId).toBe("acme-invoice");
    });

    it("default idField: verb id is the route id, unchanged", async () => {
      let seen: string | undefined;
      const controller = new BaseController(repository, {
        resourceName: "invoice",
        writes: {
          update: async (id) => {
            seen = id;
            return { _id: "inv-1" } as never;
          },
        },
      });

      await controller.update(
        createReq(hooks, { params: { id: "inv-1" }, body: { partnerName: "Edited" } }),
      );

      expect(seen).toBe("inv-1");
    });
  });
});
