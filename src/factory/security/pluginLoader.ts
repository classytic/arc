/**
 * Optional-dependency plugin loader — name → { package, loader, optional }
 * registry plus the resolution wrapper with actionable error messages.
 *
 * Pure infrastructure: knows nothing about WHY a plugin is being loaded.
 * Policy (which plugins, with which options, in which order) lives in
 * `../registerSecurity.ts`.
 */

import type { FastifyPlugin } from "../shared.js";

// Plugin registry: name → { package, loader, optional }
const PLUGIN_REGISTRY: Record<
  string,
  {
    package: string;
    loader: () => Promise<FastifyPlugin>;
    optional?: boolean;
  }
> = {
  cors: {
    package: "@fastify/cors",
    loader: () => import("@fastify/cors").then((m) => m.default),
  },
  helmet: {
    package: "@fastify/helmet",
    loader: () => import("@fastify/helmet").then((m) => m.default),
  },
  rateLimit: {
    package: "@fastify/rate-limit",
    loader: () => import("@fastify/rate-limit").then((m) => m.default),
  },
  underPressure: {
    package: "@fastify/under-pressure",
    loader: () => import("@fastify/under-pressure").then((m) => m.default),
  },
  sensible: {
    package: "@fastify/sensible",
    loader: () => import("@fastify/sensible").then((m) => m.default),
  },
  multipart: {
    package: "@fastify/multipart",
    loader: () => import("@fastify/multipart").then((m) => m.default),
    optional: true,
  },
  rawBody: {
    package: "fastify-raw-body",
    loader: () => import("fastify-raw-body").then((m) => m.default),
    optional: true,
  },
  static: {
    package: "@fastify/static",
    loader: () => import("@fastify/static").then((m) => m.default),
    optional: true,
  },
};

/**
 * Fail ONCE with every missing package, before any plugin registers.
 *
 * Without this the first absent package throws and the operator installs it,
 * restarts, hits the next one, and repeats — six restarts to discover a peer
 * set that was pruned as a unit. These are OPTIONAL peers of arc, so nothing
 * at install or build time says they are gone; the first signal is a boot
 * crash naming exactly one of them.
 *
 * Required-ness is read from `PLUGIN_REGISTRY` (`!optional`), never a second
 * list — a hand-maintained copy is what goes stale the day a plugin is added.
 * Optional plugins are deliberately NOT preflighted: their absence is a
 * supported configuration, and `loadPlugin` already warns and skips.
 *
 * A plugin the host disabled (`{ helmet: false }`) is not checked — refusing to
 * boot over a package for a plugin nobody asked for would be the opposite of
 * helpful.
 */
export async function preflightPlugins(
  config: Record<string, unknown>,
  options: {
    /**
     * Resolver override. Production passes nothing; tests inject one because a
     * module-resolution failure cannot be faked through the mock system — the
     * mocker replaces the thrown error, so the `code` never survives.
     */
    load?: (name: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const { load } = options;
  const required = Object.entries(PLUGIN_REGISTRY).filter(
    ([name, entry]) => !entry.optional && config[name] !== false,
  );

  const results = await Promise.allSettled(
    required.map(([name, entry]) => (load ? load(name) : entry.loader())),
  );

  const missing: Array<{ name: string; package: string }> = [];
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    const [name, entry] = required[i] as [string, (typeof PLUGIN_REGISTRY)[string]];
    if (!isModuleNotFound(result.reason as Error)) {
      // A package that EXISTS but throws on import is a different fault, and
      // reporting it as "not installed" sends the operator to reinstall a
      // package that is already there. Surface it as-is.
      throw new Error(`Failed to load plugin '${name}': ${(result.reason as Error).message}`);
    }
    missing.push({ name, package: entry.package });
  }

  if (missing.length === 0) return;

  const packages = missing.map((m) => m.package);
  throw new Error(
    `arc cannot start: ${missing.length} required plugin package(s) are not installed.\n` +
      missing.map((m) => `  - ${m.package}  (plugin '${m.name}')`).join("\n") +
      `\n\nInstall all of them:\n  npm install ${packages.join(" ")}\n` +
      `\nOr disable the plugins you do not need in createApp options: ` +
      missing.map((m) => `${m.name}: false`).join(", "),
  );
}

/** Shared by the preflight and the per-plugin loader so they agree on what "missing" means. */
function isModuleNotFound(err: Error): boolean {
  /**
   * CODE first, message second. Node sets `ERR_MODULE_NOT_FOUND` (ESM) or
   * `MODULE_NOT_FOUND` (CJS) on a real resolution failure; the message text
   * varies by Node version, loader and bundler, so matching it alone is a
   * predicate that silently stops matching after an upgrade — and this one
   * decides between "install a package" and "your plugin crashed".
   */
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const m = err?.message ?? "";
  return (
    m.includes("Cannot find module") ||
    m.includes("Cannot find package") ||
    m.includes("MODULE_NOT_FOUND") ||
    m.includes("Could not resolve")
  );
}

/**
 * Load a plugin from the registry with helpful error messages.
 *
 * Required plugins throw if their package can't be resolved; optional
 * plugins return `null` after logging a warning. Overloads expose the
 * stronger return shape to callers so they don't need non-null assertions.
 */
export async function loadPlugin(
  name: "helmet" | "cors" | "rateLimit" | "underPressure" | "sensible",
  logger?: { warn: (msg: string) => void },
): Promise<FastifyPlugin>;
export async function loadPlugin(
  name: "multipart" | "rawBody" | "static",
  logger?: { warn: (msg: string) => void },
): Promise<FastifyPlugin | null>;
export async function loadPlugin(
  name: string,
  logger?: { warn: (msg: string) => void },
): Promise<FastifyPlugin | null>;
export async function loadPlugin(
  name: string,
  logger?: { warn: (msg: string) => void },
): Promise<FastifyPlugin | null> {
  const entry = PLUGIN_REGISTRY[name];
  if (!entry) {
    throw new Error(`Unknown plugin: ${name}`);
  }

  try {
    return await entry.loader();
  } catch (error) {
    const err = error as Error;
    const notFound = isModuleNotFound(err);

    if (notFound && entry.optional) {
      logger?.warn(`Optional plugin '${name}' skipped (${entry.package} not installed)`);
      return null;
    }

    if (notFound) {
      throw new Error(
        `Plugin '${name}' requires package '${entry.package}' which is not installed.\n` +
          `Install it with: npm install ${entry.package}\n` +
          `Or disable this plugin by setting ${name}: false in createApp options.`,
      );
    }

    throw new Error(`Failed to load plugin '${name}': ${err.message}`);
  }
}
