/**
 * Resource registration for createApp.
 *
 * Handles: resourcePrefix, skipGlobalPrefix, bootstrap, afterResources.
 */

import type { FastifyInstance } from "fastify";
import type { ResourceLike } from "./loadResources.js";
import { type ArcModule, orderModules, resolveModule } from "./module.js";
import type { FastifyPlugin } from "./shared.js";
import type { CreateAppOptions } from "./types/index.js";

type ResourcesFactory = (
  fastify: FastifyInstance,
) => ReadonlyArray<ResourceLike> | Promise<ReadonlyArray<ResourceLike>>;

function isResourcesFactory(value: CreateAppOptions["resources"]): value is ResourcesFactory {
  return typeof value === "function";
}

/** Register a single resource with descriptive error on failure. */
async function registerOne(
  parent: FastifyInstance,
  resource: import("./loadResources.js").ResourceLike,
  mountRoutes?: boolean,
): Promise<void> {
  const name = resource.name ?? "unknown";
  try {
    // `arcMountRoutes: false` (worker role, 2.23) — the resource plugin
    // registers shared runtime state (registry/hooks/cache rules) and
    // returns before any route mounts. See wiki/factory.md § createWorker.
    await parent.register(
      resource.toPlugin() as FastifyPlugin,
      mountRoutes === false ? { arcMountRoutes: false } : {},
    );
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Underlying ArcError messages already start with `Resource "name"
    // ...` — strip the redundant prefix so the wrapper isn't a Russian
    // doll of "Resource "x" failed to register: Resource "x" aggregation
    // ..." with its trailing double period. Cause chain still preserves
    // the original via `{ cause }`.
    const stripped = rawMsg
      .replace(new RegExp(`^Resource "${name}"\\s*`), "")
      .replace(/\.+\s*$/, "");
    parent.log.error(`Failed to register resource "${name}": ${rawMsg}`);
    // Preserve the original via `{ cause }` so adapter / plugin / Mongoose
    // errors keep their stack + any custom properties (statusCode, code,
    // etc.). Node + V8 both render `err.cause` in stacks.
    throw new Error(`Resource "${name}" failed to register — ${stripped}.`, {
      cause: err,
    });
  }
}

/**
 * Execute the full resource lifecycle. The module graph is resolved + ordered
 * by `dependsOn` (stable topological sort) once, up FRONT — before any
 * side-effecting plugin — so a bad graph fails fast with no half-initialised
 * infra. Every phase below iterates that order; each module phase runs BEFORE
 * its app-level counterpart:
 *
 * 1.  resolve + orderModules     — validate the graph (dup names, missing/self
 *                                  deps, cycles fail fast) BEFORE side effects
 * 2.  plugins()                  — app infra (DB, data, webhooks)
 * 3.  module.plugins             — module infra, dependsOn order, before bootstraps
 * 4a. module.bootstrap           — engine init (return value → arc.modules[name])
 * 4b. bootstrap[]                — app-level domain init
 * 5.  resources factory (if any) — resolved AFTER bootstrap, so engine-backed
 *                                  adapters can `await ensureEngine()` and pass
 *                                  live models/repos into `defineResource(...)`
 * 5b. module resources           — RESOLVED after the app factory, but PREPENDED
 *                                  so they REGISTER before app resources (two
 *                                  orderings, both intentional — see §5b)
 * 6.  module.afterResources → afterResources()  — post-registration wiring
 * 7.  onReady                    — lifecycle hook
 * 7b. onClose                    — module.onClose (reverse composition order)
 *                                  THEN app onClose, in ONE hook so module
 *                                  teardown runs before shared infra closes.
 */
