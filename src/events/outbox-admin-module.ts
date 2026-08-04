/**
 * Outbox operator surface — health, dead-letter inspection, replay.
 *
 * The outbox relays domain events (an order's payment → a ledger entry, a stock
 * move → a storefront sync) with retry and a dead-letter queue. Without a
 * surface, a dead-lettered event is invisible until someone notices the books
 * do not reconcile — the relay is working correctly and the event is simply
 * gone. This module makes that state operable:
 *
 *   GET  {prefix}/health                  → pending, dead-letter, relay lag
 *   GET  {prefix}/dead-letter?limit=100   → the stuck events and their errors
 *   POST {prefix}/dead-letter/:id/replay  → requeue one, then drain
 *
 * ## Why this lives in arc
 *
 * Every read it performs is on `OutboxStore`, and the relay comes from the
 * outbox module's own exports. Nothing here knows what a domain is, so any arc
 * app with an outbox wants exactly this. Kept in an app it would be rebuilt per
 * deployment, each slightly differently, with no test that notices.
 *
 * Storage-agnostic by construction: the store is a PORT. There is no query, no
 * driver and no collection name in this file — Mongo, Postgres and the in-memory
 * store are all served by the same code.
 *
 * ## The store type is narrowed on purpose
 *
 * `OutboxStore` declares these four reads OPTIONAL so a minimal store can
 * implement the floor and no more. An admin surface cannot be built on `?.`:
 * `store.requeue?.(id)` evaluates to `undefined` when the method is absent, so
 * the route would answer 200 with a replay that never happened, and
 * `getDeadLettered?.()` would render an empty list — "nothing is stuck" — for a
 * store that merely cannot answer the question. Absence of an answer is not a
 * negative answer, so `OutboxAdminStore` requires the four and a store lacking
 * them fails to compile instead.
 */

import { defineResource } from "../core/defineResource.js";
import { defineModule } from "../factory/module/index.js";
import { getModuleExports } from "../factory/module/index.js";
import type { ArcModule } from "../factory/module/types.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import type { OutboxStore } from "@classytic/primitives/outbox";
import type { OutboxModuleExports } from "./outbox-module.js";

/**
 * A store that can answer an operator's questions.
 *
 * Only the four reads this surface actually performs are required — `fail` and
 * `purge` belong to the relay and retention, not here.
 */
export type OutboxAdminStore = OutboxStore &
  Required<
    Pick<OutboxStore, "getDeadLettered" | "requeue" | "countByStatus" | "oldestPendingAgeMs">
  >;

export interface OutboxAdminPermissions {
  /** Reading health and the dead-letter list. */
  view: PermissionCheck;
  /**
   * Replaying a dead-lettered event. Defaults to `view` when omitted — but
   * replay RE-DELIVERS an event that already failed five times, so a
   * deployment that separates read access from operational action should gate
   * it distinctly.
   */
  replay?: PermissionCheck;
}

export interface OutboxAdminModuleDeps {
  store: OutboxAdminStore;
  permissions: OutboxAdminPermissions;
  /** Route prefix. Default `/admin/outbox`. */
  prefix?: string;
  /** Module name. Default `outbox-admin`. */
  moduleName?: string;
  /**
   * Name the outbox module was composed under, used to resolve the relay and
   * declared as a `dependsOn` edge. Default `outbox`.
   */
  outboxModuleName?: string;
  /** Resource names this module supersedes. */
  owns?: readonly string[];
  /** Cap on `?limit`. Default 500 — a dead-letter list is for triage, not export. */
  maxDeadLetterLimit?: number;
}

export function createOutboxAdminModule(deps: OutboxAdminModuleDeps): ArcModule<void> {
  const moduleName = deps.moduleName ?? "outbox-admin";
  const outboxModuleName = deps.outboxModuleName ?? "outbox";
  const maxLimit = deps.maxDeadLetterLimit ?? 500;
  const view = deps.permissions.view;
  const replay = deps.permissions.replay ?? deps.permissions.view;

  const resource = defineResource({
    name: moduleName,
    displayName: "Outbox Admin",
    tag: "Operations",
    prefix: deps.prefix ?? "/admin/outbox",
    // Operations API over an injected port — no model, no persistence of its own.
    customRoutesOnly: true,
    routes: [
      {
        method: "GET",
        path: "/health",
        summary: "Outbox health — pending, dead-letter and relay lag",
        permissions: view,
        rawHandler: async (_req: FastifyRequest, reply: FastifyReply) => {
          const [pending, deadLetter, relayLagMs] = await Promise.all([
            deps.store.countByStatus("pending"),
            deps.store.countByStatus("dead_letter"),
            deps.store.oldestPendingAgeMs(),
          ]);
          // `healthy` keys off the dead-letter count alone: a backlog of pending
          // events is a relay that is behind, which `relayLagMs` reports; a
          // dead-lettered event is one nothing will retry.
          return reply.send({ pending, deadLetter, relayLagMs, healthy: deadLetter === 0 });
        },
      },
      {
        method: "GET",
        path: "/dead-letter",
        summary: "List dead-lettered events with their errors",
        permissions: view,
        rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          const raw = (req.query as { limit?: string } | undefined)?.limit;
          const parsed = Number(raw ?? 100);
          const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 100, 1), maxLimit);
          const events = await deps.store.getDeadLettered(limit);
          return reply.send({ count: events.length, limit, events });
        },
      },
      {
        method: "POST",
        path: "/dead-letter/:id/replay",
        summary: "Requeue a dead-lettered event and drain the relay",
        permissions: replay,
        rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          const eventId = (req.params as { id?: string } | undefined)?.id;
          if (!eventId) throw new ValidationError("event id is required");

          const requeued = await deps.store.requeue(eventId);
          // `requeue` returns false for an unknown id AND for one that is no
          // longer dead-lettered. Both mean "there was nothing to replay", and
          // reporting success would tell an operator the event is on its way.
          if (!requeued) {
            throw new NotFoundError(
              `Dead-lettered event "${eventId}" — not found, or not currently dead-lettered`,
            );
          }

          // Drain on demand so the operator sees the outcome now rather than at
          // the next relay tick. This delivers the whole pending batch, not just
          // this event — the relay has no single-event mode, and draining more
          // than was asked for is the harmless direction.
          const { relay } = getModuleExports<OutboxModuleExports>(
            req.server as never,
            outboxModuleName,
          );
          const relayDelivered = await relay.relay();
          return reply.send({ eventId, requeued: true, relayDelivered });
        },
      },
    ],
  });

  return defineModule<void>({
    name: moduleName,
    // A hard edge, not a comment: the replay route resolves the relay from this
    // module, so arc rejects a composition that never registered it rather than
    // failing at the first replay an operator attempts.
    dependsOn: [outboxModuleName],
    ...(deps.owns ? { owns: [...deps.owns] } : {}),
    resources: () => [resource],
  });
}
