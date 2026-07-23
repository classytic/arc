/**
 * createWorker — the headless process role (2.23). The paved road over two
 * public primitives any host may use directly instead:
 *
 *   1. `mountRoutes: false`  — resources register runtime state, mount nothing
 *   2. `preset: 'worker'`    — HTTP-surface flags off (host-overridable)
 *
 * One options object, two process shapes:
 *
 * ```ts
 * // server.ts                          // worker.ts
 * createApp(createArcAppOptions());     createWorker(createArcAppOptions());
 * ```
 *
 * The worker runs the SAME boot pipeline as the API role — beforeBoot,
 * module plugins/bootstrap/afterResources/onClose, events, jobs processors,
 * schedules, caching, audit, usage — and skips the HTTP surface (routes,
 * helmet/cors/rate-limit, docs/MCP, auth incl. the Better Auth thunk, which
 * never runs). Roles cannot drift because there is no second pipeline
 * (the n8n three-copy-paste-entrypoints lesson, inverted).
 *
 * K8s-style probes are opt-in: `{ health: { port } }` binds the worker's
 * ONLY listener, serving arc's standard `healthPlugin` (`/_health/live`,
 * `/_health/ready` + host `checks`) — uniform probes across the fleet, no
 * security stack needed because there is no other surface.
 *
 * Deployment/compat answers live in wiki/factory.md § createWorker.
 */

import type { FastifyInstance } from "fastify";
import type { HealthCheck, HealthOptions } from "../plugins/health.js";
import { healthPlugin, mergeHealthChecks } from "../plugins/health.js";
import { createApp } from "./createApp.js";
import { getModuleExports } from "./module/index.js";
import { workerPreset } from "./presets.js";
import type { CreateAppOptions } from "./types/index.js";

export interface WorkerHealthOptions {
  /** Port for the worker's ONLY listener (liveness/readiness probes). */
  port: number;
  /** Bind host. Default `0.0.0.0`. */
  host?: string;
  /** Readiness checks — same contract as the API role's healthPlugin. */
  checks?: HealthCheck[];
}

export interface CreateWorkerOptions {
  /** Opt-in probe listener. Omit = the worker binds NOTHING. */
  health?: WorkerHealthOptions;
}

export interface ArcWorker {
  /** The underlying Fastify instance (decorations, inject, logs). */
  app: FastifyInstance;
  /** Typed module-export accessor — same contract as `getModuleExports`. */
  exports<TExports = unknown>(name: string): TExports;
  /** Close app → module onClose (reverse) → app onClose. Idempotent. */
  close(): Promise<void>;
}

export async function createWorker(
  options: CreateAppOptions,
  workerOptions: CreateWorkerOptions = {},
): Promise<ArcWorker> {
  // The sugar's contract is "the SAME options object as the API role just
  // works" — so the HTTP-surface keys the API role configured (auth, cors,
  // helmet, ...) are STRIPPED here; otherwise createApp's explicit-wins
  // preset merge would re-enable them on the worker. Hosts that genuinely
  // want auth/cors/etc. on a worker use the primitives directly
  // (`createApp({ preset: 'worker', ...overrides })`) — the paved road is
  // opinionated, the primitives are not.
  const {
    auth: _auth,
    helmet: _helmet,
    cors: _cors,
    rateLimit: _rateLimit,
    multipart: _multipart,
    rawBody: _rawBody,
    sensible: _sensible,
    underPressure: _underPressure,
    replyHelpers: _replyHelpers,
    ...runtimeOptions
  } = options;

  const sharedHealth: HealthOptions =
    typeof runtimeOptions.arcPlugins?.health === "object" &&
    runtimeOptions.arcPlugins.health !== null
      ? runtimeOptions.arcPlugins.health
      : {};

  const workerArcPlugins = {
    ...workerPreset.arcPlugins,
    ...runtimeOptions.arcPlugins,
    // A dedicated worker probe is the single health-plugin registration.
    // Shared API health options are merged into that probe below.
    ...(workerOptions.health ? { health: false as const } : {}),
  };

  // arcPlugins merges deep (createApp's preset merge is shallow — a host
  // arcPlugins object would clobber the preset's off-switches wholesale).
  // Host keys still win per-key: `arcPlugins: { metrics: true }` re-enables
  // Prometheus on this worker.
  const app = await createApp({
    ...runtimeOptions,
    preset: "worker",
    arcPlugins: workerArcPlugins,
  });

  if (workerOptions.health) {
    const { port, host = "0.0.0.0", checks = [] } = workerOptions.health;
    // The worker preset disables the MAIN health plugin, so this probe is the
    // single registration — feed it the SAME module-contributed checks the API
    // role gets (collected + frozen by createApp on `arc.healthChecks`),
    // modules-first then the worker's own probe checks.
    const moduleChecks = app.arc?.healthChecks ?? [];
    const mergedChecks = mergeHealthChecks([
      { owner: "the module graph", checks: moduleChecks },
      { owner: "shared arcPlugins.health", checks: sharedHealth.checks },
      { owner: "the worker probe", checks },
    ]);
    await app.register(healthPlugin, {
      ...sharedHealth,
      checks: mergedChecks,
    });
    await app.listen({ port, host });
  } else {
    await app.ready();
  }

  let closed = false;
  return {
    app,
    exports: <TExports = unknown>(name: string) => getModuleExports<TExports>(app, name),
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}
