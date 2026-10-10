/**
 * The gates an HTTP route applies that an MCP tool must apply too, because a tool calls the
 * controller or action handler directly and skips the route: idempotent execution, the
 * key-required refusal, the per-caller rate limit and the action audit record.
 */

import { randomUUID } from "node:crypto";
import { fingerprintRequest, IdempotencyError } from "@classytic/repo-core/idempotency";
import type { IdempotencyStore } from "../../idempotency/stores/interface.js";
import { createIdempotencyResult } from "../../idempotency/stores/interface.js";
import type { RequestScope } from "../../scope/types.js";
import type { RateLimitConfig } from "../../types/index.js";
import { operationIdentity } from "../../utils/operationIdentity.js";
import {
  createMemoryResourceRateLimiter,
  type ResourceRateLimiter,
  resourceRateLimitWindowMs,
} from "../../utils/resourceRateLimit.js";
import { buildScope } from "./buildRequestContext.js";
import { toCallToolError } from "./tool-helpers.js";
import type { CallToolResult, McpAuthResult } from "./types.js";

/** TTLs matching the HTTP idempotency plugin's defaults. */
const MCP_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_IDEMPOTENCY_LOCK_MS = 10_000;

function isIdempotencyStore(value: unknown): value is IdempotencyStore {
  if (typeof value !== "object" || value === null) return false;
  const s: { get?: unknown; set?: unknown; tryLock?: unknown; unlock?: unknown } = value;
  return (
    typeof s.get === "function" &&
    typeof s.set === "function" &&
    typeof s.tryLock === "function" &&
    typeof s.unlock === "function"
  );
}

/** The wired store, when it is one. */
export function idempotencyStoreOf(store: unknown): IdempotencyStore | undefined {
  return isIdempotencyStore(store) ? store : undefined;
}

/** Same protocol as the HTTP plugin: cached → replay; locked → 409; else lock → run → record. */
export async function runIdempotentTool(args: {
  readonly store: IdempotencyStore;
  readonly key: string;
  readonly resourceName: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly session: McpAuthResult | null;
  readonly scope?: RequestScope;
  readonly dispatch: () => Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const { store, dispatch } = args;
  const fullKey = `${args.key}:${operationIdentity(`${args.resourceName}:${args.operation}`, args.scope ?? buildScope(args.session), undefined, "mcp")}`;
  let fingerprint: string;
  try {
    fingerprint = fingerprintRequest(args.input);
  } catch (error) {
    if (error instanceof IdempotencyError)
      return toCallToolError({
        code: "arc.idempotency_body_unfingerprintable",
        message: error.message,
        status: 400,
      });
    throw error;
  }
  const replay = (
    cached: Awaited<ReturnType<IdempotencyStore["get"]>>,
  ): CallToolResult | undefined => {
    if (cached) {
      if (cached.requestFingerprint && cached.requestFingerprint !== fingerprint)
        return toCallToolError({
          code: "arc.idempotency_body_mismatch",
          message:
            "Idempotency key was already used for a different request body. Use a new key for a new request.",
          status: 422,
        });
      return cached.body as CallToolResult;
    }
    return undefined;
  };
  const cachedResult = replay(await store.get(fullKey));
  if (cachedResult) return cachedResult;
  const lockId = randomUUID();
  if (!(await store.tryLock(fullKey, lockId, MCP_IDEMPOTENCY_LOCK_MS))) {
    return toCallToolError({
      code: "arc.idempotency_conflict",
      message: "A call with this idempotency key is already in progress",
      status: 409,
    });
  }
  try {
    const completed = replay(await store.get(fullKey));
    if (completed) return completed;
    const result = await dispatch();
    if (!result.isError) {
      await store.set(
        fullKey,
        createIdempotencyResult(200, result, {}, MCP_IDEMPOTENCY_TTL_MS, fingerprint),
      );
    }
    return result;
  } finally {
    await store.unlock(fullKey, lockId);
  }
}

/** The 400 a keyless call to a key-required route gets over HTTP. */
export function idempotencyKeyRequiredResult(toolName: string): CallToolResult {
  return toCallToolError({
    code: "arc.idempotency_key_required",
    message: `'${toolName}' moves money or stock: pass \`_idempotencyKey\` and reuse it on a retry.`,
    status: 400,
  });
}

/** Shared parser used by standalone and HTTP-backed resource limiters. */
export const timeWindowMs = resourceRateLimitWindowMs;

export function createToolRateLimiter(
  config: RateLimitConfig | false | undefined,
  resourceName: string,
  limiter: ResourceRateLimiter = createMemoryResourceRateLimiter(),
): ((session: McpAuthResult | null) => Promise<boolean>) | undefined {
  if (!config) return undefined;
  resourceRateLimitWindowMs(config.timeWindow);
  return (session) => limiter.consume(resourceName, config, { scope: buildScope(session) });
}

export function rateLimitedResult(toolName: string): CallToolResult {
  return toCallToolError({
    code: "arc.rate_limited",
    message: `Too many calls to '${toolName}' — retry later.`,
    status: 429,
  });
}

/** `audit.custom(resource, id, action, {}, context)` after a successful action, like the route. */
export async function auditToolAction(
  audit: unknown,
  args: {
    readonly resourceName: string;
    readonly id: string;
    readonly action: string;
    readonly toolName: string;
    readonly session: McpAuthResult | null;
    readonly log?: unknown;
  },
): Promise<void> {
  if (typeof audit !== "object" || audit === null) return;
  const logger: { custom?: unknown; _noop?: unknown } = audit;
  if (typeof logger.custom !== "function" || logger._noop === true) return;
  const { session } = args;
  const actorId = session?.userId ?? session?.clientId;
  try {
    await logger.custom.call(
      audit,
      args.resourceName,
      args.id,
      args.action,
      { channel: "mcp" },
      {
        ...(actorId !== undefined ? { actorId } : {}),
        ...(session?.organizationId !== undefined
          ? { organizationId: session.organizationId }
          : {}),
        endpoint: `MCP ${args.toolName}`,
      },
    );
  } catch (err) {
    const log: { error?: unknown } | undefined =
      typeof args.log === "object" && args.log !== null ? args.log : undefined;
    if (typeof log?.error === "function") {
      log.error.call(log, { err, tool: args.toolName }, "[arc/mcp] action audit write failed");
    }
  }
}
