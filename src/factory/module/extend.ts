/**
 * Extend a module without silently discarding what it already contributes.
 *
 * ## The bug this exists to stop
 *
 * A host composes a package's module and then decorates the result:
 *
 * ```ts
 * const mod = createOrderModule({ … });
 * return { ...mod, eventHandlers: [ …hostHandlers ] };   // ← silently DESTRUCTIVE
 * ```
 *
 * That reads as "add the host's handlers" and means "replace the module's". It
 * is harmless exactly as long as the module contributes nothing on that arm —
 * which is the trap, because the line is written while that is true and keeps
 * compiling after it stops being true. When `createOrderModule` grew its own
 * subscribers (revenue attach, revenue confirm) the same untouched line
 * un-wired payment recording: orders placed fine, revenue was never recorded,
 * and nothing threw, because refusing an unpaid order is correct behaviour.
 *
 * Two independent hosts on one fleet hit this, on different arms. A helper each
 * host is expected to remember is not a fix for that, so the merge is defined
 * once here, beside the module type it operates on, and every arm is handled —
 * not just the ones whoever wrote the helper had been bitten by.
 *
 * ## Per-arm semantics, and why they differ
 *
 * | arm | behaviour |
 * |---|---|
 * | `resources`, `eventHandlers`, `scheduledJobs`, `workflows`, `healthChecks`, `errorMappers` | CONCATENATED, module's first |
 * | `dependsOn`, `owns` | UNION, order-preserving |
 * | `plugins`, `afterResources`, `onClose` | BOTH run, module's first; disposers composed |
 * | `bootstrap` | cannot be merged — pass a WRAPPER `(inner) => …` |
 * | `name` | not extendable; identity is the module's |
 *
 * Module contributions come first everywhere. A package's own wiring is the
 * side whose absence is invisible — a host notices its handler never fired far
 * sooner than it notices the package's did not.
 *
 * `owns: "provided"` is a claim over the whole surface rather than a list, so it
 * absorbs any list: if either side says "provided", the result is "provided".
 */

import type { FastifyInstance } from "fastify";
import type { ModuleDisposer, ModuleSetupContext } from "./disposers.js";
import type { ArcModule } from "./types.js";

/** Array-or-factory contribution, matching `ModuleContribution<T>`. */
type Contribution<T> =
  | readonly T[]
  | ((fastify: FastifyInstance) => readonly T[] | Promise<readonly T[]>);

/**
 * What a caller may add. Every mergeable arm of `ArcModule`, plus `bootstrap`
 * in wrapper form only.
 *
 * `name` is absent on purpose: renaming a module mid-composition breaks the
 * `dependsOn` graph and the registry key its consumers read, and it is the one
 * "extension" that is never additive.
 */
export interface ModuleExtension<TExports = unknown> {
  dependsOn?: readonly string[];
  owns?: readonly string[] | "provided";
  resources?: ArcModule<TExports>["resources"];
  eventHandlers?: ArcModule<TExports>["eventHandlers"];
  scheduledJobs?: ArcModule<TExports>["scheduledJobs"];
  workflows?: ArcModule<TExports>["workflows"];
  healthChecks?: ArcModule<TExports>["healthChecks"];
  errorMappers?: ArcModule<TExports>["errorMappers"];
  plugins?: ArcModule<TExports>["plugins"];
  afterResources?: ArcModule<TExports>["afterResources"];
  onClose?: ArcModule<TExports>["onClose"];
  /**
   * WRAP the module's bootstrap — it is never replaced.
   *
   * Bootstrap returns the module's exports, so two of them cannot be
   * concatenated: one value has to win, and a host silently winning is the gym
   * failure (`{ ...mod, bootstrap }` overwrote the factory's own, so the engine
   * the module published was never created). The wrapper form makes the
   * relationship explicit — call `inner` and decorate its result, or
   * deliberately do not.
   *
   * `inner` is `undefined` when the module has no bootstrap of its own.
   */
  bootstrap?: (
    inner:
      | ((f: FastifyInstance, c: ModuleSetupContext) => TExports | Promise<TExports>)
      | undefined,
  ) => (f: FastifyInstance, c: ModuleSetupContext) => TExports | Promise<TExports>;
}

/** Concatenate two contributions, resolving factories only when arc asks. */
function mergeContribution<T>(
  own: Contribution<T> | undefined,
  extra: Contribution<T> | undefined,
): Contribution<T> | undefined {
  if (own === undefined) return extra;
  if (extra === undefined) return own;
  // Always a factory: an arm uses the factory form precisely when it needs the
  // BOOTED instance to resolve a lazy engine, so resolving either side eagerly
  // here would capture `undefined` for the very engine that form exists to defer.
  return async (fastify: FastifyInstance) => {
    const a = typeof own === "function" ? await own(fastify) : own;
    const b = typeof extra === "function" ? await extra(fastify) : extra;
    return [...a, ...b];
  };
}

/**
 * Plain-array concat, for the arms that are NOT `ModuleContribution`.
 *
 * `healthChecks` and `errorMappers` are declared as arrays only — arc reads
 * them directly and never calls them. Routing them through the factory merge
 * above would hand arc a function where it expects a list, which does not fail
 * loudly: the arm reads as non-empty and contributes nothing.
 */
