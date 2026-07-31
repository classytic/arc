/**
 * Transactional module boot — partial-boot rollback + lifecycle states.
 *
 * Pins the contract added for the "partial boot failure does not reliably run
 * module cleanup" gap: the combined onClose hook registers at the END of
 * registerResources, so any failure between a module's bootstrap and that
 * point used to leak the module's clients/timers/engines. Now arc tracks
 * which modules completed an init phase and, on ANY later boot failure,
 * closes them immediately in reverse composition order — best-effort, each
 * closer at most once, original boot error preserved.
 *
 * Also pins the introspection model (`hasModule` / `getModuleState`) and the
 * eager graph-presence validation in `lazyRequiredModuleExports`.
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import { createApp } from "../../src/factory/createApp.js";
import {
  defineModule,
  getModuleState,
  hasModule,
  hasModuleExports,
  lazyRequiredModuleExports,
} from "../../src/factory/module/index.js";

/** A module whose closer records into `closed` (and can optionally throw). */
function tracked(
  name: string,
  closed: string[],
  opts: { bootstrap?: () => unknown; closeThrows?: boolean } = {},
) {
  return defineModule({
    name,
    bootstrap: opts.bootstrap ?? (() => ({ engine: name })),
    onClose: async () => {
      closed.push(name);
      if (opts.closeThrows) throw new Error(`${name} closer exploded`);
    },
  });
}

