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
    const isModuleNotFound =
      err.message.includes("Cannot find module") ||
      err.message.includes("Cannot find package") ||
      err.message.includes("MODULE_NOT_FOUND") ||
      err.message.includes("Could not resolve");

    if (isModuleNotFound && entry.optional) {
      logger?.warn(`Optional plugin '${name}' skipped (${entry.package} not installed)`);
      return null;
    }

    if (isModuleNotFound) {
      throw new Error(
        `Plugin '${name}' requires package '${entry.package}' which is not installed.\n` +
          `Install it with: npm install ${entry.package}\n` +
          `Or disable this plugin by setting ${name}: false in createApp options.`,
      );
    }

    throw new Error(`Failed to load plugin '${name}': ${err.message}`);
  }
}
