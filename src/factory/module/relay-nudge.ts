/**
 * `@classytic/arc/factory` relay nudge — under `dispatch: 'relay'`, a committed write asks the
 * outbox relay to deliver NOW instead of at its next interval.
 *
 * Kernels are arc-free and only know an `afterCommit` hook; the relay is arc's outbox
 * module (`createOutboxModule`'s `requestDrain`). `createRelayNudge` merges the two for
 * any engine whose runtime carries `{ dispatch, afterCommit }`. A host whose relay runs in ANOTHER
 * process says `'external'` — so "relay mode with no nudge" is always a stated choice,
 * never a silent 0–5 s latency.
 */
import type { FastifyInstance } from "fastify";
import { getModuleExports } from "./index.js";

/** What a module accepts as `relay`. */
export type RelayOption =
  | { readonly requestDrain: () => void }
  | (() => { readonly requestDrain: () => void })
  /** Resolve the drain from an arc module's exports — `{ fromModule: 'outbox' }` is arc's outbox module. */
  | { readonly fromModule: string }
  /** The relay runs in another process (`role: 'relay'`); nothing here to nudge. */
  | "external";

export function isRelayFromModule(relay: RelayOption | undefined): relay is { fromModule: string } {
  return typeof relay === "object" && relay !== null && "fromModule" in relay;
}

interface RuntimeLike {
  readonly dispatch?: unknown;
  readonly afterCommit?: unknown;
}

/**
 * Merge an `afterCommit` nudge into a runtime whose `dispatch` is `'relay'`.
 *
 * - `'inline'` / no dispatch: returned untouched.
 * - `'relay'` + a resolvable `relay`: `afterCommit` nudges; a host's own hook runs first.
 * - `'relay'` + no `relay`: THROWS — a worker-drained deployment and a forgotten wire
 *   look identical, so the host has to say which.
 */
export function withRelayNudge<T>(label: string, runtime: T, relay: RelayOption | undefined): T {
  if (!runtime || typeof runtime !== "object") return runtime;
  const rt = runtime as RuntimeLike;
  if (rt.dispatch !== "relay") return runtime;
  if (relay === undefined) {
    throw new Error(
      `[${label}] runtime.dispatch is 'relay' but no \`relay\` was given. Pass the outbox ` +
        "module's exports (`{ requestDrain }`, a thunk, or `{ fromModule: 'outbox' }`) so a " +
        "committed write is delivered now — or `relay: 'external'` when a separate relay process " +
        "drains the outbox.",
    );
  }
  const resolved = relay;
  if (resolved === "external") return runtime;
  if (typeof resolved !== "function" && !("requestDrain" in resolved)) {
    throw new Error(
      `[${label}] withRelayNudge received the unresolved \`{ fromModule }\` form — ` +
        "createRelayNudge resolves it after resources; a direct caller passes `{ requestDrain }` or a thunk.",
    );
  }
  const hostAfterCommit =
    typeof rt.afterCommit === "function" ? (rt.afterCommit as (info: unknown) => void) : undefined;
  const drain: () => void =
    typeof resolved === "function"
      ? () => resolved().requestDrain()
      : () => resolved.requestDrain();
  // Same shape plus `afterCommit`, so the runtime's own type still describes it.
  return {
    ...rt,
    // The drain runs even when the host's hook throws — the events are committed either way.
    afterCommit: (info: unknown) => {
      try {
        hostAfterCommit?.(info);
      } finally {
        drain();
      }
    },
  } as T;
}

export interface RelayNudge {
  /** Wrap the engine runtime before `bind`; its type is preserved. */
  apply<T>(runtime: T): T;
  /**
   * Present only for `{ fromModule }`: resolve the drain off the module registry. Spread
   * into the module's `afterResources` — every bootstrap has run by then, and a missing
   * module or drain fails at BOOT, not on the first write.
   */
  afterResources?: (fastify: FastifyInstance) => Promise<undefined>;
}

/** The one way a module wires `relay` — `{ fromModule }` included. */
export function createRelayNudge(label: string, relay: RelayOption | undefined): RelayNudge {
  if (!isRelayFromModule(relay))
    return { apply: (runtime) => withRelayNudge(label, runtime, relay) };

  const moduleName = relay.fromModule;
  let moduleDrain: (() => void) | undefined;
  const thunk = () => {
    if (!moduleDrain) {
      throw new Error(
        `[${label}] the relay drain from module "${moduleName}" is not resolved yet — a write ` +
          "committed before afterResources ran. Mount the outbox module alongside this one, or pass `relay` directly.",
      );
    }
    return { requestDrain: moduleDrain };
  };
  return {
    apply: (runtime) => withRelayNudge(label, runtime, thunk),
    afterResources: async (fastify) => {
      const exports = getModuleExports<{ requestDrain?: () => void }>(fastify, moduleName);
      if (typeof exports?.requestDrain !== "function") {
        throw new Error(
          `[${label}] module "${moduleName}" exports no requestDrain(), so a committed write cannot ` +
            "nudge the relay. Arc >=2.40 adds it to createOutboxModule; pass `relay: 'external'` if a " +
            "separate process drains the outbox.",
        );
      }
      moduleDrain = exports.requestDrain;
      return undefined;
    },
  };
}
