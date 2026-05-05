/**
 * Action Router Factory (Stripe Pattern)
 *
 * Consolidates multiple state-transition endpoints into a single unified
 * action endpoint: `POST /:id/action`. Instead of one route per action
 * (approve, dispatch, receive, cancel), one route discriminates on
 * `body.action`.
 *
 * Actions share every cross-cutting concern with the CRUD router
 * (`createCrudRouter`) via the primitives in `routerShared` — field masking,
 * auth/permission middleware, pipeline execution, `arcDecorator`, idempotency
 * middleware, and rate-limit config. This is the single source of truth for
 * action route assembly; divergence between CRUD and actions is now a build-
 * time type mismatch, not a silent runtime hole.
 *
 * Response shape is standardised through `sendControllerResponse`, so
 * field-level `fields.hidden() / visibleTo() / writableBy()` permissions
 * apply to action responses exactly like CRUD responses.
 *
 * @example
 * ```typescript
 * import { createActionRouter } from '@classytic/arc/core';
 * import { requireRoles } from '@classytic/arc/permissions';
 *
 * createActionRouter(fastify, {
 *   tag: 'Inventory - Transfers',
 *   resourceName: 'transfer',
 *   actions: {
 *     approve: async (id, _data, req) => transferService.approve(id, req.user),
 *     dispatch: async (id, data, req) => transferService.dispatch(id, data.transport, req.user),
 *     receive:  async (id, data, req) => transferService.receive(id, data, req.user),
 *     cancel:   async (id, data, req) => transferService.cancel(id, data.reason, req.user),
 *   },
 *   actionPermissions: {
 *     approve:  requireRoles(['admin', 'warehouse-manager']),
 *     dispatch: requireRoles(['admin', 'warehouse-staff']),
 *     receive:  requireRoles(['admin', 'store-manager']),
 *     cancel:   requireRoles(['admin']),
 *   },
 * });
 * ```
 */

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

import { DEFAULT_ID_FIELD } from "../constants.js";
import type { FieldPermissionMap } from "../permissions/fields.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { PipelineConfig } from "../pipeline/types.js";
import type {
  FastifyWithDecorators,
  IControllerResponse,
  RateLimitConfig,
  RequestWithExtras,
  RouteSchemaOptions,
} from "../types/index.js";
import { createError } from "../utils/errors.js";
import { sendControllerResponse } from "./fastifyAdapter.js";
import {
  buildActionPermissionMw,
  buildActionPipelineHandler,
  buildArcDecorator,
  buildAuthMiddlewareForPermissions,
  buildPreHandlerChain,
  buildRateLimitConfig,
  resolvePipelineSteps,
  resolveRouterPluginMw,
  selectPluginMw,
} from "./routerShared.js";
import { normalizeSchemaIR, schemaIRToJsonSchemaBranch } from "./schemaIR.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Action handler.
 *
 * @param id   - Resource ID (route param)
 * @param data - Request body with the `action` discriminator stripped
 * @param req  - Full Fastify request (user, scope, headers, policy filters)
 * @returns    - Raw result, wrapped by the router into an `IControllerResponse`
 *               and sent through `sendControllerResponse` (so field masking
 *               applies).
 */
export type ActionHandler<TData = Record<string, unknown>, TResult = unknown> = (
  id: string,
  data: TData,
  req: RequestWithExtras,
) => Promise<TResult>;

/**
 * Action router configuration.
 *
 * `resourceName`, `fields`, `permissions`, `routeGuards`, and `pipeline`
 * are threaded through from `defineResource` so action routes share the
 * resource's cross-cutting wiring. Direct `createActionRouter` callers
 * can still omit them — the router falls back to sensible defaults.
 */
export interface ActionRouterConfig {
  /** OpenAPI tag for grouping routes */
  readonly tag?: string;

  /** Logical resource name for `req.arc` and permission contexts */
  readonly resourceName?: string;

