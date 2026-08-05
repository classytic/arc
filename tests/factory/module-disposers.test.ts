/**
 * The module disposer contract — `defer` in setup phases, plus the returned-
 * disposer shorthand for `plugins` / `afterResources`.
 *
 * Pins the four guarantees the contract makes:
 *   1. LIFO — reverse registration, so nothing is released while something
 *      built on top of it is still alive.
 *   2. Exact partial-init teardown — only what was actually acquired runs,
 *      without the `?.` guards `onClose` requires.
 *   3. Both paths — mid-boot rollback AND normal shutdown.
 *   4. Exactly once — whichever path fires first drains the stack.
 *
 * Ordering rule pinned here: a module's `onClose` runs FIRST, then its
 * disposers unwind LIFO. `onClose` tears down what `bootstrap` RETURNED (the
 * last thing the module produced), so LIFO puts it at the front — an engine
 * must stop before the connection under it closes.
 */

import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import { createDisposerRegistry } from "../../src/factory/module/disposers.js";
import { defineModule, getModuleState } from "../../src/factory/module/index.js";

describe("module disposers — defer()", () => {
  it("runs deferred disposers LIFO on normal shutdown", async () => {
    const order: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "billing",
          bootstrap: async (_f, { defer }) => {
            defer(() => void order.push("first"));
            defer(() => void order.push("second"));
            defer(() => void order.push("third"));
            return { engine: "billing" };
          },
        }),
      ],
    });
    await app.close();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("releases ONLY what was acquired when bootstrap throws partway", async () => {
    const released: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "billing",
            bootstrap: async (_f, { defer }) => {
              defer(() => void released.push("client"));
              // The engine is never constructed, so its disposer is never
              // registered — no `?.` guard needed anywhere.
              throw new Error("engine refused to start");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "billing" bootstrap threw: engine refused to start/);
    expect(released).toEqual(["client"]);
  });

  it("runs disposers during mid-boot rollback, in reverse composition order across modules", async () => {
    const released: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "a",
            bootstrap: async (_f, { defer }) => {
              defer(() => void released.push("a"));
              return {};
            },
          }),
          defineModule({
            name: "b",
            bootstrap: async (_f, { defer }) => {
              defer(() => void released.push("b"));
              return {};
            },
          }),
          defineModule({
            name: "c",
            bootstrap: () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "c" bootstrap threw: boom/);
    expect(released).toEqual(["b", "a"]);
  });

  it("runs a module's onClose BEFORE its disposers (engine stops before its connection closes)", async () => {
    const order: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "billing",
          plugins: async (_f, { defer }) => {
            defer(() => void order.push("connection.close"));
          },
          bootstrap: async () => ({ engine: "billing" }),
          onClose: async () => void order.push("engine.stop"),
        }),
      ],
    });
    await app.close();
    expect(order).toEqual(["engine.stop", "connection.close"]);
  });

  it("runs each disposer exactly once when rollback is followed by close()", async () => {
    const released: string[] = [];
    let booted: Awaited<ReturnType<typeof createApp>> | undefined;
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "a",
            bootstrap: async (_f, { defer }) => {
              defer(() => void released.push("a"));
              return {};
            },
          }),
          defineModule({
            name: "b",
            afterResources: () => {
              throw new Error("wiring failed");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "b" afterResources\(\) threw: wiring failed/);
    expect(released).toEqual(["a"]);
    // A close() after a failed boot must not re-run a consumed disposer.
    await booted?.close();
    expect(released).toEqual(["a"]);
  });

  it("keeps going when a disposer throws, and reports it without throwing", async () => {
    const released: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "billing",
          bootstrap: async (_f, { defer }) => {
            defer(() => void released.push("outer"));
            defer(() => {
              throw new Error("disposer exploded");
            });
            defer(() => void released.push("inner"));
            return {};
          },
        }),
      ],
    });
    // Best-effort, then reported: the throwing disposer never blocks the ones
    // behind it, and the first error is rethrown after the sweep completes —
    // the same contract a throwing `onClose` already has.
    await expect(app.close()).rejects.toThrow(/deferred disposer #2 threw during teardown/);
    expect(released).toEqual(["inner", "outer"]);
  });

  it("marks the module `failed` when a disposer throws, `closed` when none do", async () => {
    const ok = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "clean",
          bootstrap: async (_f, { defer }) => {
            defer(() => {});
            return {};
          },
        }),
      ],
    });
    await ok.close();
    expect(getModuleState(ok, "clean")).toBe("closed");

    const bad = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "leaky",
          bootstrap: async (_f, { defer }) => {
            defer(() => {
              throw new Error("nope");
            });
            return {};
          },
        }),
      ],
    });
    await expect(bad.close()).rejects.toThrow(/deferred disposer #1 threw during teardown/);
    expect(getModuleState(bad, "leaky")).toBe("failed");
  });

  it("runs disposers for a module that declares no onClose at all", async () => {
    const released: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "no-closer",
          bootstrap: async (_f, { defer }) => {
            defer(() => void released.push("resource"));
            return {};
          },
        }),
      ],
    });
    await app.close();
    expect(released).toEqual(["resource"]);
  });

  it("rejects a non-function passed to defer()", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "bad",
            bootstrap: async (_f, ctx) => {
              (ctx as { defer: (d: unknown) => void }).defer("not a function");
              return {};
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "bad" called defer\(\) with a string — expected a function/);
  });
});