export async function registerResources(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  preResolvedModules?: readonly ArcModule[],
): Promise<void> {
  // v2.11 — production preset defaults `strictResources` + `strictResourceDir`
  // to `true`. Field report: a stale `dist/` registered 17 ghost
  // `.resource.js` files that triggered a downstream Mongoose model collision
  // mid-boot; arc's duplicate-name detector only WARNed, which was easy to
  // miss in the log stream. Flipping both strict modes in production surfaces
  // the stale-build / empty-discovery case before the app takes traffic, with
  // opt-out for hosts that legitimately duplicate names (rare — usually a bug).
  if (config.preset === "production") {
    if (config.strictResources === undefined) config = { ...config, strictResources: true };
    if (config.strictResourceDir === undefined) config = { ...config, strictResourceDir: true };
  }

  // ── 1. Resolve + validate the module graph FIRST — before any side-effecting
  // plugin runs. Resolving thunks (dynamic imports) and the stable topological
  // sort (`orderModules`) is where duplicate names, missing/self deps, and
  // dependency cycles fail fast. Doing it up front means a broken composition
  // root aborts BEFORE `config.plugins` connects a DB / registers a webhook /
  // opens Redis — no half-initialised infra on a bad module set.
  //
  // A thunk is where a conditional `import()` fires (region packs, tier
  // gating), so unselected packs are never evaluated. `dependsOn` orders
  // COMPOSITION, not import — every thunk resolves here regardless of edges.
  // Every phase below iterates this one ordered list. (see wiki/modules.md)
  //
  // 2.21 — `createApp` pre-resolves the graph even earlier (before security
  // plugins / the error handler, so module-shipped `errorMappers` can merge)
  // and passes it in; thunks then fire exactly once. Resolving here remains
  // for direct callers of `registerResources` (tests, embedded hosts).
  const modules =
    preResolvedModules ??
    orderModules(await Promise.all((config.modules ?? []).map((m) => resolveModule(m))));

  // ── 2. App plugins (infra: DB, data, webhooks) ──
  if (config.plugins) {
    await config.plugins(fastify);
    fastify.log.debug("Custom plugins registered");
  }

  // ── 3. Module plugins (infra) — ordered, AFTER app `plugins()` (so module
  // infra can build on app foundations like a DB connection) and BEFORE any
  // module bootstrap. The module-level analog of the app plugins slot; a
  // dependency's plugins run first (dependsOn order), so a decorator it
  // installs is available to dependents' plugins.
  for (const m of modules) {
    if (!m.plugins) continue;
    try {
      await m.plugins(fastify);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[arc] module "${m.name}" plugins() threw: ${msg}`, { cause: err });
    }
  }

  // ── 4. Bootstrap (domain init) — module bootstraps (dependsOn order) then
  // app-level, so app-level init can depend on a module's live engine. A module
  // bootstrap failure is fail-fast (wrapped with the module name).
  for (const m of modules) {
    if (!m.bootstrap) continue;
    let exported: unknown;
    try {
      // A bootstrap return value is the module's PUBLIC EXPORT — recorded at
      // `fastify.arc.modules[name]` so later modules (dependsOn order = init
      // order) can wire cross-module ports without a DI container. (wiki/modules.md)
      exported = await m.bootstrap(fastify);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[arc] module "${m.name}" bootstrap threw: ${msg}`, { cause: err });
    }
    if (exported !== undefined) {
      const arc = fastify.arc;
      if (!arc) {
        // arcCorePlugin always decorates `fastify.arc` before this phase runs;
        // if it hasn't, the module's public export would vanish silently —
        // the opposite of the fail-fast contract. Throw, don't guard.
        throw new Error(
          `[arc] module "${m.name}" returned a public export but fastify.arc is not decorated — arcCorePlugin must register first.`,
        );
      }
      // Null-proto map: a module named "__proto__" would corrupt a plain
      // object (the assignment sets the prototype, not an own key); a null
      // prototype makes every module name a plain own property.
      if (!arc.modules) arc.modules = Object.create(null) as Record<string, unknown>;
      arc.modules[m.name] = exported;
    }
  }
  if (modules.length) {
    // Ordered by dependsOn — the log doubles as the resolved composition order.
    fastify.log.debug(
      `${modules.length} module(s) composed (in dependency order): ${modules.map((m) => m.name).join(" → ")}`,
    );
  }
  if (config.bootstrap?.length) {
    for (const init of config.bootstrap) {
      await init(fastify);
    }
    fastify.log.debug(`${config.bootstrap.length} bootstrap function(s) executed`);
  }

  // ── 5. Resolve resources factory (if supplied) ──
  //
  // A `resources` function form runs AFTER bootstrap so engine-backed
  // adapters can await their dependencies before `defineResource(...)` is
  // called. Thrown errors bubble to the Fastify boot — a bad factory is a
  // fail-fast condition, not a best-effort skip.
  //
  // Factory errors are wrapped with a diagnostic prefix + `{ cause }` so
  // adapter / engine-boot failures walk back to the original throw site.
  // Pre-this-extension hosts had to write per-resource lazy-bridge
  // adapters that awaited the engine on every CRUD call — this factory
  // slot is the clean answer to "my repository lives in an engine that
  // boots asynchronously."
  let resolvedResources: ReadonlyArray<ResourceLike> | undefined;
  if (isResourcesFactory(config.resources)) {
    try {
      resolvedResources = await config.resources(fastify);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fastify.log.error(`Resources factory threw during boot: ${msg}`);
      throw new Error(
        `[arc] resources factory threw: ${msg}. ` +
          "Check engine bootstrap order (did you forget a bootstrap step?) " +
          "and that `defineResource(...)` calls inside the factory receive " +
          "fully-booted adapters / repositories.",
        { cause: err },
      );
    }
    config = { ...config, resources: resolvedResources };
  } else {
    resolvedResources = config.resources;
  }

  // ── 4. Resources (split by prefix) ──
  //
  // Contract (matches the `resourceDir` JSDoc in types.ts): an explicit
  // `resources` array ALWAYS wins over `resourceDir`, including when it's
  // empty. Pre-2.11 the check was `!config.resources?.length`, which
  // silently triggered auto-discovery when a caller passed `resources: []`
  // to explicitly disable resource registration — a subtle footgun for
  // shared-config factories that spread a base and override `resources`.
  // Auto-discovery now fires only when `resources` is absent (undefined).
  // The factory form (resolved above) also honors this: a factory that
  // returns `[]` suppresses discovery the same way a literal `[]` does.
  //
  // Track the discovery input + resolved path so the final log line (even
  // at N=0) can echo both — critical for diagnosing the "deploy 404s
  // everything" case where a misconfigured path yields zero resources.
  let discoveryRawDir: string | undefined;
  let discoveryPath: string | undefined;
  let discoveryYieldedZero = false;
  if (resolvedResources === undefined && config.resourceDir) {
    const { loadResources } = await import("./loadResources.js");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // v2.10.9 — accept `import.meta.url` directly. Before this, a string
    // like 'src/resources' was the only form, and it resolved against
    // process.cwd() — which mismatches `dist/` layouts at runtime and
    // produced "deployed app 404s everything" outages. The file:// URL
    // form mirrors loadResources's own signature so hosts can use the
    // same value for both.
    const rawDir = config.resourceDir;
    const dir = rawDir.startsWith("file://") ? dirname(fileURLToPath(rawDir)) : resolve(rawDir);
    discoveryRawDir = rawDir;
    discoveryPath = dir;
    const discovered = await loadResources(dir, { logger: fastify.log });
    if (discovered.length === 0) {
      // strictResourceDir still throws immediately — that's the "fail
      // boot before taking traffic" guarantee hosts opt into. In the
      // non-strict path we stash the flag and let the final zero-count
      // summary below be the single WARN. Pre-fix this emitted one WARN
      // here AND a second WARN in the final summary, reading as two
      // separate problems rather than one discovery failure + summary.
      if (config.strictResourceDir) {
        throw new Error(
          `[arc] loadResources: resourceDir "${rawDir}" resolved to "${dir}" but ` +
            "yielded 0 resources. Check the path, file naming (*.resource.{ts,js,mts,mjs}), " +
            "and runtime layout (src/ vs dist/). Use `strictResourceDir: true` to fail boot.",
        );
      }
      discoveryYieldedZero = true;
    }
    resolvedResources = discovered;
  }

  // ── 5a. Module ownership — drop app forks a module supersedes ──
  //
  // A module declares `owns: [...names]` for the app-level resources it
  // authoritatively provides (see `ArcModule.owns`). Any app resource of that
  // name is DROPPED here, so the module's own version (prepended at 5b) is the
  // one that registers — the host keeps NO hand-maintained "which resources did
  // modules take over" filter set. Read STATICALLY off each module (no factory
  // resolution), so it's free of boot-order coupling and works whether a
  // module's `resources` is an array or a post-bootstrap factory.
  if (modules.length && resolvedResources && resolvedResources.length > 0) {
    const owned = new Set<string>();
    for (const m of modules) {
      for (const name of m.owns ?? []) owned.add(name);
    }
    if (owned.size > 0) {
      const before = resolvedResources.length;
      resolvedResources = resolvedResources.filter((r) => !(r.name != null && owned.has(r.name)));
      const dropped = before - resolvedResources.length;
      if (dropped > 0) {
        fastify.log.debug(
          `[arc] ${dropped} app resource(s) superseded by module owns() — the module version registers instead`,
        );
      }
    }
  }

  // ── 5b. Module resources ──
  //
  // TWO distinct orderings, deliberately different — both documented so neither
  // surprises a maintainer:
  //   • RESOLUTION order: app `resources`/`resourceDir` resolve FIRST (above),
  //     THEN module resource factories run here. This keeps the app-factory's
  //     semantics (e.g. `resources: []` suppressing discovery) untouched, and
  //     both run post-bootstrap so factories receive live engines.
  //   • REGISTRATION order: module resources are PREPENDED, so they register
  //     (routes mounted, dedup, prefix-split) BEFORE app resources — matching
  //     the "modules before app-level in every phase" contract users rely on.
  // A module resource is not special-cased; it flows the SAME registration path
  // below as an app resource.
  if (modules.length) {
    const moduleResources: ResourceLike[] = [];
    for (const m of modules) {
      if (!m.resources) continue;
      try {
        const rs = typeof m.resources === "function" ? await m.resources(fastify) : m.resources;
        moduleResources.push(...rs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[arc] module "${m.name}" resources factory threw: ${msg}. ` +
            "Check the module's bootstrap ran and its adapters received booted engines.",
          { cause: err },
        );
      }
    }
    if (moduleResources.length) {
      resolvedResources = [...moduleResources, ...(resolvedResources ?? [])];
    }
  }

  if (resolvedResources && resolvedResources.length > 0) {
    // Detect duplicate resource names early — a common mistake with loadResources + manual array
    const seen = new Set<string>();
    for (const resource of resolvedResources) {
      if (resource.name) {
        if (seen.has(resource.name)) {
          const msg =
            `Duplicate resource name "${resource.name}" detected. ` +
            "This will cause route conflicts. Check your resources array and loadResources() output. " +
            "Common cause: stale compiled files in dist/ alongside src/. Use `strictResources: true` to fail boot.";
          // v2.10.9 — opt-in strict mode. A reporter hit Mongoose model
          // collisions downstream of arc's registry because 17 ghost
          // .resource.js files from a stale dist/ registered duplicate
          // names; a warn was easy to miss in the log stream. Strict
          // mode raises the signal before the downstream collision.
          if (config.strictResources) {
            throw new Error(msg);
          }
          fastify.log.warn(msg);
        }
        seen.add(resource.name);
      }
    }

    const prefixed: ResourceLike[] = [];
    const root: ResourceLike[] = [];

    for (const resource of resolvedResources) {
      if (resource.skipGlobalPrefix) {
        root.push(resource);
      } else {
        prefixed.push(resource);
      }
    }

    // Root resources (skipGlobalPrefix: true) register directly
    for (const resource of root) {
      await registerOne(fastify, resource, config.mountRoutes);
    }

    // Prefixed resources register under resourcePrefix (or root if no prefix)
    if (prefixed.length) {
      if (config.resourcePrefix) {
        await fastify.register(
          async (scoped) => {
            for (const resource of prefixed) {
              await registerOne(scoped, resource, config.mountRoutes);
            }
          },
          { prefix: config.resourcePrefix },
        );
      } else {
        for (const resource of prefixed) {
          await registerOne(fastify, resource, config.mountRoutes);
        }
      }
    }

    const names = resolvedResources.map((r) => r.name ?? "?").join(", ");
    const prefix = config.resourcePrefix ? ` (prefix: ${config.resourcePrefix})` : "";
    fastify.log.info(`${resolvedResources.length} resource(s) registered${prefix}: ${names}`);
  } else {
    // v2.11 — always announce the count, even at N=0. Before this the
    // "N resource(s) registered" info line was gated on N>0, so an app
    // that booted with zero resources emitted nothing at all — the exact
    // shape of the silent-deploy outage the field report flagged. When a
    // discoveryPath is known (resourceDir was set), echo it to help
    // operators diagnose "right path, wrong extension" or "src vs dist"
    // mismatches. Escalated to WARN because N=0 is almost never what the
    // author intended outside of testing.
    //
    // When discovery yielded zero, fold the diagnostic path hints into
    // this single WARN instead of emitting a separate upstream WARN — the
    // caller sees ONE diagnostic for one failure mode. Raw input + resolved
    // path both appear so operators can spot "wrong dir", "src vs dist",
    // and "relative to cwd vs import.meta.url" mismatches at a glance.
    const prefix = config.resourcePrefix ? ` (prefix: ${config.resourcePrefix})` : "";
    const scanned = discoveryPath
      ? ` — resourceDir "${discoveryRawDir}" resolved to "${discoveryPath}"`
      : "";
    const hints = discoveryYieldedZero
      ? ` but yielded 0 resources. Check the path, file naming (*.resource.{ts,js,mts,mjs}), and runtime layout (src/ vs dist/). Use \`strictResourceDir: true\` to fail boot.`
      : "";
    fastify.log.warn(`0 resources registered${prefix}${scanned}${hints}`);
  }

  // ── 6. After resources — modules (dependsOn order) first, then app-level ──
  //
  // Module post-wiring runs before app-level `afterResources`, so the app-level
  // hook can wire across modules once every module's routes are mounted. Errors
  // are wrapped with the module name — same fail-fast diagnostics as the
  // plugins / bootstrap / resources phases (so "which module?" is never lost).
  for (const m of modules) {
    if (!m.afterResources) continue;
    try {
      await m.afterResources(fastify);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[arc] module "${m.name}" afterResources() threw: ${msg}`, { cause: err });
    }
  }
  if (config.afterResources) {
    await config.afterResources(fastify);
    fastify.log.debug("afterResources hook executed");
  }

  // ── 7. Lifecycle hooks ──
  if (config.onReady) {
    const onReady = config.onReady;
    fastify.addHook("onReady", async () => {
      await onReady(fastify);
    });
  }

  // ── 7b. Teardown — module `onClose` (reverse composition order) THEN app
  // `onClose`, in ONE hook.
  //
  // Fastify runs `onClose` hooks LIFO (reverse registration). A separate
  // module-teardown hook + a separate app-onClose hook would therefore fire in
  // the WRONG order (app first, then modules) — the opposite of the documented
  // contract, and unsafe because app onClose typically closes shared infra
  // (DB/Redis) that module teardown still needs to flush outboxes / drain
  // queues. Combining them makes the order explicit and independent of how many
  // other close hooks exist. Registering this hook LAST also means it fires
  // BEFORE the infra plugins registered back in `config.plugins` (their onClose
  // was registered early → runs late under LIFO) — so both module teardown AND
  // app onClose see live infra, and the underlying connections close last.
  const closers = modules.filter((m) => m.onClose).reverse();
  const appOnClose = config.onClose;
  if (closers.length || appOnClose) {
    fastify.addHook("onClose", async () => {
      for (const m of closers) {
        await m.onClose?.(fastify);
      }
      if (appOnClose) await appOnClose(fastify);
    });
  }
}