describe("module boot rollback — partial boot failure runs module cleanup", () => {
  it("a later module's bootstrap failure closes earlier modules in REVERSE order", async () => {
    const closed: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          tracked("a", closed),
          tracked("b", closed),
          tracked("c", closed, {
            bootstrap: () => {
              throw new Error("c engine refused to start");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "c" bootstrap threw: c engine refused to start/);
    // c's own closer runs FIRST (it entered bootstrap, so it may have
    // allocated before throwing), then b and a in reverse composition order.
    expect(closed).toEqual(["c", "b", "a"]);
  });

  /**
   * Close order comes from the COMPOSED (topologically sorted) module list,
   * never from the order modules were marked eligible. Init runs as two global
   * phases — every module's `plugins`, then every module's `bootstrap` — so a
   * dependant that HAS `plugins` is marked in phase 1 while a dependency that
   * only has `bootstrap` is marked in phase 2. Reversing mark order would close
   * the dependency FIRST, inverting `dependsOn` exactly when a dependant's
   * closer still needs its dependency's engine to flush through.
   */
  describe("close order follows composition order, not marking order", () => {
    /** database: bootstrap-only (marked in phase 2). billing: has plugins (phase 1). */
    function mixedShapes(closed: string[], billingBootstrap?: () => void) {
      return [
        defineModule({
          name: "database",
          bootstrap: () => ({ db: true }),
          onClose: async () => {
            closed.push("database");
          },
        }),
        defineModule({
          name: "billing",
          dependsOn: ["database"],
          plugins: async () => {}, // ← marked BEFORE database, despite depending on it
          bootstrap: () => {
            billingBootstrap?.();
            return { billing: true };
          },
          onClose: async () => {
            closed.push("billing");
          },
        }),
      ];
    }

    it("on clean shutdown, the dependant closes before its dependency", async () => {
      const closed: string[] = [];
      const app = await createApp({ auth: false, logger: false, modules: mixedShapes(closed) });
      await app.ready();
      await app.close();
      expect(closed).toEqual(["billing", "database"]);
    });

    it("on rollback after a later failure, the dependant still closes before its dependency", async () => {
      const closed: string[] = [];
      await expect(
        createApp({
          auth: false,
          logger: false,
          modules: mixedShapes(closed),
          // Both modules have fully initialized by the time this throws.
          afterResources: async () => {
            throw new Error("host wiring failed");
          },
        }),
      ).rejects.toThrow("host wiring failed");
      expect(closed).toEqual(["billing", "database"]);
    });

    it("holds when the dependency is listed LAST and dependsOn does the reordering", async () => {
      const closed: string[] = [];
      const app = await createApp({
        auth: false,
        logger: false,
        // Listed dependant-first; the topological sort puts database first, so
        // teardown must still be billing → database.
        modules: [...mixedShapes(closed)].reverse(),
      });
      await app.ready();
      await app.close();
      expect(closed).toEqual(["billing", "database"]);
    });
  });

  it("a bootstrap that ALLOCATES and then throws still gets its closer called", async () => {
    // The partial-initializer window: marking a module eligible for teardown
    // only after bootstrap SUCCEEDS would leak exactly this client.
    let client: { open: boolean } | undefined;
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "billing",
            bootstrap: async () => {
              client = { open: true }; // allocated…
              throw new Error("migration failed"); // …then failed
            },
            onClose: async () => {
              if (client) client.open = false;
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "billing" bootstrap threw: migration failed/);
    expect(client).toEqual({ open: false }); // released, not leaked
  });

  it("a plugins() that ALLOCATES and then throws still gets its closer called", async () => {
    let socket: { open: boolean } | undefined;
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "infra",
            plugins: async () => {
              socket = { open: true };
              throw new Error("listener bind failed");
            },
            onClose: async () => {
              if (socket) socket.open = false;
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "infra" plugins\(\) threw: listener bind failed/);
    expect(socket).toEqual({ open: false });
  });

  it("an app-level bootstrap failure closes already-booted modules", async () => {
    const closed: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [tracked("a", closed)],
        bootstrap: [
          async () => {
            throw new Error("app bootstrap failed");
          },
        ],
      }),
    ).rejects.toThrow("app bootstrap failed");
    expect(closed).toEqual(["a"]);
  });

  it("a resources-factory failure closes already-booted modules", async () => {
    const closed: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [tracked("a", closed)],
        resources: async () => {
          throw new Error("engine not booted");
        },
      }),
    ).rejects.toThrow(/resources factory threw/);
    expect(closed).toEqual(["a"]);
  });

  it("an afterResources failure closes modules AND unsubscribes their event handlers first", async () => {
    const closed: string[] = [];
    const transport = new MemoryEventTransport();
    const off = vi.fn(() => {
      // Unsubscribe must run BEFORE the module closer (engine still live).
      expect(closed).toEqual([]);
    });
    vi.spyOn(transport, "subscribe").mockResolvedValue(off);

    await expect(
      createApp({
        auth: false,
        logger: false,
        stores: { events: transport },
        modules: [
          defineModule({
            name: "party",
            bootstrap: () => ({ engine: "party" }),
            eventHandlers: [{ event: "customer:created", handler: async () => {} }],
            onClose: async () => {
              closed.push("party");
            },
          }),
        ],
        afterResources: async () => {
          throw new Error("host wiring failed");
        },
      }),
    ).rejects.toThrow("host wiring failed");

    expect(off).toHaveBeenCalledOnce();
    expect(closed).toEqual(["party"]);
  });

  it("rollback is best-effort: a throwing closer never blocks the rest, and the ORIGINAL error surfaces", async () => {
    const closed: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          tracked("a", closed),
          tracked("b", closed, { closeThrows: true }),
          tracked("c", closed, {
            bootstrap: () => {
              throw new Error("original boot error");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/original boot error/);
    // b's closer threw — c and a still closed, and the boot error (not b's)
    // surfaced.
    expect(closed).toEqual(["c", "b", "a"]);
  });

  it("each closer runs AT MOST ONCE even though plugins + bootstrap both mark the module", async () => {
    const closed: string[] = [];
    const counted = defineModule({
      name: "counted",
      plugins: async () => {}, // marks initialized once here…
      bootstrap: () => ({ engine: true }), // …and again here (idempotent)
      onClose: async () => {
        closed.push("counted");
      },
    });
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          counted,
          tracked("boom", closed, {
            bootstrap: () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "boom" bootstrap threw/);
    // "counted" appears ONCE despite being marked by both plugins + bootstrap.
    expect(closed).toEqual(["boom", "counted"]);
  });

  it("a module whose PLUGINS ran (bootstrap never reached) is still closed on rollback", async () => {
    const closed: string[] = [];
    const infraOnly = defineModule({
      name: "infra",
      plugins: async () => {}, // opened "infra" here — no bootstrap at all
      onClose: async () => {
        closed.push("infra");
      },
    });
    const brokenPlugins = defineModule({
      name: "broken",
      plugins: async () => {
        throw new Error("plugin infra failed");
      },
    });
    await expect(
      createApp({ auth: false, logger: false, modules: [infraOnly, brokenPlugins] }),
    ).rejects.toThrow(/module "broken" plugins\(\) threw/);
    expect(closed).toEqual(["infra"]);
  });

  it("successful boot: shutdown is best-effort too — one throwing closer doesn't block the rest or app onClose", async () => {
    const closed: string[] = [];
    let appClosed = false;
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [tracked("a", closed), tracked("b", closed, { closeThrows: true })],
      onClose: async () => {
        appClosed = true;
      },
    });
    await app.ready();
    // The first module close error is rethrown AFTER every closer + app
    // onClose ran, so fastify.close() still reports the failure.
    await expect(app.close()).rejects.toThrow("b closer exploded");
    expect(closed).toEqual(["b", "a"]);
    expect(appClosed).toBe(true);
  });
});