function mergeArray<T>(
  own: readonly T[] | undefined,
  extra: readonly T[] | undefined,
): readonly T[] | undefined {
  if (own === undefined) return extra;
  if (extra === undefined) return own;
  return [...own, ...extra];
}

/** Order-preserving union — a duplicate edge or claim is not an error. */
function mergeNames(
  own: readonly string[] | undefined,
  extra: readonly string[] | undefined,
): readonly string[] | undefined {
  if (own === undefined) return extra;
  if (extra === undefined) return own;
  return [...new Set([...own, ...extra])];
}

function mergeOwns(
  own: ArcModule["owns"],
  extra: ArcModule["owns"],
): ArcModule["owns"] | undefined {
  if (own === "provided" || extra === "provided") return "provided";
  return mergeNames(own, extra);
}

/**
 * Run both lifecycle hooks, module's first, composing whatever disposers they
 * return. Teardown runs in REVERSE, matching arc's own module teardown order.
 */
function mergeHook(
  own: ArcModule["plugins"] | undefined,
  extra: ArcModule["plugins"] | undefined,
): ArcModule["plugins"] | undefined {
  if (own === undefined) return extra;
  if (extra === undefined) return own;
  return async (fastify: FastifyInstance, context: ModuleSetupContext) => {
    const d1 = await own(fastify, context);
    const d2 = await extra(fastify, context);
    if (!d1 && !d2) return undefined;
    const disposer: ModuleDisposer = async () => {
      if (d2) await d2();
      if (d1) await d1();
    };
    return disposer;
  };
}

/**
 * Close the MODULE first, then the host — the opposite of the disposer order
 * above, and deliberately so.
 *
 * A disposer pair is symmetric setup/teardown, so it unwinds LIFO. `onClose` is
 * not: the resource whose lifetime encloses everything is usually the ENGINE,
 * and in a bring-your-own-engine composition the HOST owns it and hands it to
 * the module. Running the host's `onClose` first would destroy the engine while
 * the module is still draining work against it.
 *
 * be-prod's planning module states exactly this order in prose and implements
 * it by hand — "the module's own onClose first (drains its built-in inFlight),
 * then our host-side fallback inFlight, then destroy the BYO engine". Encoding
 * it here is what stops the next host from getting it backwards.
 */
function mergeOnClose(
  own: ArcModule["onClose"],
  extra: ArcModule["onClose"],
): ArcModule["onClose"] | undefined {
  if (own === undefined) return extra;
  if (extra === undefined) return own;
  return async (fastify: FastifyInstance) => {
    await own(fastify);
    await extra(fastify);
  };
}

/**
 * Merge a host's additions onto a module. Nothing the module declared is lost.
 *
 * ```ts
 * return extendModule(createOrderModule({ … }), {
 *   eventHandlers: () => hostHandlers(),      // appended after the module's
 *   dependsOn: ["outbox"],                    // unioned
 *   bootstrap: (inner) => async (f, c) => {   // wraps, never replaces
 *     const exports = await inner?.(f, c);
 *     return decorate(exports);
 *   },
 * });
 * ```
 */
export function extendModule<TExports = unknown>(
  mod: ArcModule<TExports>,
  extension: ModuleExtension<TExports>,
): ArcModule<TExports> {
  const out: Record<string, unknown> = { ...mod };

  /**
   * Assign only when the merge produced something.
   *
   * An absent arm must stay ABSENT rather than become `[]` or `undefined` —
   * arc distinguishes "contributes nothing" from "contributes an empty list"
   * when deciding whether a module participates in an arm at all.
   *
   * Each merge is therefore evaluated ONCE, into this call. Writing the
   * condition and the value as two separate calls would leave twelve pairs of
   * duplicated expressions, where editing one half and not the other changes
   * nothing visible and produces a module whose arm silently disagrees with the
   * check that decided to set it.
   */
  const set = (key: keyof ArcModule<TExports>, value: unknown): void => {
    if (value !== undefined) out[key as string] = value;
  };

  set("dependsOn", mergeNames(mod.dependsOn, extension.dependsOn));
  set("owns", mergeOwns(mod.owns, extension.owns));
  set("resources", mergeContribution(mod.resources, extension.resources));
  set("eventHandlers", mergeContribution(mod.eventHandlers, extension.eventHandlers));
  set("scheduledJobs", mergeContribution(mod.scheduledJobs, extension.scheduledJobs));
  set("workflows", mergeContribution(mod.workflows, extension.workflows));
  set("healthChecks", mergeArray(mod.healthChecks, extension.healthChecks));
  set("errorMappers", mergeArray(mod.errorMappers, extension.errorMappers));
  set("plugins", mergeHook(mod.plugins, extension.plugins));
  set("afterResources", mergeHook(mod.afterResources, extension.afterResources));
  set("onClose", mergeOnClose(mod.onClose, extension.onClose));
  // Bootstrap is a WRAPPER, not a merge: it is applied when the caller supplies
  // one, even if the module has none (the wrapper then receives `undefined`).
  if (extension.bootstrap) out.bootstrap = extension.bootstrap(mod.bootstrap);

  return out as unknown as ArcModule<TExports>;
}
