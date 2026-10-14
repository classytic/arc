/**
 * The gates an HTTP route applies that an MCP tool must apply too, because a tool calls the
 * controller or action handler directly and skips the route: idempotent execution, the
 * key-required refusal, the per-caller rate limit and the action audit record.
 */

import { randomUUID } from "node:crypto";
import { ARC_ERROR_CODES } from "@classytic/repo-core/errors";
import { fingerprintRequest, IdempotencyError } from "@classytic/repo-core/idempotency";
import { acquireIdempotencyKey, releaseIdempotencyLock } from "../../idempotency/acquire.js";
import type { IdempotencyStore } from "../../idempotency/stores/interface.js";
import { createIdempotencyResult } from "../../idempotency/stores/interface.js";
import { resolveIdempotencyTiming } from "../../idempotency/timing.js";
import { arcLog } from "../../logger/index.js";
import type { ResourceRateLimitPolicy } from "../../permissions/resourceRateLimit.js";
import {
  createMemoryResourceRateLimiter,
  type ResourceRateLimiter,
  resourceRateLimitWindowMs,
} from "../../permissions/resourceRateLimit.js";
import type { RequestScope } from "../../scope/types.js";
import { operationIdentity } from "../../utils/operationIdentity.js";
import { buildScope } from "./buildRequestContext.js";
import { toCallToolError } from "./tool-helpers.js";
import type { CallToolResult, McpAuthResult, McpExecutionWiring } from "./types.js";

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

function isFencedStore(store: IdempotencyStore): boolean {
  return typeof store.setIfLocked === "function" && store.supportsFencedCompletion !== false;
}

/** Refuse an unsafe standalone store; an explicit migration escape is logged at wiring. */
export function assertMcpIdempotencyFencing(wiring: McpExecutionWiring | undefined): void {
  resolveIdempotencyTiming(wiring?.idempotencyTtlMs, wiring?.idempotencyLockTimeoutMs);
  const store = idempotencyStoreOf(wiring?.idempotencyStore);
  if (!store || isFencedStore(store)) return;
  const message =
    "[Arc/MCP] Idempotency store must implement atomic setIfLocked completion fencing. Upgrade the store or explicitly allowUnfencedCompletion during migration.";
  if (wiring?.allowUnfencedCompletion !== true) throw new Error(message);
  const logger: { warn?: unknown } = wiring.log && typeof wiring.log === "object" ? wiring.log : {};
  const warning =
    "[Arc/MCP] allowUnfencedCompletion permits an expired worker to overwrite a newer result; migrate the idempotency store to atomic setIfLocked.";
  if (typeof logger.warn === "function") logger.warn.call(wiring.log, warning);
  else arcLog("mcp:idempotency").warn(warning);
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
  readonly allowUnfencedCompletion?: boolean;
  readonly idempotencyTtlMs?: number;
  readonly idempotencyLockTimeoutMs?: number;
  readonly dispatch: () => Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const { store, dispatch } = args;
  const { ttlMs, lockTimeoutMs } = resolveIdempotencyTiming(
    args.idempotencyTtlMs,
    args.idempotencyLockTimeoutMs,
  );
  if (!isFencedStore(store) && args.allowUnfencedCompletion !== true) {
    return toCallToolError({
      code: ARC_ERROR_CODES.INTERNAL_ERROR,
      message: "Idempotency store requires atomic setIfLocked completion fencing",
      status: 500,
    });
  }
  const fullKey = `${args.key}:${operationIdentity(`${args.resourceName}:${args.operation}`, args.scope ?? buildScope(args.session), undefined, "mcp")}`;
  let fingerprint: string;
  try {
    fingerprint = fingerprintRequest(args.input);
  } catch (error) {
    if (error instanceof IdempotencyError)
      return toCallToolError({
        code: ARC_ERROR_CODES.IDEMPOTENCY_BODY_UNFINGERPRINTABLE,
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
          code: ARC_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
          message:
            "Idempotency key was already used for a different request body. Use a new key for a new request.",
          status: 422,
        });
      return cached.body as CallToolResult;
    }
    return undefined;
  };
  const lockId = randomUUID();
  const acquisition = await acquireIdempotencyKey(store, fullKey, lockId, lockTimeoutMs);
  if (acquisition.status === "completed") return replay(acquisition.result) as CallToolResult;
  if (acquisition.status === "locked") {
    return toCallToolError({
      code: ARC_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      message: "A call with this idempotency key is already in progress",
      status: 409,
    });
  }
  let fencedCompletion = false;
  try {
    // One frozen JSON copy is both stored and returned: a tool's live object (structuredContent from
    // an engine that keeps mutating it) cannot make the replay differ from the first answer.
    const result = JSON.parse(JSON.stringify(await dispatch())) as CallToolResult;
    if (!result.isError) {
      const completion = createIdempotencyResult(200, result, {}, ttlMs, fingerprint);
      if (store.setIfLocked && store.supportsFencedCompletion !== false) {
        if (!(await store.setIfLocked(fullKey, lockId, completion))) {
          return toCallToolError({
            code: ARC_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            message: "The idempotency completion lease was lost; success could not be recorded",
            status: 409,
          });
        }
        fencedCompletion = true;
      } else {
        await store.set(fullKey, completion);
      }
    }
    return result;
  } finally {
    await releaseIdempotencyLock(store, fullKey, lockId, fencedCompletion);
  }
}

/** The 400 a keyless call to a key-required route gets over HTTP. */
export function idempotencyKeyRequiredResult(toolName: string): CallToolResult {
  return toCallToolError({
    code: ARC_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    message: `'${toolName}' moves money or stock: pass \`_idempotencyKey\` and reuse it on a retry.`,
    status: 400,
  });
}

export type ToolAdmission = (
  session: McpAuthResult | null,
  scope?: RequestScope,
) => boolean | Promise<boolean>;

export function createToolRateLimiter(
  config: ResourceRateLimitPolicy | false | undefined,
  resourceName: string,
  limiter: ResourceRateLimiter = createMemoryResourceRateLimiter(),
): ToolAdmission | undefined {
  if (!config) return undefined;
  resourceRateLimitWindowMs(config.timeWindow);
  return async (session, scope) =>
    (await limiter.consume(resourceName, config, { scope: scope ?? buildScope(session) })).allowed;
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