  /** Action handlers map */
  readonly actions: Record<string, ActionHandler>;

  /** Per-action permission checks */
  readonly actionPermissions?: Record<string, PermissionCheck>;

  /**
   * Per-action body schema. Accepted shapes:
   *
   * 1. Full JSON Schema with `type: 'object'`, `properties`, `required`
   * 2. Zod v4 schema — auto-converted via `z.toJSONSchema()`
   *
   * Compiled into a single `oneOf` discriminator body schema so AJV
   * validates action-specific required fields at the HTTP layer.
   *
   * @example
   * ```ts
   * actionSchemas: {
   *   dispatch: {
   *     type: 'object',
   *     properties: { carrier: { type: 'string' } },
   *     required: ['carrier'],
   *   },
   * }
   * ```
   */
  readonly actionSchemas?: Record<string, Record<string, unknown>>;

  /** Global permission applied when no per-action check is declared */
  readonly globalAuth?: PermissionCheck;

  /** Custom error shaper for action-handler throws */
  readonly onError?: (
    error: Error,
    action: string,
    id: string,
  ) => { statusCode: number; error: string; code?: string };

  /** Field-level permissions for response masking (threaded from resource.fields) */
  readonly fields?: FieldPermissionMap;

  /** Schema options for `req.arc` (used by hook system + body sanitizer) */
  readonly schemaOptions?: RouteSchemaOptions;

  /**
   * Resource's configured `idField` (e.g. `_id`, `slug`, `reportId`).
   * Surfaced on `req.arc.idField` inside every action handler so the
   * handler can compose a correct lookup query without re-reading
   * resource config. Defaults to `_id` when omitted.
   *
   * Pair with `getEntityQuery(req)` from `@classytic/arc/scope` for the
   * idiomatic `Model.findOne(getEntityQuery(req))` shape.
   */
  readonly idField?: string;

  /** Resource-level permissions (for `req.arc.permissions`) */
  readonly permissions?: Record<string, PermissionCheck>;

  /** Route guards (applied to the action endpoint — after auth, before handler) */
  readonly routeGuards?: RouteHandlerMethod[];

  /** Pipeline config — steps keyed by action name run around the handler */
  readonly pipeline?: PipelineConfig;

