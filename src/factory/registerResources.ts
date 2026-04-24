/**
 * Resource registration for createApp.
 *
 * Handles: resourcePrefix, skipGlobalPrefix, bootstrap, afterResources.
 */

import type { FastifyInstance } from "fastify";
import type { ResourceLike } from "./loadResources.js";
import type { FastifyPlugin } from "./shared.js";
import type { CreateAppOptions } from "./types.js";

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
): Promise<void> {
  const name = resource.name ?? "unknown";
  try {
    await parent.register(resource.toPlugin() as FastifyPlugin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parent.log.error(`Failed to register resource "${name}": ${msg}`);
    // Preserve the original via `{ cause }` so adapter / plugin / Mongoose
    // errors keep their stack + any custom properties (statusCode, code,
    // etc.). Before this, the original was dropped — boot failures became
    // "Resource "x" failed to register: foo" with no way to walk back to
    // the real throw site. Node + V8 both render `err.cause` in stacks.
    throw new Error(
      `Resource "${name}" failed to register: ${msg}. ` +
        "Check the resource definition, adapter, and permissions.",
      { cause: err },
    );
  }
}

/**
 * Execute the full resource lifecycle:
 * 1. plugins()                   — infra (DB, docs, webhooks)
 * 2. bootstrap[]                 — domain init (singletons, event handlers)
 * 3. resources factory (if any)  — resolved AFTER bootstrap, so engine-backed
 *                                  adapters can `await ensureEngine()` and pass
 *                                  live models/repos into `defineResource(...)`
 * 4. resources[]                 — register each (split by prefix)
 * 5. afterResources()            — post-registration wiring
 * 6. onReady/onClose             — lifecycle hooks
 */
export async function registerResources(
  fastify: FastifyInstance,
  config: CreateAppOptions,
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

  // ── 1. Custom plugins (infra) ──
  if (config.plugins) {
    await config.plugins(fastify);
    fastify.log.debug("Custom plugins registered");
  }

  // ── 2. Bootstrap (domain init) ──
  if (config.bootstrap?.length) {
    for (const init of config.bootstrap) {
      await init(fastify);
    }
    fastify.log.debug(`${config.bootstrap.length} bootstrap function(s) executed`);
  }

  // ── 3. Resolve resources factory (if supplied) ──
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
      await registerOne(fastify, resource);
    }

    // Prefixed resources register under resourcePrefix (or root if no prefix)
    if (prefixed.length) {
      if (config.resourcePrefix) {
        await fastify.register(
          async (scoped) => {
            for (const resource of prefixed) {
              await registerOne(scoped, resource);
            }
          },
          { prefix: config.resourcePrefix },
        );
      } else {
        for (const resource of prefixed) {
          await registerOne(fastify, resource);
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

  // ── 4. After resources ──
  if (config.afterResources) {
    await config.afterResources(fastify);
    fastify.log.debug("afterResources hook executed");
  }

  // ── 5. Lifecycle hooks ──
  if (config.onReady) {
    const onReady = config.onReady;
    fastify.addHook("onReady", async () => {
      await onReady(fastify);
    });
  }
  if (config.onClose) {
    const onClose = config.onClose;
    fastify.addHook("onClose", async () => {
      await onClose(fastify);
    });
  }
}
