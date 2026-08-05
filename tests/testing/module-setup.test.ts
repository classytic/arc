/**
 * `createTestModuleSetup` — the context a test passes to a module's phases when
 * it invokes them directly instead of booting an app.
 *
 * The point of the helper is that the obvious alternative, `{ defer: () => {} }`,
 * type-checks and discards everything, so these cases assert the behaviours that
 * literal cannot provide: the disposers are OBSERVABLE and they actually RUN.
 */

import { describe, expect, it } from "vitest";
import { createTestModuleSetup } from "../../src/testing/moduleSetup.js";

describe("createTestModuleSetup", () => {
  it("collects what a phase defers, so a test can assert teardown was registered", () => {
    const setup = createTestModuleSetup();
    setup.context.defer(() => {});
    setup.context.defer(() => {});

    // The assertion a no-op `defer` can never fail.
    expect(setup.deferred).toHaveLength(2);
  });

  it("runs disposers LIFO, matching arc's own teardown order", async () => {
    const setup = createTestModuleSetup();
    const order: string[] = [];
    setup.context.defer(() => void order.push("connection"));
    setup.context.defer(() => void order.push("subscription"));

    await setup.dispose();

    // Last acquired, first released — nothing is torn down while something
    // built on top of it is still alive.
    expect(order).toEqual(["subscription", "connection"]);
  });

  it("awaits async disposers", async () => {
    const setup = createTestModuleSetup();
    let closed = false;
    setup.context.defer(async () => {
      await Promise.resolve();
      closed = true;
    });

    await setup.dispose();

    expect(closed).toBe(true);
  });

  it("keeps going when one disposer throws, then reports it", async () => {
    const setup = createTestModuleSetup();
    let reached = false;
    setup.context.defer(() => void (reached = true));
    setup.context.defer(() => {
      throw new Error("boom");
    });

    // The failure surfaces — it must not vanish into a floating promise — but
    // the disposer behind it still ran.
    await expect(setup.dispose()).rejects.toThrow("boom");
    expect(reached).toBe(true);
  });

  it("aggregates when several throw", async () => {
    const setup = createTestModuleSetup();
    setup.context.defer(() => {
      throw new Error("first");
    });
    setup.context.defer(() => {
      throw new Error("second");
    });

    await expect(setup.dispose()).rejects.toThrow(/2 disposers threw/);
  });

  it("is empty after dispose, so a second call is a no-op", async () => {
    const setup = createTestModuleSetup();
    let runs = 0;
    setup.context.defer(() => void (runs += 1));

    await setup.dispose();
    await setup.dispose();

    expect(runs).toBe(1);
    expect(setup.deferred).toHaveLength(0);
  });

  it("rejects a non-function, same as the real registry", () => {
    const setup = createTestModuleSetup();
    expect(() => setup.context.defer(undefined as never)).toThrow(/expected a function/);
  });
});
