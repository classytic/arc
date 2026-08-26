/**
 * Typed action declaration — captures the Zod schema's literal type so the
 * handler's `data` is inferred as `z.infer<typeof schema>` instead of
 * `Record<string, unknown>` that each host hand-casts.
 *
 * The shape arc validates at the HTTP layer (`buildActionBodySchema` → AJV) is
 * BY CONSTRUCTION the shape the handler sees. Opt-in: plain-object action
 * entries still work.
 *
 * @example
 * ```ts
 * moveToStage: defineAction({
 *   schema: z.object({ stageId: z.string(), probability: z.number().optional() }),
 *   handler: async (id, data) => leadService.move(id, data.stageId, data.probability),
 *   permissions: requireRoles(['admin']),
 * })
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
