/**
 * Boot gates that read the repository's CAPABILITY DESCRIPTOR, not just its
 * method table.
 *
 * Both gates existed as method-presence checks and both were bypassable by
 * the exact deployments their own error messages named:
 *
 *   1. `transactional: true` checked `typeof repo.withTransaction === 'function'`
 *      — but kits expose that method unconditionally and fail at BEGIN. A
 *      standalone-Mongo deployment booted clean and 500'd on the first write.
 *   2. A Better Auth overlay called itself "read-side" in a docstring while
 *      handing back a mutable repository, so `routes: ['create']` over
 *      `user` was one config line away from writing rows Better Auth never
 *      hashed or hooked.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

const PERMISSIONS = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

/** Wrap a repository the way a kit's adapter factory would. */
const adapterFor = (repository: unknown) =>
  ({ type: "custom", name: "mem", repository }) as unknown as DataAdapter<Record<string, unknown>>;

/** A kit-shaped repository: withTransaction ALWAYS exists, capabilities vary. */
function repoWithCapabilities(capabilities: Record<string, unknown> | undefined) {
  return {
    capabilities,
    async withTransaction(fn: (r: unknown) => Promise<unknown>) {
      return fn(this);
    },
    async getAll() {
      return { data: [], total: 0 };
    },
    async getById() {
      return null;
    },
    async create(d: unknown) {
      return d;
    },
    async update() {
      return null;
    },
    async delete() {
      return null;
    },
  };
}

describe("transactional: true — capability gate", () => {
  it("REFUSES at definition when there is no withTransaction at all", () => {
    // Knowable immediately — no connection required to see a missing method.
    const bare = { getAll: async () => [], getById: async () => null } as unknown;
    expect(() =>
      defineResource({
        name: "orders",
        permissions: PERMISSIONS,
        transactional: true,
        adapter: adapterFor(bare),
      }),
    ).toThrow(/no `withTransaction`/);
  });

  it("does NOT reject at DEFINITION time for an unresolved topology", async () => {
    // The lifecycle this protects: `defineResource()` runs at module import,
    // and `beforeBoot()` opens the connection later. Mongokit reports
    // `transactions: false` until it can observe the topology, so asserting
    // at define time would reject a correctly configured app for importing
    // its resources early.
    expect(() =>
      defineResource({
        name: "orders",
        permissions: PERMISSIONS,
        transactional: true,
        adapter: adapterFor(repoWithCapabilities({ transactions: false })),
      }),
    ).not.toThrow();
  });

  it("REFUSES at REGISTRATION when the capability is still not confirmed", async () => {
    const resource = defineResource({
      name: "orders",
      permissions: PERMISSIONS,
      transactional: true,
      adapter: adapterFor(repoWithCapabilities({ transactions: false })),
    });
    const app = Fastify({ logger: false });
    await expect(app.register(resource.toPlugin()).ready()).rejects.toThrow(
      /capabilities\.transactions: false/,
    );
    await app.close();
  });

  it("PASSES at registration once beforeBoot has connected — the descriptor flips", async () => {
    // Mirrors mongokit's live getter: false while disconnected, true after.
    let connected = false;
    const repo = repoWithCapabilities(undefined);
    Object.defineProperty(repo, "capabilities", {
      get: () => ({ transactions: connected }),
    });

    const resource = defineResource({
      name: "orders",
      permissions: PERMISSIONS,
      transactional: true,
      adapter: adapterFor(repo),
    });

    const app = Fastify({ logger: false });
    connected = true; // what beforeBoot() does
    await expect(app.register(resource.toPlugin()).ready()).resolves.toBeTruthy();
    await app.close();
  });

  it("a custom repository with NO descriptor passes both points", async () => {
    const resource = defineResource({
      name: "orders",
      permissions: PERMISSIONS,
      transactional: true,
      adapter: adapterFor(repoWithCapabilities(undefined)),
    });
    const app = Fastify({ logger: false });
    await expect(app.register(resource.toPlugin()).ready()).resolves.toBeTruthy();
    await app.close();
  });
});

describe("read-only repository — write-route gate", () => {
  const readOnlyRepo = () => repoWithCapabilities({ transactions: true, readOnly: true });

  it("REFUSES write routes over a repository another component owns", () => {
    expect(() =>
      defineResource({
        name: "user",
        permissions: PERMISSIONS,
        adapter: adapterFor(readOnlyRepo()),
      }),
    ).toThrow(/READ-ONLY repository/);
  });

  it("names the routes and the two ways out", () => {
    let message = "";
    try {
      defineResource({
        name: "user",
        permissions: PERMISSIONS,
        adapter: adapterFor(readOnlyRepo()),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/create, update, delete/);
    expect(message).toMatch(/disabledRoutes/);
    expect(message).toMatch(/unsafeWritable/);
  });

  it("ALLOWS a read-only resource — the overlay's actual purpose", () => {
    expect(() =>
      defineResource({
        name: "user",
        permissions: PERMISSIONS,
        adapter: adapterFor(readOnlyRepo()),
        disabledRoutes: ["create", "update", "delete"],
      }),
    ).not.toThrow();
  });

  it("ALLOWS it when default routes are off entirely", () => {
    expect(() =>
      defineResource({
        name: "user",
        permissions: PERMISSIONS,
        adapter: adapterFor(readOnlyRepo()),
        disableDefaultRoutes: true,
      }),
    ).not.toThrow();
  });

  it("leaves ordinary writable repositories completely alone", () => {
    expect(() =>
      defineResource({
        name: "orders",
        permissions: PERMISSIONS,
        adapter: adapterFor(repoWithCapabilities({ transactions: true })),
      }),
    ).not.toThrow();
  });
});