  /** Rate limit override (per-route Fastify config) */
  readonly rateLimit?: RateLimitConfig | false;
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Register the unified action endpoint: `POST /:id/action`.
 *
 * Shares every lifecycle primitive with the CRUD router — the preHandler
 * chain, the arc decorator, idempotency, rate-limit, and the response
 * shaper. The only thing that stays local is the dynamic permission check
 * (keyed by `body.action` at request time).
 */
export function createActionRouter(
  fastify: FastifyWithDecorators,
  config: ActionRouterConfig,
): void {
  const {
    tag,
    resourceName = tag ?? "action",
    actions,
    actionPermissions = {},
    actionSchemas = {},
    globalAuth,
    onError,
    fields: fieldPermissions,
    schemaOptions,
    idField = DEFAULT_ID_FIELD,
    permissions: resourcePermissions,
    routeGuards = [],
    pipeline,
    rateLimit,
  } = config;

  const actionEnum = Object.keys(actions);

  if (actionEnum.length === 0) {
    fastify.log.warn("[createActionRouter] No actions defined, skipping route creation");
    return;
  }

  // Discriminated body schema — AJV enforces required fields per action.
  const bodySchema = buildActionBodySchema(actionEnum, actionSchemas);

  const routeSchema = {
    tags: tag ? [tag] : undefined,
    summary: `Perform action (${actionEnum.join("/")})`,
    description: buildActionDescription(actions, actionPermissions),
    params: {
      type: "object",
      properties: { id: { type: "string", description: "Resource ID" } },
      required: ["id"],
    },
    body: bodySchema,
    // No response schema — action handlers return dynamic shapes that cannot
    // be described with a single static JSON Schema. Fastify serializes them
    // with plain JSON.stringify, which honours toJSON() on documents.
  };

  // Arc metadata decorator — same wiring that CRUD uses, so
  // `sendControllerResponse` can read `req.arc.fields` for field masking.
  const arcDecorator = buildArcDecorator({
    resourceName,
    schemaOptions,
    permissions: resourcePermissions,
    hooks: fastify.arc?.hooks,
    events: fastify.events,
    fields: fieldPermissions,
    // Frozen here — pre-allocated once per resource, every request reads
    // `req.arc.idField` for free. Per-request `entityId` is layered on
    // top inside the action handler below.
    idField,
  });

  // Auth — pick the right decorator for the whole action endpoint given the
  // mix of per-action permissions. Mixed public/protected uses
  // `optionalAuthenticate` so public actions don't 401 on missing tokens;
  // protected actions still fail-closed via the per-action permission check
  // when `req.user` is null.
  //
  // `globalAuth` is only the fallback for actions without a per-action check —
  // applied via `??` so it fills the gap without masquerading as a separate
  // action. An action whose per-action permission is `undefined` AND has no
  // `globalAuth` fallback stays `undefined` in the resolved array — and that
  // undefined is semantically "public by omission" to
  // `buildAuthMiddlewareForPermissions`. Filtering undefineds out (as an
  // earlier version did) silently broke mixed omitted-public + protected
  // endpoints: `{ ping: undefined, promote: requireRoles([...]) }` collapsed
  // to "all protected" and 401'd the public `ping` action at the auth layer
  // before the per-action permission check could let it through.
  const perActionPermissions: Array<PermissionCheck | undefined> = actionEnum.map(
    (name) => actionPermissions[name] ?? globalAuth,
  );
  const authMw = buildAuthMiddlewareForPermissions(fastify, perActionPermissions);

  // Cache/idempotency middlewares — same decorator lookup as CRUD.
  const pluginMw = resolveRouterPluginMw(fastify, /* resourceHasQueryCache */ false);

  // Per-action pipeline pre-wrapping — actions share the pipeline config with
  // CRUD ops (keyed by action name). `buildActionPipelineHandler` now always
  // returns a `Promise<IControllerResponse<unknown>>`, so pipeline failures
  // preserve `status`/`meta`/`details`/`error` on the way to the client
  // (same contract the CRUD router holds via `buildPipelineHandler`).
  type WrappedActionHandler = (
    id: string,
    data: Record<string, unknown>,
    req: RequestWithExtras,
  ) => Promise<IControllerResponse<unknown>>;
  const wrappedHandlers = new Map<string, WrappedActionHandler>();
  for (const [name, handler] of Object.entries(actions)) {
    const steps = resolvePipelineSteps(pipeline, name);
    wrappedHandlers.set(
      name,
      buildActionPipelineHandler(
        handler as (
          id: string,
          data: Record<string, unknown>,
          req: RequestWithExtras,
        ) => Promise<unknown>,
        steps,
        name,
        resourceName,
      ),
    );
  }

  // Dynamic permission gate — evaluates from `body.action` in the canonical
  // `permissionMw` slot, so `_policyFilters` + `request.scope` installed by
  // the permission result are visible to `pluginMw` (idempotency) and
  // `routeGuards` that run AFTER it. Previously this check lived inside the
  // handler, which meant unauthorized requests still recorded idempotency
  // keys and guards saw unfiltered scope.
  const permissionMw = buildActionPermissionMw(
    actionEnum,
    actionPermissions,
    globalAuth,
    resourceName,
  );

  const preHandler = buildPreHandlerChain({
    arcDecorator,
    authMw,
    permissionMw,
    pluginMw: selectPluginMw("POST", pluginMw),
    routeGuards,
  });

  const rateLimitConfig = buildRateLimitConfig(rateLimit);

  fastify.route({
    method: "POST",
    url: "/:id/action",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: routeSchema as any,
    preHandler: preHandler.length > 0 ? (preHandler as any) : undefined,
    ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const { action, ...data } = req.body as { action: string; [key: string]: unknown };
      const { id } = req.params as { id: string };

      // Layer the per-request entity handle on top of the frozen
      // resource meta (`idField` rides on the meta, set once by
      // `buildArcDecorator`). One object allocation per action call —
      // worth it for the `Model.findOne(getEntityQuery(req))` ergonomics.
      // Without the spread we'd be mutating the per-resource frozen
      // object, which throws.
      const reqWithExtras = req as RequestWithExtras;
      reqWithExtras.arc = {
        ...(reqWithExtras.arc ?? {}),
        entityId: id,
      };

      // `buildActionPermissionMw` has already rejected invalid actions (400)
      // and denied permissions (401/403), so the handler lookup is guaranteed
      // to hit. The defensive fallback stays for hosts that bypass the
      // preHandler chain (internal invocation paths).
      const handler = wrappedHandlers.get(action);
      if (!handler) {
        throw createError(
          400,
          `Invalid action '${action}'. Valid actions: ${actionEnum.join(", ")}`,
          { validActions: actionEnum },
        );
      }

      try {
        // The wrapped handler produces a full IControllerResponse — pipeline
        // interceptors flow straight through `sendControllerResponse`. Errors
        // throw ArcError; the global handler emits the canonical contract.
        const response = await handler(id, data, req as RequestWithExtras);
        return sendControllerResponse(reply, response, req);
      } catch (error) {
        if (onError) {
          const { statusCode, error: errorMsg, code } = onError(error as Error, action, id);
          throw createError(statusCode, errorMsg, code ? { code } : undefined);
        }

        const err = error as Record<string, unknown>;
        const statusCode = (err.statusCode as number) || (err.status as number) || 500;
        const errorCode = (err.code as string) || "ACTION_FAILED";

        if (statusCode >= 500) {
          req.log.error({ err: error, action, id }, "Action handler error");
        }

        // Re-throw ArcError instances unchanged so the global error handler
        // preserves their `code`/`details`. Non-Arc errors (raw throws from
        // user handlers) get wrapped into the canonical ArcError shape.
        if ((error as { name?: string })?.name === "ArcError" || error instanceof Error === false) {
          throw error;
        }
        throw createError(
          statusCode,
          (err.message as string) || `Failed to execute '${action}' action`,
          { code: errorCode },
        );
      }
    },
  });