/**
 * A rejected `createApp` never hands the caller an instance, so before the
 * failed-boot cleanup the half-built app was orphaned holding whatever its
 * plugins had taken — most visibly gracefulShutdown's SIGTERM/SIGINT
 * listeners, but equally a host `plugins()` DB/Redis connection.
 */
describe("failed boot closes the partially-built app", () => {
  it("does not leak process signal listeners across repeated boot failures", async () => {
    // gracefulShutdown is off under `preset: "testing"` precisely because it
    // takes process-global listeners — so exercise it explicitly.
    const boot = () =>
      createApp({
        auth: false,
        logger: false,
        arcPlugins: { gracefulShutdown: true },
        modules: [
          defineModule({
            name: "boom",
            bootstrap: () => {
              throw new Error("boot failed");
            },
          }),
        ],
      });

    const before = process.listenerCount("SIGTERM");
    for (let i = 0; i < 3; i++) await expect(boot()).rejects.toThrow("boot failed");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("a clean boot + close is still listener-neutral (no double-removal regression)", async () => {
    const before = process.listenerCount("SIGTERM");
    const app = await createApp({
      auth: false,
      logger: false,
      arcPlugins: { gracefulShutdown: true },
      modules: [defineModule({ name: "ok", bootstrap: () => ({}) })],
    });
    await app.ready();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await app.close();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("cleanup never masks the original boot error", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        arcPlugins: { gracefulShutdown: true },
        modules: [
          defineModule({
            name: "boom",
            bootstrap: () => {
              throw new Error("the real cause");
            },
            // Throws during the cleanup close() — must be swallowed.
            onClose: async () => {
              throw new Error("cleanup also failed");
            },
          }),
        ],
      }),
    ).rejects.toThrow("the real cause");
  });
});

/**
 * A contribution factory closes over booted engines, so it throws for the same
 * reasons a bootstrap does ("connection unavailable"). Bare, that names neither
 * the module nor the arm — in a twenty-module graph that turns a one-line fix
 * into a bisect. Every other module boundary already attributes; the arms must
 * match.
 */
describe("contribution factories attribute failures to the owning module + arm", () => {
  it("attributes a scheduledJobs factory throw", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "loyalty",
            scheduledJobs: () => {
              throw new Error("connection unavailable");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "loyalty" scheduledJobs factory threw: connection unavailable/);
  });

  it("attributes an eventHandlers factory throw", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "search",
            eventHandlers: () => {
              throw new Error("connection unavailable");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "search" eventHandlers factory threw: connection unavailable/);
  });

  it("preserves the original error as `cause`", async () => {
    const original = new Error("connection unavailable");
    const err = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "loyalty",
          scheduledJobs: () => {
            throw original;
          },
        }),
      ],
    }).catch((e: unknown) => e as Error);
    expect(err.cause).toBe(original);
  });
});