describe("module disposers — returned-disposer shorthand", () => {
  it("treats a disposer returned from plugins() as a final defer", async () => {
    const order: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "infra",
          plugins: async (_f, { defer }) => {
            defer(() => void order.push("deferred"));
            return () => void order.push("returned");
          },
        }),
      ],
    });
    await app.close();
    // The returned disposer registers last, so it unwinds first.
    expect(order).toEqual(["returned", "deferred"]);
  });

  it("treats a disposer returned from afterResources() as a defer", async () => {
    const order: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "wiring",
          afterResources: () => () => void order.push("unsubscribed"),
        }),
      ],
    });
    await app.close();
    expect(order).toEqual(["unsubscribed"]);
  });

  it("runs a plugins-phase disposer when a LATER module fails to boot", async () => {
    const released: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "infra",
            plugins: () => () => void released.push("infra"),
          }),
          defineModule({
            name: "late",
            bootstrap: () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "late" bootstrap threw: boom/);
    expect(released).toEqual(["infra"]);
  });
});

describe("module disposers — a defer that arrives AFTER teardown", () => {
  /**
   * The window: a setup phase leaves an un-awaited async tail running, boot
   * fails, rollback drains the module's stack — and then the tail finally
   * calls `defer`. Pushing onto a drained stack would leak silently, because
   * nothing will ever sweep it again.
   *
   * `createDisposerRegistry` runs such a disposer immediately instead. This is
   * best-effort by construction: the sweep is over, so nothing can await it,
   * which is why a throw here is logged rather than propagated.
   */
  it("runs it IMMEDIATELY rather than leaking it onto a drained stack", async () => {
    const registry = createDisposerRegistry({ log: { error: () => {} } } as never);
    const ctx = registry.contextFor("billing");

    let released = false;
    registry.take("billing"); // teardown sweeps the module
    ctx.defer(() => {
      released = true;
    });

    // Not queued for a sweep that already happened — invoked on the spot.
    await vi.waitFor(() => expect(released).toBe(true));
    // And it did NOT land on the stack, so a later sweep cannot double-run it.
    expect(registry.take("billing")).toHaveLength(0);
  });

  it("logs — never throws — when such a late disposer fails", async () => {
    const logged: unknown[] = [];
    const registry = createDisposerRegistry({
      log: { error: (...args: unknown[]) => void logged.push(args) },
    } as never);
    const ctx = registry.contextFor("billing");
    registry.take("billing");

    // Must not reject: there is no caller left to catch it, so a throw here
    // would surface as an unhandled rejection during a failed boot.
    expect(() =>
      ctx.defer(() => {
        throw new Error("close failed");
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(logged.length).toBe(1));
  });

  it("still stacks normally for a module that has NOT been drained", () => {
    const registry = createDisposerRegistry({ log: { error: () => {} } } as never);
    registry.take("billing"); // drains "billing" only

    const other = registry.contextFor("shipping");
    other.defer(() => {});

    // Drain state is per-module — a sibling's sweep must not divert it.
    expect(registry.take("shipping")).toHaveLength(1);
  });
});
