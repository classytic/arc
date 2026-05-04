/**
 * Phase 6 — wire preset hooks + inline `config.hooks` onto the
 * resource's `_pendingHooks`.
 *
 * Two sources feed the same array:
 *   1. Preset hooks collected during `applyPresets()` (raw `_hooks`
 *      on the internal config). Already in the canonical
 *      `{ operation, phase, handler, priority }` shape — copied
 *      verbatim (priority defaults to 10).
 *   2. Inline `config.hooks.beforeCreate` / `afterCreate` / etc.
 *      Authored by the user on the original `ResourceConfig`.
 *      Wrapped in a `ResourceHookContext` projection (v2.10.8) so
 *      authors can read `scope` / `context` without reaching into
 *      internal request fields.
 *
 * The 6 inline hook keys (before/after × create/update/delete) used
 * to be 6 nearly-identical blocks; collapsed into a table + loop so
 * a future hook (e.g. `beforeRead`) is one row, not seven scattered
 * edits.
 */

import { buildRequestScopeProjection } from "../../scope/projection.js";
import type { RequestScope } from "../../scope/types.js";
import type { AnyRecord, RequestContext, ResourceConfig, UserBase } from "../../types/index.js";
import type { InternalResourceConfig } from "./config.js";

/**
 * Minimal slice of `ResourceDefinition` that `wireHooks` needs —
 * declared here so this module doesn't import the class
 * (`ResourceDefinition.ts` imports phase modules; importing back
 * would create a cycle through types-only paths).
 */
interface PendingHookHost {
  _pendingHooks: Array<{
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: AnyRecord) => unknown;
    priority: number;
  }>;
}

/**
 * Combined entry-point for Phase 6. Pushes preset-collected hooks
 * first, then inline `config.hooks` (so hosts can rely on
 * registration order if priorities tie).
 */
export function wireHooks<TDoc>(
  resource: PendingHookHost,
  resolvedConfig: InternalResourceConfig<TDoc>,
  inlineHooksConfig: ResourceConfig<TDoc>["hooks"],
): void {
  if (resolvedConfig._hooks?.length) {
    resource._pendingHooks.push(
      ...resolvedConfig._hooks.map((hook) => ({
        operation: hook.operation,
        phase: hook.phase,
        handler: hook.handler,
        priority: hook.priority ?? 10,
      })),
    );
  }

  if (!inlineHooksConfig) return;

  const h = inlineHooksConfig as Record<string, (ctx: unknown) => unknown>;
  for (const spec of INLINE_HOOK_SPECS) {
    const fn = h[spec.key];
    if (typeof fn !== "function") continue;
    resource._pendingHooks.push({
      operation: spec.operation,
      phase: spec.phase,
      priority: 10,
      handler: (ctx) => fn(buildHookContext(ctx)),
    });
  }
}

/**
 * Inline hook spec table — one row per `config.hooks.{key}`. Adding
 * a new lifecycle hook (e.g. `beforeRead`) means appending one row
 * here; the loop handles the rest.
 */
const INLINE_HOOK_SPECS: ReadonlyArray<{
  key: string;
  operation: "create" | "update" | "delete";
  phase: "before" | "after";
}> = [
  { key: "beforeCreate", operation: "create", phase: "before" },
  { key: "afterCreate", operation: "create", phase: "after" },
  { key: "beforeUpdate", operation: "update", phase: "before" },
  { key: "afterUpdate", operation: "update", phase: "after" },
  { key: "beforeDelete", operation: "delete", phase: "before" },
  { key: "afterDelete", operation: "delete", phase: "after" },
];

/**
 * Project a raw HookSystem context into a `ResourceHookContext` for
 * inline `config.hooks.*` handlers. The projection lifts `scope`
 * out of `context._scope` so authors don't reach into internal
 * fields.
 */
function buildHookContext(ctx: AnyRecord): {
  data: AnyRecord;
  user: UserBase | undefined;
  context: AnyRecord | undefined;
  scope: ReturnType<typeof buildRequestScopeProjection>;
  meta: AnyRecord | undefined;
} {
  const context = ctx.context as RequestContext | undefined;
  const rawScope = (context as { _scope?: RequestScope } | undefined)?._scope;
  return {
    data: (ctx.data ?? ctx.result ?? {}) as AnyRecord,
    user: ctx.user as UserBase | undefined,
    context: context as unknown as AnyRecord | undefined,
    scope: buildRequestScopeProjection(rawScope),
    meta: ctx.meta as AnyRecord | undefined,
  };
}