describe("module lifecycle states — hasModule / getModuleState", () => {
  it("distinguishes composition from exports: a resource-only module IS composed", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [defineModule({ name: "plain", resources: [] })],
    });
    await app.ready();

    expect(hasModule(app, "plain")).toBe(true);
    expect(hasModuleExports(app, "plain")).toBe(false); // no bootstrap export
    expect(getModuleState(app, "plain")).toBe("ready");
    expect(hasModule(app, "ghost")).toBe(false);
    expect(getModuleState(app, "ghost")).toBeUndefined();
    await app.close();
  });

  it("a module with NO onClose still reaches `closed` — state tracks the app lifecycle", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({ name: "plain", resources: [] }), // no bootstrap, no onClose
        defineModule({ name: "engine", bootstrap: () => ({ ok: true }) }), // no onClose
      ],
    });
    await app.ready();
    expect(getModuleState(app, "plain")).toBe("ready");

    await app.close();
    // Would sit at "ready" forever if the sweep skipped closer-less modules.
    expect(getModuleState(app, "plain")).toBe("closed");
    expect(getModuleState(app, "engine")).toBe("closed");
  });

  it("tracks ready → closed across a clean lifecycle", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({ name: "m", bootstrap: () => ({ ok: true }), onClose: async () => {} }),
      ],
    });
    await app.ready();
    expect(getModuleState(app, "m")).toBe("ready");
    await app.close();
    expect(getModuleState(app, "m")).toBe("closed");
  });

  it("`failed` is STICKY: a module that failed to init stays failed even after its cleanup succeeds", async () => {
    let captured: FastifyInstance | undefined;
    const closed: string[] = [];
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "billing",
            bootstrap: (f) => {
              captured = f;
              throw new Error("migration failed");
            },
            // Cleanup SUCCEEDS — but that must not launder the record to
            // "closed"; "this module failed to initialize" is the fact an
            // operator needs.
            onClose: async () => {
              closed.push("billing");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "billing" bootstrap threw/);

    expect(closed).toEqual(["billing"]); // closer ran…
    expect(getModuleState(captured as FastifyInstance, "billing")).toBe("failed"); // …state preserved
  });

  it("marks a plugins() failure `failed` too", async () => {
    let captured: FastifyInstance | undefined;
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          // Capture in the PLUGINS phase — it runs entirely before any
          // bootstrap, so a bootstrap here would never execute.
          defineModule({
            name: "first",
            plugins: async (f) => {
              captured = f;
            },
          }),
          defineModule({
            name: "infra",
            plugins: async () => {
              throw new Error("bind failed");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "infra" plugins\(\) threw/);
    expect(getModuleState(captured as FastifyInstance, "infra")).toBe("failed");
  });

  it("marks a failed bootstrap `failed` and a rolled-back sibling `closed`", async () => {
    let captured: FastifyInstance | undefined;
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "a",
            bootstrap: (f) => {
              captured = f;
              return { ok: true };
            },
            onClose: async () => {},
          }),
          defineModule({
            name: "b",
            bootstrap: () => {
              throw new Error("nope");
            },
          }),
        ],
      }),
    ).rejects.toThrow(/module "b" bootstrap threw/);

    expect(captured).toBeDefined();
    const f = captured as FastifyInstance;
    expect(getModuleState(f, "b")).toBe("failed");
    expect(getModuleState(f, "a")).toBe("closed"); // rollback ran its closer
  });

  it("marks a module whose closer threw `failed`", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "m",
          bootstrap: () => ({}),
          onClose: async () => {
            throw new Error("stuck");
          },
        }),
      ],
    });
    await app.ready();
    await expect(app.close()).rejects.toThrow("stuck");
    expect(getModuleState(app, "m")).toBe("failed");
  });
});

describe("lazyRequiredModuleExports — eager graph validation", () => {
  it("throws at COMPOSITION time when the module is not in the composed graph", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "consumer",
            bootstrap: (f) => {
              // Typo'd / uncomposed hard dependency must fail boot, not the
              // first request.
              lazyRequiredModuleExports(f, "acounting");
              return {};
            },
          }),
        ],
      }),
    ).rejects.toThrow(/"acounting" is not in the composed module graph/);
  });

  it("still defers the EXPORT read: a composed-but-not-yet-booted sibling resolves at first call", async () => {
    let readLater: (() => unknown) | undefined;
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "consumer",
          // Composed BEFORE "engine" (no dependsOn) — creating the lazy
          // accessor must not throw, because "engine" IS in the graph.
          bootstrap: (f) => {
            readLater = lazyRequiredModuleExports(f, "engine");
            return {};
          },
        }),
        defineModule({ name: "engine", bootstrap: () => ({ tag: "live" }) }),
      ],
    });
    await app.ready();
    expect(readLater).toBeDefined();
    const read = readLater as () => unknown;
    expect((read() as { tag: string }).tag).toBe("live");
    await app.close();
  });
});
