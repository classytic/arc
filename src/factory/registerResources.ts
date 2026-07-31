/**
 * Resource registration for createApp.
 *
 * Handles: resourcePrefix, skipGlobalPrefix, bootstrap, afterResources.
 */

import type { FastifyInstance } from "fastify";
import type { ResourceLike } from "./loadResources.js";
import {
  type ArcModule,
  collectModuleScheduledJobs,
  createModuleTeardown,
  initModuleStates,
  orderModules,
  resolveModule,
  setModuleState,
  subscribeModuleEventHandlers,
  unsubscribeModuleEventHandlers,
} from "./module/index.js";
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
 * 5a. module resources           — RESOLVED after the app factory, but PREPENDED
 *                                  so they REGISTER before app resources (two
 *                                  orderings, both intentional — see §5a)
 * 5b. owns validation + filter   — verify each claim is supplied by its claimant,
 *                                  THEN drop the app forks it supersedes
 * 6.  module.afterResources → afterResources()  — post-registration wiring
 * 7.  onReady                    — lifecycle hook
 * 7b. onClose                    — module.onClose (reverse composition order)
 *                                  THEN app onClose, in ONE hook so module
 *                                  teardown runs before shared infra closes.
 *
 * Boot is TRANSACTIONAL for module-held resources: phases 2–6 run inside one
 * try/catch. On any failure, arc unsubscribes already-active module event
 * handlers, then closes every module that ENTERED an init phase — reverse
 * composition order, best-effort (see module/teardown.ts) — and rethrows the
 * ORIGINAL boot error. Without this, a failure after module A's bootstrap but
 * before the §7b hook registration leaked A's clients/timers/engines with no
 * teardown path.
 *
 * "Entered", not "completed": a module is eligible for teardown from the
 * moment it enters `plugins()`/`bootstrap()`, so the callback that allocates a
 * client and THEN throws — the commonest partial-init shape — gets its closer
 * called too.
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

  // Lifecycle-state map (`arc.moduleStates`) — every composed module is
  // `resolved` from here on, so `hasModule()` / `getModuleState()` answer for
  // the whole graph before any lifecycle callback runs. This is also what lets
  // `lazyRequiredModuleExports` validate presence at COMPOSITION time instead
  // of surfacing a missing hard dependency on the first request.
  initModuleStates(
    fastify,
    modules.map((m) => m.name),
  );
  // Teardown controller — tracks which modules completed an init phase, and
  // once-guards every closer so the rollback path and the §7b shutdown hook
  // can never both run one (see module/teardown.ts).
  const teardown = createModuleTeardown(fastify, modules);
  // Populated at §6; declared here so the catch below can unsubscribe
  // whatever fraction of the handlers went live before the failure.
  let eventUnsubscribes: Array<() => void | Promise<void>> = [];

  try {
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
      // Marked BEFORE the call, not after: `plugins()` may open a socket and
      // THEN throw, and that half-open resource is exactly what its closer
      // exists to release. Marking on success would leak it.
      teardown.markInitialized(m);
      try {
        await m.plugins(fastify);
      } catch (err) {
        setModuleState(fastify, m.name, "failed");
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[arc] module "${m.name}" plugins() threw: ${msg}`, { cause: err });
      }
    }

    // ── 4. Bootstrap (domain init) — module bootstraps (dependsOn order) then
    // app-level, so app-level init can depend on a module's live engine. A module
    // bootstrap failure is fail-fast (wrapped with the module name).
    for (const m of modules) {
      if (!m.bootstrap) {
        // No init of its own — ready the moment its slot in the order is
        // reached (and eligible for teardown, so a resource-only module with
        // an `onClose` still closes).
        setModuleState(fastify, m.name, "ready");
        teardown.markInitialized(m);
        continue;
      }
      let exported: unknown;
      // Same rule as `plugins` above — a bootstrap that allocates a client and
      // then throws on a later init step must still get its closer called.
      teardown.markInitialized(m);
      setModuleState(fastify, m.name, "bootstrapping");
      try {
        // A bootstrap return value is the module's PUBLIC EXPORT — recorded at
        // `fastify.arc.modules[name]` so later modules (dependsOn order = init
        // order) can wire cross-module ports without a DI container. (wiki/modules.md)
        exported = await m.bootstrap(fastify);
      } catch (err) {
        setModuleState(fastify, m.name, "failed");
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[arc] module "${m.name}" bootstrap threw: ${msg}`, { cause: err });
      }
      setModuleState(fastify, m.name, "ready");
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

    // ── 5a. Module resources — RESOLVE (registration happens below) ──
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
    //
    // Resolution happens BEFORE the ownership filter (5b) so `owns` can be
    // verified against what each module actually SUPPLIES, not merely what it
    // claims. Ordering the other way round is what let a bad claim delete a
    // route with nothing to replace it.
    const moduleResourceNames = new Map<string, Set<string>>();
    const moduleResources: ResourceLike[] = [];
    for (const m of modules) {
      if (!m.resources) continue;
      let rs: ReadonlyArray<ResourceLike>;
      try {
        rs = typeof m.resources === "function" ? await m.resources(fastify) : m.resources;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[arc] module "${m.name}" resources factory threw: ${msg}. ` +
            "Check the module's bootstrap ran and its adapters received booted engines.",
          { cause: err },
        );
      }
      const names = new Set<string>();
      for (const r of rs) if (r.name != null) names.add(r.name);
      moduleResourceNames.set(m.name, names);
      moduleResources.push(...rs);
    }

    // ── 5b. Module ownership — verify the claim, THEN drop app forks ──
    //
    // A module declares `owns: [...names]` for the app-level resources it
    // authoritatively provides (see `ArcModule.owns`). Any app resource of that
    // name is DROPPED, so the module's own version is the one that registers —
    // the host keeps NO hand-maintained "which resources did modules take over"
    // filter set.
    //
    // `owns` is an EXPLICIT authoritative claim, so it is verified
    // unconditionally (not gated behind `strictResources`, which governs the
    // much softer duplicate-discovery case). A module that claims a name it
    // does not supply — a typo, a factory that returned early, a resource
    // deleted without updating `owns` — would otherwise boot "successfully"
    // with the app's route silently deleted and nothing serving it. That is a
    // silent 404 in production, which is precisely the failure mode arc's
    // fail-fast contract exists to prevent.
    //
    // The claim must be satisfied by the CLAIMING module itself: cross-module
    // satisfaction would make ownership non-local and undo the colocation the
    // arm exists for.
    for (const m of modules) {
      if (!m.owns?.length) continue;
      const supplied = moduleResourceNames.get(m.name);
      const missing = m.owns.filter((name) => !supplied?.has(name));
      if (missing.length > 0) {
        const provided = supplied?.size ? [...supplied].join(", ") : "(none)";
        throw new Error(
          `[arc] module "${m.name}" declares owns: [${missing.map((n) => `"${n}"`).join(", ")}] ` +
            "but its own `resources` do not supply " +
            `${missing.length === 1 ? "that name" : "those names"}. ` +
            "`owns` DROPS the app-level resource of that name, so an unmet claim removes the " +
            "route entirely and nothing serves it. Provide it in this module's `resources`, or " +
            "drop the `owns` entry.\n" +
            `Resources supplied by "${m.name}": ${provided}.`,
        );
      }
    }

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

    if (moduleResources.length) {
      resolvedResources = [...moduleResources, ...(resolvedResources ?? [])];
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
    // Module schedules resolve exactly once, then flow through Arc's canonical
    // schedules plugin. Do this BEFORE event activation so invalid schedule
    // configuration cannot leave already-subscribed handlers behind.
    const scheduledJobs = await collectModuleScheduledJobs(fastify, modules);
    if (scheduledJobs.length > 0) {
      if (config.arcPlugins?.schedules === false) {
        throw new Error(
          "[arc] modules declare scheduledJobs but arcPlugins.schedules is false. Enable the scheduler or remove the declarations.",
        );
      }
      if (fastify.hasDecorator("getScheduleStats")) {
        throw new Error(
          "[arc] modules declare scheduledJobs but schedulesPlugin was already registered manually. Configure their runner through arcPlugins.schedules so Arc can compose one schedule table.",
        );
      }
      const frozenJobs = Object.freeze(scheduledJobs.map((job) => Object.freeze({ ...job })));
      const scheduleOptions =
        typeof config.arcPlugins?.schedules === "object" ? config.arcPlugins.schedules : {};
      const { default: schedulesPlugin } = await import("../plugins/schedules.js");
      await fastify.register(schedulesPlugin, { ...scheduleOptions, schedules: frozenJobs });
      if (fastify.arc) {
        fastify.arc.scheduledJobs = frozenJobs;
        fastify.arc.plugins.set("arc-schedules", {
          name: "arc-schedules",
          options: { scheduleCount: frozenJobs.length },
          registeredAt: new Date().toISOString(),
        });
      }
    }

    // Module event handlers — transactional subscription in dependency order.
    // The helper rolls back its own partial activation; the outer catch below
    // rolls back if anything AFTER full activation fails.
    eventUnsubscribes = await subscribeModuleEventHandlers(fastify, modules);

    if (config.afterResources) {
      await config.afterResources(fastify);
      fastify.log.debug("afterResources hook executed");
    }
  } catch (err) {
    // ── Boot rollback ── the §7b teardown hook is registered only AFTER this
    // try block, so without an explicit rollback a failure here would leak
    // every already-initialized module's clients/timers/engines. Order mirrors
    // shutdown: unsubscribe live event handlers first (module engines still
    // alive), then close initialized modules in reverse composition order.
    // Both sweeps are best-effort; secondary failures are LOGGED and the
    // ORIGINAL boot error is rethrown untouched.
    const unsubscribeErrors = await unsubscribeModuleEventHandlers(eventUnsubscribes);
    for (const unsubscribeError of unsubscribeErrors) {
      fastify.log.error(
        { err: unsubscribeError },
        "[arc] module event-handler rollback after boot failure failed",
      );
    }
    const closeErrors = await teardown.rollback();
    for (const closeError of closeErrors) {
      fastify.log.error(
        { err: closeError },
        "[arc] module onClose rollback after boot failure failed",
      );
    }
    throw err;
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
  //
  // Module closers flow through the teardown controller: best-effort (one
  // throwing module cannot block the rest, nor the app's own onClose) and
  // once-guarded (shared with the boot-rollback path above). The FIRST module
  // close error is rethrown after every closer + the app onClose ran, so
  // `fastify.close()` still reports the failure.
  const appOnClose = config.onClose;
  if (teardown.hasComposedModules() || appOnClose || eventUnsubscribes.length) {
    fastify.addHook("onClose", async () => {
      // Unsubscribe module event handlers FIRST (reverse of subscription
      // order), while module deps are still live — before any module onClose
      // tears the engines they call down.
      const unsubscribeErrors = await unsubscribeModuleEventHandlers(eventUnsubscribes);
      for (const err of unsubscribeErrors) {
        fastify.log.error({ err }, "[arc] module event-handler shutdown unsubscribe failed");
      }
      const closeErrors = await teardown.closeAll();
      for (const err of closeErrors) {
        fastify.log.error({ err }, "[arc] module onClose failed during shutdown");
      }
      if (appOnClose) await appOnClose(fastify);
      if (closeErrors.length > 0) throw closeErrors[0];
    });
  }
}