  fastify.log.debug(
    { actions: actionEnum, tag, resourceName },
    "[createActionRouter] Registered action endpoint: POST /:id/action",
  );
}

// ============================================================================
// Body schema construction
// ============================================================================

/**
 * Build a discriminated body schema for the unified action endpoint.
 *
 * Produces a schema of the form:
 * ```json
 * {
 *   "type": "object",
 *   "required": ["action"],
 *   "properties": {
 *     "action": { "type": "string", "enum": ["dispatch", "approve"] },
 *     "carrier": { "type": "string" }
 *   },
 *   "oneOf": [
 *     {
 *       "properties": {
 *         "action": { "const": "dispatch" },
 *         "carrier": { "type": "string" }       // ← every branch lists the union
 *       },
 *       "required": ["action", "carrier"]
 *     },
 *     {
 *       "properties": {
 *         "action": { "const": "approve" },
 *         "carrier": { "type": "string" }       // ← even though approve doesn't use it
 *       },
 *       "required": ["action"]
 *     }
 *   ]
 * }
 * ```
 *
 * **Why every branch carries the full property union.** AJV's
 * `removeAdditional: 'all'` (Fastify's framework default) interacts badly
 * with `oneOf`: when a branch's `properties` lacks a field, AJV strips it
 * from the body during that branch's evaluation — *even if a different
 * branch would have allowed it*. The strip mutates the body before
 * `oneOf` finishes discriminating, so by the time the matching branch
 * wins, the body has already lost fields. Concretely: `actions: { verify:
 * {}, hold: { schema: z.object({ amount, reason }.optional()) } }` +
 * `POST { action: 'hold', amount: 1, reason }` lands at the handler as
 * `{ action: 'hold' }`. Empirically reproduced and locked at
 * [tests/core/action-discriminator-strip.test.ts](../../tests/core/action-discriminator-strip.test.ts).
 *
 * Listing every action's properties on every branch makes per-branch
 * removeAdditional walks see every caller field as "in this branch's
 * properties," so nothing gets stripped during oneOf evaluation. The
 * `required` array stays per-action, so the handler still gets called
 * only when the matching branch's required-field contract is satisfied.
 * Per-branch `additionalProperties: false` (Zod v4 default) carries
 * through but, under host removeAdditional: 'all', it can no longer
 * reject sibling-action fields — those become silently stripped at top
 * level instead. That's the host's opt-in to stripping; arc's job is to
 * stop accidentally losing the action's *own* declared fields.
 *
 * Under arc's own `createApp` (`removeAdditional: false`), strict-mode
 * rejection still functions normally — see
 * [tests/core/action-strict-schema-parity.test.ts](../../tests/core/action-strict-schema-parity.test.ts).
 *
 * Exported so OpenAPI generation and MCP tool generation can reuse the same
 * schema shape (single source of truth).
 */
