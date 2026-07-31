/**
 * Module arm collection — health checks, workflows, scheduled jobs. Every
 * collector takes the `orderModules`-sorted list so contributions land in
 * dependency order, and fails at boot on cross-module name collisions
 * (attributing both owners) instead of silently dropping one.
 */

import type { FastifyInstance } from "fastify";
import { type HealthCheck, mergeHealthChecks } from "../../plugins/health.js";
import type { ScheduleDefinition } from "../../plugins/schedules.js";
import { resolveModuleArm } from "./resolve.js";
import type { ArcModule } from "./types.js";

/**
 * Collect every module's `healthChecks` in the caller's order. Fails at boot
 * on a duplicate check `name` across modules, naming BOTH owning modules.
 * The host's app-level checks are appended AFTER this (modules-first,
 * host-last) by the caller.
 */
export function collectModuleHealthChecks(modules: readonly ArcModule[]): HealthCheck[] {
  return mergeHealthChecks(
    modules.map((module) => ({
      owner: `module "${module.name}"`,
      checks: module.healthChecks,
    })),
  );
}

/**
 * Collect every module's `workflows`. Resolves factory contributions (so a
 * factory can close over a container the caller has already decorated on
 * `fastify`) and flattens to a single opaque array. Arc core deliberately
 * does NOT validate or interpret the values — the streamline integration
 * owns name/shape checks and registration. Called by the integration at init
 * time, not by arc's boot pipeline (workflows depend on the integration's
 * container).
 */
export async function collectModuleWorkflows(
  fastify: FastifyInstance,
  modules: readonly ArcModule[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const m of modules) {
    const wfs = await resolveModuleArm(m, "workflows", m.workflows, fastify);
    out.push(...wfs);
  }
  return out;
}

/**
 * Collect every module's `scheduledJobs`. Resolves factory contributions
 * (after bootstraps) and fails at boot on a duplicate job `name` across
 * modules. The caller passes the returned definitions to the canonical
 * schedules plugin; factories must therefore be resolved only once.
 */
export async function collectModuleScheduledJobs(
  fastify: FastifyInstance,
  modules: readonly ArcModule[],
): Promise<ScheduleDefinition[]> {
  const owner = new Map<string, string>();
  const out: ScheduleDefinition[] = [];
  for (const m of modules) {
    const jobs = await resolveModuleArm(m, "scheduledJobs", m.scheduledJobs, fastify);
    for (const job of jobs) {
      const prior = owner.get(job.name);
      if (prior !== undefined) {
        throw new Error(
          `[arc] duplicate scheduled-job name "${job.name}" — declared by module "${prior}" and module "${m.name}". Scheduled-job names must be unique across the module graph.`,
        );
      }
      owner.set(job.name, m.name);
      out.push(job);
    }
  }
  return out;
}
