/** Resource registration and the module/app lifecycle for createApp. */

import { createEventRouter } from "@classytic/primitives/events";
import type { FastifyInstance } from "fastify";
import { defineEvent, type EventRegistry } from "../events/defineEvent.js";
import { CRUD_EVENT_SCHEMA } from "../events/eventTypes.js";
import { runShutdown } from "../utils/shutdown.js";
import type { ResourceLike } from "./loadResources.js";
import {
  analyzeModuleGraph,
  buildModuleGraph,
  crudEventsOf,
  type DerivedPublishes,
  type HandlerDurabilityFact,
  type SkippedBridge,
  verifyEventDurability,
  verifyModuleGraph,
} from "./module/graph.js";
import {
  type ArcModule,
  collectModuleScheduledJobs,
  createDisposerRegistry,
  createModuleTeardown,
  describeResolvedModule,
  getOptionalModuleExports,
  initModuleStates,
  setModuleState,
  subscribeModuleEventHandlers,
  unsubscribeModuleEventHandlers,
} from "./module/index.js";
import { composeModules, portsForModule } from "./module/plan.js";
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
  resource: ResourceLike,
  mountRoutes?: boolean,
): Promise<void> {
  const name = resource.name ?? "unknown";
  try {
    // `arcMountRoutes: false` (worker role) registers shared runtime state but
    // mounts no routes. See wiki/factory.md § createWorker.
    await parent.register(
      resource.toPlugin() as FastifyPlugin,
      mountRoutes === false ? { arcMountRoutes: false } : {},
    );
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // ArcError messages already start with `Resource "name"` — strip it (and
    // the trailing period) so the wrapper doesn't repeat it.
    const stripped = rawMsg
      .replace(new RegExp(`^Resource "${name}"\\s*`), "")
      .replace(/\.+\s*$/, "");
    parent.log.error(`Failed to register resource "${name}": ${rawMsg}`);
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
 * 1.  composeModules             — validate the graph (dup names, missing/self
 *                                  deps, cycles, unmet `requires`) BEFORE side effects
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
 * Boot is TRANSACTIONAL for module-held resources: on any failure in phases
 * 2–6, arc unsubscribes live module event handlers, closes every module that
 * ENTERED an init phase (see module/teardown.ts), and rethrows the ORIGINAL
 * boot error.
 */
export async function registerResources(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  preResolvedModules?: readonly ArcModule[],
  skippedBridges: readonly SkippedBridge[] = [],
): Promise<void> {
  // Duplicate resource names fail boot in every preset (usually a stale
  // `dist/` alongside `src/`); an explicit `strictResources: false` downgrades
  // them to a warning and the registry keeps the first. Production also fails
  // boot on an empty `resourceDir`.
  if (config.strictResources === undefined) config = { ...config, strictResources: true };
  if (config.preset === "production") {
    if (config.strictResourceDir === undefined) config = { ...config, strictResourceDir: true };
  }
  if (config.strictResources === false) {
    fastify.arc?.registry?.tolerateDuplicateNames();
  }

  // ── 1. Resolve + validate the module graph FIRST, so a broken composition
  // aborts before `config.plugins` opens any infra. `createApp` passes a
  // pre-resolved graph (so thunks fire exactly once); resolving here is for
  // direct callers (tests, embedded hosts). See wiki/modules.md.
  const modules =
    preResolvedModules ?? (await composeModules(config.modules ?? [], config.ports)).modules;

  // Every module is `resolved` before any callback runs, so
  // `lazyRequiredModuleExports` can validate presence at composition time.
  initModuleStates(
    fastify,
    modules.map((m) => m.name),
  );
  const portsByModule = new Map(modules.map((m) => [m.name, portsForModule(m, config.ports)]));
  const disposers = createDisposerRegistry(fastify, (name) => portsByModule.get(name) ?? {});
  const teardown = createModuleTeardown(fastify, modules, disposers);
  // Declared here so the catch can unsubscribe a partial activation.
  let eventUnsubscribes: Array<() => void | Promise<void>> = [];

  try {
    // ── 2. App plugins (infra: DB, data, webhooks) ──
    if (config.plugins) {
      await config.plugins(fastify);
      fastify.log.debug("Custom plugins registered");
    }

    // ── 3. Module plugins (infra) — after app `plugins()`, before any module
    // bootstrap, in dependsOn order.
    for (const m of modules) {
      if (!m.plugins) continue;
      // Marked BEFORE the call: a `plugins()` that opens a socket and THEN
      // throws must still have its closer run.
      teardown.markInitialized(m);
      try {
        // A returned disposer is shorthand for a single `defer` — registered
        // last, so it unwinds before anything the phase deferred by hand.
        const returned = await m.plugins(fastify, disposers.contextFor(m.name));
        if (typeof returned === "function") {
          assertNotAReturnedPlugin(returned, m.name, fastify);
          disposers.contextFor(m.name).defer(returned);
        }
      } catch (err) {
        setModuleState(fastify, m.name, "failed");
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[arc] module "${m.name}" plugins() threw: ${msg}`, { cause: err });
      }
    }

    // ── 4. Bootstrap — modules (dependsOn order) then app-level, so app init
    // can depend on a module's live engine.
    for (const m of modules) {
      if (!m.bootstrap) {
        // Still teardown-eligible, so a resource-only module's `onClose` runs.
        setModuleState(fastify, m.name, "ready");
        teardown.markInitialized(m);
        continue;
      }
      let exported: unknown;
      // Marked before the call — same reason as `plugins` above.
      teardown.markInitialized(m);
      setModuleState(fastify, m.name, "bootstrapping");
      try {
        exported = await m.bootstrap(fastify, disposers.contextFor(m.name));
      } catch (err) {
        setModuleState(fastify, m.name, "failed");
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[arc] module "${m.name}" bootstrap threw: ${msg}`, { cause: err });
      }
      setModuleState(fastify, m.name, "ready");
      if (exported !== undefined) {
        const arc = fastify.arc;
        if (!arc) {
          // Throw, don't guard — otherwise the export would vanish silently.
          throw new Error(
            `[arc] module "${m.name}" returned a public export but fastify.arc is not decorated — arcCorePlugin must register first.`,
          );
        }
        // Null prototype: a module named "__proto__" must be an own key.
        if (!arc.modules) arc.modules = Object.create(null) as Record<string, unknown>;
        arc.modules[m.name] = exported;
      }
    }
    if (modules.length) {
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

    // ── 5. Resolve resources factory — runs AFTER bootstrap so adapters get
    // booted engines. A throw is fail-fast, not a best-effort skip.
    let resolvedResources: ReadonlyArray<ResourceLike> | undefined;
    if (isResourcesFactory(config.resources)) {
      try {
        resolvedResources = await config.resources(fastify);
        if (!Array.isArray(resolvedResources)) {
          throw new TypeError(
            "resources factory must return an array — received " +
              `${resolvedResources === null ? "null" : typeof resolvedResources}`,
          );
        }
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

    // ── 5'. resourceDir discovery — only when `resources` is ABSENT. An
    // explicit `resources` (including `[]` or a factory returning `[]`) always
    // wins; test for `undefined`, never `!length`.
    //
    // The raw + resolved path are kept so the final summary can echo them.
    let discoveryRawDir: string | undefined;
    let discoveryPath: string | undefined;
    let discoveryYieldedZero = false;
    if (resolvedResources === undefined && config.resourceDir) {
      const { loadResources } = await import("./loadResources.js");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      // Accepts `import.meta.url` (resolves correctly under `dist/`) or a path
      // relative to process.cwd().
      const rawDir = config.resourceDir;
      const dir = rawDir.startsWith("file://") ? dirname(fileURLToPath(rawDir)) : resolve(rawDir);
      discoveryRawDir = rawDir;
      discoveryPath = dir;
      const discovered = await loadResources(dir, { logger: fastify.log });
      if (discovered.length === 0) {
        // Non-strict: no WARN here — the final zero-count summary is the
        // single diagnostic.
        if (config.strictResourceDir) {
          throw new Error(
            `[arc] loadResources: resourceDir "${rawDir}" resolved to "${dir}" but ` +
              "yielded 0 resources. Check the path, file naming (*.resource.{ts,js,mts,mjs}), " +
              "and runtime layout (src/ vs dist/).",
          );
        }
        discoveryYieldedZero = true;
      }
      resolvedResources = discovered;
    }

    // ── 5a. Module resources — RESOLVE here, after app resources (so
    // `resources: []` semantics stay untouched), but REGISTER first (prepended
    // below). Must precede 5b so `owns` is checked against what each module
    // actually SUPPLIES — otherwise a bad claim deletes a route with nothing
    // replacing it.
    const moduleResourceNames = new Map<string, Set<string>>();
    const perModuleResources = new Map<string, readonly ResourceLike[]>();
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
      // Validate here, where the culprit module is still known — otherwise a
      // bad return surfaces later as an unattributed "is not iterable".
      if (!Array.isArray(rs)) {
        throw new TypeError(
          `[arc] module "${m.name}" resources factory must return an array — received ` +
            `${rs === null ? "null" : typeof rs}.`,
        );
      }
      // Duplicates WITHIN one module are always a bug, so unlike the app-wide
      // check below this ignores `strictResources: false`.
      const names = new Set<string>();
      for (const r of rs) {
        if (r.name == null) continue;
        if (names.has(r.name)) {
          throw new Error(
            `[arc] module "${m.name}" provides two resources named "${r.name}". ` +
              "Resource names must be unique within a module — arc registers one route group " +
              "per name, so the second would be dropped.",
          );
        }
        names.add(r.name);
      }
      moduleResourceNames.set(m.name, names);
      perModuleResources.set(m.name, rs);
      moduleResources.push(...rs);
    }

    // ── 5b. Module ownership — verify the claim, THEN drop app forks ──
    //
    // Verified unconditionally (not gated by `strictResources`): an unmet claim
    // would silently delete the app's route with nothing serving it. The claim
    // must be met by the CLAIMING module itself, keeping ownership local.
    // `owns: "provided"` derives the claim, so it cannot disagree at all.
    const effectiveOwns = new Map<string, readonly string[]>();
    for (const m of modules) {
      const supplied = moduleResourceNames.get(m.name);
      if (m.owns === "provided") {
        if (!supplied?.size) {
          throw new Error(
            `[arc] module "${m.name}" declares \`owns: "provided"\` but supplies no named ` +
              "resources. Either give it resources to own, or drop the `owns` entry — an empty " +
              "claim is almost always a resources factory that returned early.",
          );
        }
        effectiveOwns.set(m.name, [...supplied]);
        continue;
      }
      if (!m.owns?.length) continue;
      const missing = m.owns.filter((name) => !supplied?.has(name));
      if (missing.length > 0) {
        const provided = supplied?.size ? [...supplied].join(", ") : "(none)";
        throw new Error(
          `[arc] module "${m.name}" declares owns: [${missing.map((n) => `"${n}"`).join(", ")}] ` +
            "but its own `resources` do not supply " +
            `${missing.length === 1 ? "that name" : "those names"}. ` +
            "`owns` DROPS the app-level resource of that name, so an unmet claim removes the " +
            "route entirely and nothing serves it. Provide it in this module's `resources`, " +
            'drop the `owns` entry, or use `owns: "provided"` to derive it.\n' +
            `Resources supplied by "${m.name}": ${provided}.`,
        );
      }
      effectiveOwns.set(m.name, m.owns);
    }

    if (modules.length && resolvedResources && resolvedResources.length > 0) {
      const owned = new Set<string>();
      for (const m of modules) {
        for (const name of effectiveOwns.get(m.name) ?? []) owned.add(name);
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

    // Descriptors are published at §6c, not here — the contribution counts
    // aren't known yet and would freeze at zero.

    if (resolvedResources && resolvedResources.length > 0) {
      // Detect duplicate resource names early — a common mistake with loadResources + manual array
      const seen = new Set<string>();
      for (const resource of resolvedResources) {
        if (resource.name) {
          if (seen.has(resource.name)) {
            const msg =
              `Duplicate resource name "${resource.name}" detected. ` +
              "This will cause route conflicts. Check your resources array and loadResources() output. " +
              "Common cause: stale compiled files in dist/ alongside src/.";
            if (config.strictResources) {
              throw new Error(msg);
            }
            fastify.log.warn(`${msg} Boot continues because strictResources is false.`);
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
      // Always announce N=0, as a WARN — a silent zero-resource boot is a
      // deploy that 404s everything. Discovery hints fold into this ONE line.
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
    for (const m of modules) {
      if (!m.afterResources) continue;
      try {
        // Every module is teardown-eligible by now, so these disposers sweep too.
        const returned = await m.afterResources(fastify, disposers.contextFor(m.name));
        if (typeof returned === "function") disposers.contextFor(m.name).defer(returned);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[arc] module "${m.name}" afterResources() threw: ${msg}`, { cause: err });
      }
    }
    // Schedules BEFORE event activation, so an invalid schedule config cannot
    // leave already-subscribed handlers behind.
    const scheduleCounts = new Map<string, number>();
    const collectedJobs = await collectModuleScheduledJobs(fastify, modules, scheduleCounts);
    /**
     * ROLE gate: arms this role does not run are skipped and logged, never
     * fatal — another deployment of the same codebase runs them.
     */
    const role = config.role ?? "all";
    const scheduledJobs =
      role === "scheduler" || role === "all"
        ? collectedJobs
        : role === "relay"
          ? collectedJobs.filter((j) => j.kind === "relay")
          : [];
    const skipped = collectedJobs.filter((j) => !scheduledJobs.includes(j));
    if (skipped.length > 0) {
      fastify.log.info(
        { role, skipped: skipped.map((j) => j.name) },
        `[arc] role '${role}': ${skipped.length} schedule arm(s) not mounted here — a ` +
          "deployment with the owning role runs them",
      );
    }
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

    // The helper rolls back its own partial activation; the outer catch covers
    // failures after full activation.
    const subscriptionCounts = new Map<string, number>();
    const consumedByModule = new Map<string, string[]>();
    const handlersByModule = new Map<string, HandlerDurabilityFact[]>();
    eventUnsubscribes = await subscribeModuleEventHandlers(
      fastify,
      modules,
      subscriptionCounts,
      consumedByModule,
      handlersByModule,
    );

    // ── 6b'. The module graph — who owns which event, who consumes it — checked here, where
    // every handler is resolved; a strict failure throws into the rollback below.
    // CRUD events arc auto-emits are DERIVED from what mounted — a module owns its resources'
    // events; an app-level resource's events count as external publishers.
    const registry = fastify.arc?.registry;
    const emitsCrud = config.arcPlugins?.emitEvents !== false && registry !== undefined;
    const derived = new Map<string, DerivedPublishes>();
    const moduleOwned = new Set<string>();
    if (emitsCrud) {
      for (const [moduleName, names] of moduleResourceNames) {
        const publishes: string[] = [];
        for (const name of names) {
          moduleOwned.add(name);
          const entry = registry.get(name);
          if (entry) publishes.push(...crudEventsOf(entry));
        }
        derived.set(moduleName, { publishes, namespaces: [...names] });
      }
    }
    const appCrudEvents = emitsCrud
      ? registry
          .getAll()
          .filter((e) => !moduleOwned.has(e.name))
          .flatMap((e) => crudEventsOf(e))
      : [];
    // Every mounted CRUD event gets a registry entry with arc's envelope — so every published
    // event has a contract. A host's own definition of the same name is never replaced.
    const eventRegistry = (fastify as { events?: { registry?: EventRegistry } }).events?.registry;
    if (emitsCrud && eventRegistry) {
      for (const entry of registry.getAll()) {
        for (const name of crudEventsOf(entry)) {
          if (eventRegistry.get(name)) continue;
          eventRegistry.register(
            defineEvent({
              name,
              description: `arc CRUD event — a ${entry.name} was ${name.slice(entry.name.length + 1)}.`,
              schema: CRUD_EVENT_SCHEMA as never,
            }),
          );
        }
      }
    }
    const moduleGraph = buildModuleGraph(
      modules,
      consumedByModule,
      skippedBridges,
      [...(config.moduleGraph?.externalEvents ?? []), ...ARC_OWNED_EVENTS, ...appCrudEvents],
      derived,
    );
    for (const bridge of moduleGraph.skippedBridges) {
      fastify.log.info(
        { bridge: bridge.name, missing: bridge.missing },
        "[arc] bridge module inactive — a module it joins is not composed",
      );
    }
    // Production verifies event ownership by default — it reports, never blocks; explicit wins.
    const graphMode =
      config.moduleGraph?.events ?? (config.preset === "production" ? "warn" : "off");
    if (graphMode !== "off") {
      const analysis = analyzeModuleGraph(moduleGraph);
      const issues = verifyModuleGraph(moduleGraph, analysis);
      if (issues.length > 0 && graphMode === "strict") {
        throw new Error(
          `[arc] module graph has ${issues.length} issue(s):\n${issues.map((i) => `  - ${i.message}`).join("\n")}`,
        );
      }
      for (const issue of issues)
        fastify.log.warn({ issue }, `[arc] module graph: ${issue.message}`);
      // Strict applies to durability declarations too; warn remains migration-friendly.
      const outboxModules = new Set(
        modules
          .filter((m) => isTransactionalOutbox(getOptionalModuleExports(fastify, m.name)))
          .map((m) => m.name),
      );
      const durabilityIssues = verifyEventDurability(modules, {
        outboxModules,
        handlers: handlersByModule,
      });
      if (durabilityIssues.length && graphMode === "strict") {
        throw new Error(
          `[arc] module graph durability has ${durabilityIssues.length} issue(s):\n${durabilityIssues.map((i) => `  - ${i.message}`).join("\n")}`,
        );
      }
      for (const issue of durabilityIssues)
        fastify.log.warn({ issue }, `[arc] module graph (${issue.code}): ${issue.message}`);
    }
    if (fastify.arc) fastify.arc.moduleGraph = moduleGraph;

    // ── 6b''. What is DECLARED is checked above; what is actually PUBLISHED is watched here.
    // The events plugin can be disabled, so the facade is checked at runtime.
    const events = (fastify as { events?: { observe?: unknown } }).events;
    if (graphMode !== "off" && typeof events?.observe === "function" && fastify.arc) {
      const undeclared = watchUndeclaredEvents(fastify, moduleGraph, graphMode);
      fastify.arc.undeclaredEvents = undeclared;
    }

    // ── 6c. Publish resolved descriptors — consumers read these, not the
    // AUTHORING shape (factories hide names; `owns` may be "provided"). Counts
    // come from the collectors' sinks: never re-run host factories.
    if (fastify.arc) {
      fastify.arc.moduleDescriptors = Object.freeze(
        modules.map((m) =>
          describeResolvedModule({
            name: m.name,
            dependsOn: m.dependsOn,
            resources: perModuleResources.get(m.name) ?? [],
            owns: effectiveOwns.get(m.name) ?? [],
            lifecycle: {
              hasClose: typeof m.onClose === "function",
              subscriptions: subscriptionCounts.get(m.name) ?? 0,
              scheduledJobs: scheduleCounts.get(m.name) ?? 0,
              healthChecks: m.healthChecks?.length ?? 0,
              exports: typeof m.bootstrap === "function",
            },
          }),
        ),
      );
    }

    if (config.afterResources) {
      await config.afterResources(fastify);
      fastify.log.debug("afterResources hook executed");
    }
  } catch (err) {
    // ── Boot rollback ── the §7b hook doesn't exist yet. Mirrors shutdown:
    // unsubscribe handlers, then close modules. Secondary failures are logged;
    // the ORIGINAL boot error is rethrown.
    const shutdownErrors = await runShutdown(fastify);
    for (const shutdownError of shutdownErrors)
      fastify.log.error({ err: shutdownError }, "[arc] runtime rollback failed");
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
  // `onClose`, in ONE hook. Fastify runs `onClose` LIFO, so two hooks would
  // close the app (and its shared DB/Redis) before modules finish flushing.
  // Registering it LAST makes it fire before `config.plugins` infra closes.
  //
  // Closers are best-effort and once-guarded (shared with rollback); the FIRST
  // module error is rethrown after everything ran, so `fastify.close()` fails.
  const appOnClose = config.onClose;
  if (teardown.hasComposedModules() || appOnClose || eventUnsubscribes.length) {
    fastify.addHook("onClose", async () => {
      const shutdownErrors = await runShutdown(fastify);
      // Unsubscribe FIRST, while the engines handlers call are still live.
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
      if (shutdownErrors.length > 0) throw shutdownErrors[0];
    });
  }
}

/**
 * `plugins()` is CALLED by arc, never `register()`ed — a returned Fastify
 * plugin would be silently treated as a disposer. `fp()` markers are
 * unambiguous, so that throws; a bare 2+-arg function only warns.
 */
function assertNotAReturnedPlugin(
  returned: (...args: never[]) => unknown,
  moduleName: string,
  fastify: FastifyInstance,
): void {
  const fn = returned as unknown as Record<symbol, unknown>;
  const isFastifyPlugin =
    fn[Symbol.for("skip-override")] !== undefined ||
    fn[Symbol.for("plugin-meta")] !== undefined ||
    fn[Symbol.for("fastify.display-name")] !== undefined;

  if (isFastifyPlugin) {
    throw new Error(
      `[arc] module "${moduleName}" returned a fastify-plugin from plugins(). That slot is a ` +
        "SETUP function arc calls directly — it is never passed to fastify.register(), so the " +
        "returned value is read as a disposer and your plugin would be invoked at shutdown " +
        "instead of registered at boot. Register it yourself: " +
        "`plugins: async (fastify) => { await fastify.register(myPlugin) }`.",
    );
  }

  if (returned.length >= 2) {
    fastify.log?.warn?.(
      `[arc] module "${moduleName}" returned a ${returned.length}-argument function from ` +
        "plugins(). Arc calls disposers with NO arguments, so this looks like a Fastify plugin " +
        "that was meant to be registered (`await fastify.register(fn)`) rather than a teardown " +
        "callback. If it really is a disposer, declare it with no parameters.",
    );
  }
}

/** Namespaces arc itself publishes — lifecycle (`arc.*`) and its streamline integration (`workflow.*`). */
const ARC_OWNED_EVENTS = ["arc.*", "workflow.*"] as const;

/**
 * Record every published event type the graph has no owner for. Logs each name once; never
 * touches delivery.
 */
function watchUndeclaredEvents(
  fastify: FastifyInstance,
  graph: import("./module/graph.js").ModuleGraph,
  mode: "strict" | "warn",
): ReadonlySet<string> {
  const owned = new Set(graph.modules.flatMap((m) => m.publishes));
  const external = createEventRouter<true>();
  for (const pattern of graph.externalEvents) external.add(pattern, true);
  const undeclared = new Set<string>();
  const stop = fastify.events.observe((event) => {
    const type = event.type;
    if (owned.has(type) || undeclared.has(type) || type.startsWith("$")) return;
    if (external.route(type).length > 0) return;
    undeclared.add(type);
    fastify.log[mode === "strict" ? "error" : "warn"](
      { event: type },
      `[arc] module graph: "${type}" was published but no module declares it — add it to its owner's \`publishes\` (or \`moduleGraph.externalEvents\`).`,
    );
  });
  fastify.addHook("onClose", async () => stop());
  return undeclared;
}

/** A module export that is an outbox whose `save` enlists the caller's session. */
function isTransactionalOutbox(exports: unknown): boolean {
  if (typeof exports !== "object" || exports === null || !("store" in exports)) return false;
  const store: unknown = exports.store;
  return (
    typeof store === "object" &&
    store !== null &&
    "transactionalSave" in store &&
    store.transactionalSave === true
  );
}