export function buildActionBodySchema(
  actionEnum: readonly string[],
  actionSchemas: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  // First pass: normalize every action's IR and accumulate the property
  // union. Last branch wins on collision — actions that share a field name
  // should agree on its type (the schema otherwise contradicts itself
  // across branches).
  const unionProperties: Record<string, Record<string, unknown>> = {};
  const irs: Array<{ name: string; ir: ReturnType<typeof normalizeSchemaIR> }> = [];

  for (const actionName of actionEnum) {
    // Normalize each action's schema through the shared IR ([./schemaIR.ts])
    // so HTTP (this file) and MCP ([../integrations/mcp/action-tools.ts])
    // read the same representation. `additionalProperties` carries through
    // verbatim — authors who declare `additionalProperties: false` in their
    // action `schema` get strict AJV rejection of unknown fields AND strict
    // MCP rejection in a single declaration.
    const ir = normalizeSchemaIR(actionSchemas[actionName]);
    irs.push({ name: actionName, ir });
    for (const [key, val] of Object.entries(ir.properties)) {
      unionProperties[key] = val;
    }
  }

  // Second pass: emit each branch with the full union baked into its
  // `properties` (action discriminator is overridden per-branch). This is
  // the load-bearing part — see the JSDoc above.
  const branches: Array<Record<string, unknown>> = [];
  for (const { name, ir } of irs) {
    branches.push(
      schemaIRToJsonSchemaBranch(
        // Synthetic IR: branch keeps its own `required` + `additionalProperties`
        // but its `properties` is the full union.
        { ...ir, properties: { ...unionProperties, ...ir.properties } },
        {
          properties: { action: { type: "string", const: name } },
          required: ["action"],
        },
      ),
    );
  }

  return {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: [...actionEnum] },
      ...unionProperties,
    },
    oneOf: branches,
  };
}

/**
 * Build OpenAPI description with action list + role hints.
 * Reads `_roles` metadata from permission checks for docs.
 */
function buildActionDescription(
  actions: Record<string, ActionHandler>,
  actionPermissions: Record<string, PermissionCheck>,
): string {
  const lines = ["Unified action endpoint for state transitions.\n\n**Available actions:**"];

  Object.keys(actions).forEach((action) => {
    const perm = actionPermissions[action];
    const roles = (perm as PermissionCheck)?._roles;
    const roleStr = roles?.length ? ` (requires: ${roles.join(" or ")})` : "";
    lines.push(`- \`${action}\`${roleStr}`);
  });

  return lines.join("\n");
}
