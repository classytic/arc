/**
 * `defineAction()` — typed action declaration (v2.16).
 *
 * Pre-2.16 every action handler received `data: Record<string, unknown>`
 * and hosts hand-cast it to a domain interface or threw their own
 * `ValidationError` for missing fields. The pattern was reinvented in
 * every resource file (lead, opportunity, invoice, …) — the OpenAI-team
 * report's #2 ask.
 *
 * The fix: a tiny helper that captures the declared Zod schema's literal
 * type so the handler's `data` parameter is inferred as
 * `z.infer<typeof schema>`. The shape arc validates at the HTTP layer
 * (via `buildActionBodySchema` → AJV) is the EXACT same shape the
 * handler sees, by construction.
 *
 * Plain-object action entries still work — typing is opt-in, not
 * mandatory. Use `defineAction()` for new actions where you want the
 * compiler to catch typos in `data.<field>` accesses.
 *
 * @example Drop-in replacement for an object-form action.
 * ```ts
 * import { defineAction } from '@classytic/arc/core';
 * import { z } from 'zod';
 *
 * defineResource({
 *   actions: {
 *     moveToStage: defineAction({
 *       schema: z.object({
 *         stageId: z.string(),
 *         probability: z.number().min(0).max(1).optional(),
 *       }),
 *       handler: async (id, data, req) => {
 *         // data: { stageId: string; probability?: number }  ← typed
 *         await leadService.move(id, data.stageId, data.probability);
 *       },
 *       permissions: requireRoles(['admin']),
 *     }),
 *   },
 * });
 * ```
 */

import type { z } from "zod";
import type { PermissionCheck } from "../permissions/types.js";
import type { RequestWithExtras } from "../types/fastify.js";
import type { ActionDefinition, RouteMcpConfig } from "../types/resource/index.js";

/**
 * Config for `defineAction()`. `TSchema` is the literal Zod schema type
 * captured from the call site; `TData` is its `z.infer` projection.
 * Plain JSON-Schema entries skip the inference path entirely (they go
 * through the untyped `ActionDefinition` form).
 */
export interface DefineActionConfig<
  TSchema extends z.ZodTypeAny | undefined = undefined,
  TData = TSchema extends z.ZodTypeAny ? z.infer<TSchema> : Record<string, unknown>,
> {
  /** Per-action body schema (Zod v4). Drives both AJV validation and the typed `data` param. */
  schema?: TSchema;
  /** Per-action permission gate. Falls back to resource-level if omitted. */
  permissions?: PermissionCheck;
  /** OpenAPI / MCP description. */
  description?: string;
  /**
   * Mount point — `true` (default) for `POST /<prefix>/:id/action`,
   * `false` for `POST /<prefix>/action` (no `:id`, for propose/search/
   * bulk-style actions).
   */
  id?: boolean;
  /** MCP tool generation flag — `false` to skip, object for explicit overrides. */
  mcp?: boolean | RouteMcpConfig;
  /**
   * Typed handler. `data` is inferred from `schema` — declare both and
   * the compiler catches `data.stagId` typos at the use site.
   *
   * Handlers return arbitrary values; arc wraps them in
   * `IControllerResponse` and ships them through `sendControllerResponse`
   * just like the untyped `ActionDefinition.handler` does.
   */
  handler: (id: string, data: TData, req: RequestWithExtras) => Promise<unknown>;
}

/**
 * Build an `ActionDefinition` with a typed handler. The literal schema
 * type captured here flows into `data`, so `defineAction({ schema:
 * z.object({...}), handler })` produces fully-typed code with no
 * `as MyShape` cast.
 *
 * Behaviorally identical to a bare `ActionDefinition` object — same
 * validation path (AJV), same permission resolution, same MCP wiring.
 * The runtime shape is unchanged; only the type-level inference is new.
 */
export function defineAction<TSchema extends z.ZodTypeAny | undefined = undefined>(
  config: DefineActionConfig<TSchema>,
): ActionDefinition {
  return {
    handler: config.handler as ActionDefinition["handler"],
    permissions: config.permissions,
    schema: config.schema as ActionDefinition["schema"],
    description: config.description,
    id: config.id,
    mcp: config.mcp,
  };
}
