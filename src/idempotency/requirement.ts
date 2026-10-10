/**
 * The idempotency fence a route declares: `config.idempotency.required` (every call) or
 * `config.idempotency.requiredActions` (an action route, for the named `body.action` values).
 * One reader, so the plugin, its boot checks and arc's route registration agree.
 */

import type { FastifyRequest } from "fastify";

/** The `config.idempotency` slot of a Fastify route. */
export interface RouteIdempotencyConfig {
  /** Every call needs a key — any method, DELETE included. */
  readonly required?: boolean;
  /** Action route only: a call whose `body.action` is one of these needs a key. */
  readonly requiredActions?: readonly string[];
  /**
   * `'handler'`: the handler owns at-most-once for this route (its own durable claim). Arc still
   * refuses a keyless call and exposes the key on `request.idempotencyKey`, but stores, locks,
   * fingerprints and replays nothing. Needs `required: true` and an `owner`.
   */
  readonly dedup?: "handler";
  /** Names the runner that owns deduplication under `dedup: 'handler'`. */
  readonly owner?: string;
  /** Action route only: action name -> owner, for actions in `requiredActions` that dedupe themselves. */
  readonly handlerDedup?: Readonly<Record<string, string>>;
}

/** What is wrong with a route's idempotency declaration, or `undefined` when it is sound. */
export function idempotencyConfigProblem(config: unknown): string | undefined {
  const idem = (config as { idempotency?: RouteIdempotencyConfig } | undefined)?.idempotency;
  if (!idem) return undefined;
  const ownerOk = typeof idem.owner === "string" && idem.owner.trim() !== "";
  if (idem.dedup !== undefined && idem.dedup !== "handler") {
    return `dedup must be 'handler', got '${String(idem.dedup)}'`;
  }
  if (idem.dedup === "handler" && idem.required !== true) {
    return "dedup: 'handler' needs required: true (the key is still demanded)";
  }
  if (idem.dedup === "handler" && !ownerOk) {
    return "dedup: 'handler' needs a non-empty `owner` naming the runner that deduplicates";
  }
  if (idem.dedup === undefined && idem.owner !== undefined) {
    return "`owner` is only meaningful with dedup: 'handler'";
  }
  for (const [action, owner] of Object.entries(idem.handlerDedup ?? {})) {
    if (!idem.requiredActions?.includes(action) || owner.trim() === "") {
      return `handlerDedup '${action}' must name an action in requiredActions and a non-empty owner`;
    }
  }
  return undefined;
}

/** True iff the route declares a fence for at least one call shape. */
export function declaresIdempotencyFence(config: unknown): boolean {
  const idem = (config as { idempotency?: RouteIdempotencyConfig } | undefined)?.idempotency;
  return idem?.required === true || (idem?.requiredActions?.length ?? 0) > 0;
}

/** True iff THIS request's handler deduplicates itself (arc only demands and exposes the key). */
export function requestDedupedByHandler(request: FastifyRequest): boolean {
  const idem = request.routeOptions.config?.idempotency;
  if (idem?.required === true) return idem.dedup === "handler";
  const action = (request.body as { action?: unknown } | null | undefined)?.action;
  return typeof action === "string" && idem?.handlerDedup?.[action] !== undefined;
}

/** True iff THIS request is fenced — a keyless call is refused, a keyed one deduplicated. */
export function requestRequiresIdempotencyKey(request: FastifyRequest): boolean {
  const idem = request.routeOptions.config?.idempotency;
  if (idem?.required === true) return true;
  if (!idem?.requiredActions?.length) return false;
  const action = (request.body as { action?: unknown } | null | undefined)?.action;
  return typeof action === "string" && idem.requiredActions.includes(action);
}
