/**
 * TestFixtures — unit tests for DB-agnostic record seeding + cleanup tracker.
 */

import { describe, expect, it, vi } from "vitest";
import { createTestFixtures } from "../../src/testing/fixtures.js";

describe("createTestFixtures", () => {
  it("register + create returns the factory-produced record and tracks it", async () => {
    const fixtures = createTestFixtures();
    const create = vi.fn(async (data) => ({ _id: "rec-1", ...data }));
    fixtures.register("widget", create);

    const widget = await fixtures.create("widget", { name: "Widget A" });
    expect(widget).toEqual({ _id: "rec-1", name: "Widget A" });
    expect(create).toHaveBeenCalledWith({ name: "Widget A" });
    expect(fixtures.all("widget")).toEqual([widget]);
  });

  it("createMany produces N records with a shared template", async () => {
    const fixtures = createTestFixtures();
    let counter = 0;
    fixtures.register("user", async (data) => ({ _id: `u${counter++}`, ...data }));

    const users = await fixtures.createMany("user", 3, { role: "member" });
    expect(users).toHaveLength(3);
    expect(users.every((u) => u.role === "member")).toBe(true);
    expect(users.map((u) => u._id)).toEqual(["u0", "u1", "u2"]);
  });

  it("createMany rejects negative counts", async () => {
    const fixtures = createTestFixtures();
    fixtures.register("x", async () => ({}));
    await expect(fixtures.createMany("x", -1)).rejects.toThrow(/count must be >= 0/);
  });

  it("create throws a helpful error when the factory is unregistered", async () => {
    const fixtures = createTestFixtures();
    await expect(fixtures.create("ghost")).rejects.toThrow(/unknown factory.*Registered.*none/);

    fixtures.register("user", async () => ({}));
    await expect(fixtures.create("ghost")).rejects.toThrow(/Registered.*user/);
  });

  it("register accepts either a bare factory or a { create, destroy } registration", async () => {
    const fixtures = createTestFixtures();
    const destroy = vi.fn(async () => {});
    fixtures.register("tracked", {
      create: async (data) => ({ _id: "t1", ...data }),
      destroy,
    });

    await fixtures.create("tracked", { label: "a" });
    await fixtures.create("tracked", { label: "b" });

    await fixtures.clear();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("clear is idempotent and forgets tracked records", async () => {
    const fixtures = createTestFixtures();
    const destroy = vi.fn(async () => {});
    fixtures.register("user", { create: async () => ({ _id: "u1" }), destroy });

    await fixtures.create("user");
    await fixtures.clear();
    await fixtures.clear(); // second call — no-op

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(fixtures.all("user")).toEqual([]);
  });

  it("clear swallows destroyer errors (test teardown shouldn't abort on cleanup flakiness)", async () => {
    const fixtures = createTestFixtures();
    fixtures.register("flaky", {
      create: async () => ({ _id: "f1" }),
      destroy: async () => {
        throw new Error("transient");
      },
    });

    await fixtures.create("flaky");
    await expect(fixtures.clear()).resolves.toBeUndefined();
  });

  it("names reflects registered keys in insertion order", () => {
    const fixtures = createTestFixtures();
    fixtures.register("a", async () => ({}));
    fixtures.register("b", async () => ({}));
    expect(fixtures.names).toEqual(["a", "b"]);
  });

  it("re-registering a name replaces the earlier factory", async () => {
    const fixtures = createTestFixtures();
    fixtures.register("user", async () => ({ version: 1 }));
    fixtures.register("user", async () => ({ version: 2 }));
    const u = await fixtures.create("user");
    expect(u).toEqual({ version: 2 });
  });

  it("destroyer is bound at create time — re-registering with a different destroyer does NOT retarget existing records", async () => {
    // Regression: earlier impl stored `name → records[]` and looked up the
    // destroyer at clear() time, so a test that re-registered "user" after
    // inserting records would have its first-batch records routed through
    // the new destroyer. That's wrong — a destroyer paired with a factory
    // owns the records that factory produced.
    const fixtures = createTestFixtures();

    const firstDestroy = vi.fn(async () => {});
    const secondDestroy = vi.fn(async () => {});

    fixtures.register("user", {
      create: async () => ({ _id: "u1", version: 1 }),
      destroy: firstDestroy,
    });
    await fixtures.create("user"); // tracked with firstDestroy

    fixtures.register("user", {
      create: async () => ({ _id: "u2", version: 2 }),
      destroy: secondDestroy,
    });
    await fixtures.create("user"); // tracked with secondDestroy

    await fixtures.clear();

    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(firstDestroy).toHaveBeenCalledWith({ _id: "u1", version: 1 });
    expect(secondDestroy).toHaveBeenCalledTimes(1);
    expect(secondDestroy).toHaveBeenCalledWith({ _id: "u2", version: 2 });
  });

  it("clear destroys records in reverse-creation order (so referential dependencies tear down cleanly)", async () => {
    const fixtures = createTestFixtures();
    const order: string[] = [];
    fixtures.register("org", {
      create: async () => ({ _id: "o1", kind: "org" }),
      destroy: async (r) => {
        order.push(String(r.kind));
      },
    });
    fixtures.register("user", {
      create: async () => ({ _id: "u1", kind: "user" }),
      destroy: async (r) => {
        order.push(String(r.kind));
      },
    });

    await fixtures.create("org");
    await fixtures.create("user");
    await fixtures.clear();

    // user created last → destroyed first
    expect(order).toEqual(["user", "org"]);
  });
});
