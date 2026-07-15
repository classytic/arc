/**
 * Inline resource lifecycle hooks — the simplified hook context and the
 * `hooks:` block on a resource definition (wired into the HookSystem).
 */

import type { UserBase } from "../../permissions/types.js";
import type { AnyRecord } from "../base.js";

/**
 * Hook context passed to resource-level hook handlers. Mirrors
 * HookSystem's HookContext but with a simpler API for inline use.
 *
 * **v2.10.8:** `context` and a first-class `scope` projection are now
 * forwarded from the internal `HookContext`. Before this release, inline
 * `config.hooks` handlers had no way to reach the caller's tenant or
 * user info — they had to bypass the documented API and push directly
 * into `resource._pendingHooks` to get the raw internal shape. Now the
 * documented DX is complete:
 *
 * ```ts
 * hooks: {
 *   afterCreate: (ctx) => {
 *     auditLog.write({
 *       org: ctx.scope?.organizationId,
 *       actor: ctx.scope?.userId,
 *       id: ctx.data._id,
 *     });
 *   },
 * }
 * ```
 *
 * The `scope` projection matches `IRequestContext.scope` (2.10.6) so
 * hosts read tenant/user the same way across controllers and hooks.
 * Use `context._scope` directly for advanced cases that need to
 * discriminate on `scope.kind` or reach auth-adapter-specific fields.
 */
export interface ResourceHookContext {
  /** The document data (create/update body, or existing doc for delete / after-result) */
  data: AnyRecord;
  /** Authenticated user or null */
  user?: UserBase;
  /**
   * Full typed request context — includes `_scope`, `_policyFilters`,
   * `arc` metadata. Use `ctx.scope` for the common tenant/user projection;
   * reach for `ctx.context` when you need `_scope.kind` branching or
   * custom fields set by your auth adapter.
   */
  context?: AnyRecord;
  /**
   * First-class projection of request scope — `{ organizationId?, userId?, orgRoles? }`.
   * Populated for every scoped request so multi-tenant hooks don't have to
   * drill into `context._scope.organizationId` themselves. Matches the
   * identically-named field on `IRequestContext` (v2.10.6) so the same
   * read pattern works in controllers and hooks.
   */
  scope?: {
    organizationId?: string;
    userId?: string;
    orgRoles?: string[];
  };
  /** Additional metadata (e.g. `{ id, existing }` for update/delete) */
  meta?: AnyRecord;
}

/**
 * Inline lifecycle hooks on a resource definition. Wired into the
 * HookSystem automatically — same pipeline as presets and app-level hooks.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'chat',
 *   hooks: {
 *     afterCreate: async (ctx) => { analytics.track('chat.created', { id: ctx.data._id }); },
 *     beforeDelete: async (ctx) => {
 *       if (ctx.data.isProtected) throw new Error('Cannot delete protected chat');
 *     },
 *   },
 * });
 * ```
 */
export interface ResourceHooks {
  beforeCreate?: (
    ctx: ResourceHookContext,
  ) => Promise<AnyRecord | undefined> | AnyRecord | undefined;
  afterCreate?: (ctx: ResourceHookContext) => Promise<void> | void;
  beforeUpdate?: (
    ctx: ResourceHookContext,
  ) => Promise<AnyRecord | undefined> | AnyRecord | undefined;
  afterUpdate?: (ctx: ResourceHookContext) => Promise<void> | void;
  beforeDelete?: (ctx: ResourceHookContext) => Promise<void> | void;
  afterDelete?: (ctx: ResourceHookContext) => Promise<void> | void;
}
