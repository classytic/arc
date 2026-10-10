/**
 * The gates an HTTP route applies that an MCP tool must apply too, because a tool calls the
 * controller or action handler directly and skips the route: idempotent execution, the
 * key-required refusal, the per-caller rate limit and the action audit record.
 */

import { createHash, randomUUID } from "node:crypto";
import type { IdempotencyStore } from "../../idempotency/stores/interface.js";
import { createIdempotencyResult } from "../../idempotency/stores/interface.js";
import type { RateLimitConfig } from "../../types/index.js";
import { toCallToolError } from "./tool-helpers.js";
import type { CallToolResult, McpAuthResult } from "./types.js";

/** TTLs matching the HTTP idempotency plugin's defaults. */
const MCP_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_IDEMPOTENCY_LOCK_MS = 10_000;

/** Key scoped to (resource, operation, input, caller): the same key with other input re-executes. */
function invocationFingerprint(
  resourceName: string,
  operation: string,
  input: Record<string, unknown>,
  session: McpAuthResult | null,
): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      const record: Record<string, unknown> = { ...value };
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((k) => [k, sortKeys(record[k])]),
      );
    }
    return value;
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(sortKeys(input)))
    .digest("hex")
    .substring(0, 16);
  const caller = session?.userId ?? session?.clientId ?? "anon";
  return `mcp:${resourceName}:${operation}:${inputHash}:u=${caller}`;
}

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
  readonly dispatch: () => Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const { store, dispatch } = args;
  const fullKey = `${args.key}:${invocationFingerprint(args.resourceName, args.operation, args.input, args.session)}`;
  const cached = await store.get(fullKey);
  if (cached) return cached.body as CallToolResult;
  const lockId = randomUUID();
  if (!(await store.tryLock(fullKey, lockId, MCP_IDEMPOTENCY_LOCK_MS))) {
    return toCallToolError({
      code: "arc.idempotency_conflict",
      message: "A call with this idempotency key is already in progress",
      status: 409,
    });
  }
  try {
    const result = await dispatch();
    if (!result.isError) {
      await store.set(fullKey, createIdempotencyResult(200, result, {}, MCP_IDEMPOTENCY_TTL_MS));
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

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** `'1 minute'`, `'15 seconds'`, `'500 ms'` → milliseconds. An unreadable window refuses boot. */
export function timeWindowMs(window: string): number {
  const match = /^\s*(\d+)\s*([a-z]+?)s?\s*$/i.exec(window);
  const unit = match ? UNIT_MS[match[2]?.toLowerCase() ?? ""] : undefined;
  if (!match || unit === undefined) {
    throw new Error(`[Arc/MCP] rateLimit.timeWindow '${window}' is not '<n> <unit>'.`);
  }
  return Number(match[1]) * unit;
}

/**
 * The resource's HTTP rate limit, applied per caller per tool (fixed window, in process).
 * `undefined` or `false` = no limit, as on the route.
 */
export function createToolRateLimiter(
  config: RateLimitConfig | false | undefined,
): ((session: McpAuthResult | null) => boolean) | undefined {
  if (!config) return undefined;
  const windowMs = timeWindowMs(config.timeWindow);
  const hits = new Map<string, { start: number; count: number }>();
  return (session) => {
    const caller = session?.userId ?? session?.clientId ?? "anon";
    const now = Date.now();
    const slot = hits.get(caller);
    if (!slot || now - slot.start >= windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(caller, { start: now, count: 1 });
      return true;
    }
    slot.count += 1;
    return slot.count <= config.max;
  };
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
