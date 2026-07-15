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

import type {
  FastifyReply,
  FastifyRequest,
  FastifySchema,
  preHandlerHookHandler,
  RouteHandlerMethod,
} from "fastify";

/**
 * Local projection of `request.validationError` — Fastify types this as
 * `Error & { validation: any }` so we narrow at the use-site rather than
 * pulling AJV's `ErrorObject` type into a runtime-optional dependency.
 */
interface FastifyValidationError extends Error {
  validation?: ReadonlyArray<{
    keyword?: string;
    instancePath?: string;
    schemaPath?: string;
    params?: Record<string, unknown>;
    message?: string;
  }>;
}

import { DEFAULT_ID_FIELD } from "../constants.js";
import type { FieldPermissionMap } from "../permissions/fields.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { PipelineConfig } from "../pipeline/types.js";
import type {
  FastifyWithDecorators,
  IControllerResponse,
  RateLimitConfig,
  RequestWithExtras,
  ResourceExtensions,
  RouteSchemaOptions,
} from "../types/index.js";
import { createError } from "../utils/errors.js";
import { sendControllerResponse } from "./fastifyAdapter.js";
import {
  buildActionPermissionMw,
  buildActionPipelineHandler,
  buildArcDecorator,
  buildAuthMiddlewareForPermissions,
  buildRateLimitConfig,
  buildRouteConfig,
  buildRouteHooks,
  resolvePipelineSteps,
  resolveRouterPluginMw,
  routeHookOptions,
  selectPluginMw,
  tryRegisterRoute,
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

  /**
   * Resource-level plugin extensions (`defineResource({ extensions })`),
   * stamped onto the action route's `config.arcExtensions` so request-time
   * plugins (encryption, …) read their typed slice — same wiring CRUD +
   * custom routes get. See `ResourceExtensions`.
   */
  readonly extensions?: ResourceExtensions;

  /**
   * Names of actions that should mount at the resource root
   * (`POST /<prefix>/action`) instead of `POST /<prefix>/:id/action`.
   *
   * Use for actions that don't operate on an existing entity:
   *   - `propose` (creates a new entity from `body`)
   *   - `search` (returns rows for a query)
   *   - `bulk` (operates on a filter, not a single id)
   *
   * The handler still receives `(id, data, req)` for signature parity,
   * but `id` is `""` (the empty string) since no id-path-param exists.
   * Each action name appears in EITHER the id-bound enum OR the id-less
   * enum — the same action can't mount under both paths.
   *
   * Defaults to `[]` (all actions are id-bound — pre-2.15.5 behaviour).
   */
  readonly idLessActionNames?: readonly string[];
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
    idLessActionNames = [],
    extensions,
  } = config;

  const allActionNames = Object.keys(actions);

  if (allActionNames.length === 0) {
    fastify.log.warn("[createActionRouter] No actions defined, skipping route creation");
    return;
  }

  // 2.15.5 — partition actions into id-bound and id-less groups so each
  // mount point only advertises (and validates against) its own subset.
  // Same action name can't appear in both — `idLessActionNames` is the
  // single source of truth coming from `normalizeActionsToRouterConfig`.
  const idLessSet = new Set(idLessActionNames);
  const idBoundActionNames = allActionNames.filter((name) => !idLessSet.has(name));
  const idLessActions = allActionNames.filter((name) => idLessSet.has(name));

  // A typo in `idLessActionNames` would silently leave the action mounted
  // at `/:id/action` (the default branch) and have the developer chasing a
  // phantom routing bug — throw at boot instead.
  for (const name of idLessActionNames) {
    if (!Object.hasOwn(actions, name)) {
      throw new Error(
        `[Arc/Actions] Resource '${resourceName}': idLess action '${name}' is not declared ` +
          `in the actions map. Valid actions: ${allActionNames.join(", ")}.`,
      );
    }
  }

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

  // Cache/idempotency middlewares — same decorator lookup as CRUD.
  // Shared across both mount points; the dispatch surface is identical.
  const pluginMw = resolveRouterPluginMw(fastify, /* resourceHasQueryCache */ false);

  // Per-action pipeline pre-wrapping — actions share the pipeline config
  // with CRUD ops (keyed by action name). `buildActionPipelineHandler`
  // always returns `Promise<IControllerResponse<unknown>>`, so pipeline
  // failures preserve `status`/`meta`/`details`/`error` on the way to the
  // client. Built ONCE for every action; both mounts pull from the same map.
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

  const rateLimitConfig = buildRateLimitConfig(rateLimit);

  /**
   * Register one action mount point. Called once per mount (id-bound and/or
   * id-less). Each mount has its OWN AJV `oneOf` body schema filtered to
   * just `actionSubset` so the mount-point boundary is also a contract
   * boundary: hitting `POST /<prefix>/action` with an id-bound action name
   * fails at AJV (the discriminator enum excludes it) — and the
   * formatter's "wrong mount" message points the caller at the right URL.
   */
  const registerActionRoute = (mountOpts: {
    readonly urlPath: "/:id/action" | "/action";
    readonly actionSubset: readonly string[];
    readonly hasId: boolean;
  }): void => {
    const { urlPath, actionSubset, hasId } = mountOpts;
    if (actionSubset.length === 0) return;

    const subsetSet = new Set(actionSubset);

    // Auth — pick the decorator for THIS mount's actions only. Mixed
    // public/protected uses `optionalAuthenticate` so public actions don't
    // 401 on missing tokens; the per-action permission gate still fails
    // closed for protected actions when `req.user` is null.
    //
    // `globalAuth` is only the fallback for actions without a per-action
    // check — applied via `??`. An action whose per-action permission is
    // `undefined` AND has no `globalAuth` fallback stays `undefined` in
    // the resolved array — that's "public by omission" to
    // `buildAuthMiddlewareForPermissions`. Filtering undefineds out would
    // silently break mixed omitted-public + protected endpoints.
    const perActionPermissions: Array<PermissionCheck | undefined> = actionSubset.map(
      (name) => actionPermissions[name] ?? globalAuth,
    );
    const authMw = buildAuthMiddlewareForPermissions(fastify, perActionPermissions);

    // Dynamic permission gate — evaluates from `body.action` in the
    // canonical `permissionMw` slot, so `_policyFilters` / `request.scope`
    // set by the permission result are visible to plugin mw and route
    // guards that run AFTER it. Permission map is filtered to the subset.
    const subsetPermissions: Record<string, PermissionCheck> = {};
    for (const name of actionSubset) {
      const perm = actionPermissions[name];
      if (perm) subsetPermissions[name] = perm;
    }
    const permissionMw = buildActionPermissionMw(
      actionSubset,
      subsetPermissions,
      globalAuth,
      resourceName,
    );

    // Filtered body schema. Filtering at the schema level means cross-mount
    // calls (id-bound name on `/action`, id-less name on `/:id/action`)
    // fail AJV BEFORE auth/pipeline overhead.
    const subsetSchemas: Record<string, Record<string, unknown>> = {};
    for (const name of actionSubset) {
      if (actionSchemas[name]) subsetSchemas[name] = actionSchemas[name];
    }
    const bodySchema = buildActionBodySchema(actionSubset, subsetSchemas);

    const routeSchema: Record<string, unknown> = {
      tags: tag ? [tag] : undefined,
      summary: `Perform action (${actionSubset.join("/")})`,
      description: buildActionDescription(
        Object.fromEntries(
          actionSubset.map((name) => [name, actions[name] as ActionHandler]),
        ) as Record<string, ActionHandler>,
        subsetPermissions,
      ),
      body: bodySchema,
      // No response schema — action handlers return dynamic shapes that
      // can't be described with a single JSON Schema. Fastify falls back
      // to JSON.stringify, which honours toJSON() on documents.
    };
    if (hasId) {
      routeSchema.params = {
        type: "object",
        properties: { id: { type: "string", description: "Resource ID" } },
        required: ["id"],
      };
    }

    // 2.15.5 — action-scoped validation-error formatter. The body schema
    // uses an AJV `oneOf` (one branch per action) and AJV emits a failing-
    // branch error for EVERY branch on a mismatch. Without filtering,
    // Fastify's default error rendering points at an unrelated action's
    // `required` field — the mentora repro. We pick the branch matching
    // `body.action` and re-throw a Fastify-shaped error so the global
    // error handler maps it to the canonical `arc.validation_error`
    // contract. The filter is keyed off `schemaPath` (`/oneOf/<idx>/...`),
    // so the schema shape itself stays unchanged — the per-branch
    // property-union strict-mode mechanics keep working (see
    // `buildActionBodySchema`'s JSDoc).
    const actionValidationFormatter: RouteHandlerMethod = async (req, _reply) => {
      const validationError = (req as { validationError?: FastifyValidationError }).validationError;
      if (!validationError) return;

      const body = req.body as { action?: unknown } | undefined;
      const submitted = typeof body?.action === "string" ? body.action : undefined;

      if (!submitted || !subsetSet.has(submitted)) {
        // Sharper hint when the action exists but is mounted under the
        // OTHER path — turns "Unknown action 'approve'" into something the
        // caller can act on without grepping the resource definition.
        const wrongMount = submitted && allActionNames.includes(submitted) ? submitted : undefined;
        const otherMount = hasId ? "/action" : "/:id/action";
        const message = wrongMount
          ? `Action '${wrongMount}' on '${resourceName}' is mounted at 'POST ${otherMount}', not 'POST ${urlPath}'`
          : submitted
            ? `Unknown action '${submitted}' on '${resourceName}'. Valid at 'POST ${urlPath}': ${actionSubset.join(", ")}`
            : `Missing 'action' field on '${resourceName}'. Valid at 'POST ${urlPath}': ${actionSubset.join(", ")}`;
        throw createError(400, message, {
          code: "arc.invalid_action",
          validActions: actionSubset,
          mount: urlPath,
          ...(submitted ? { submitted } : {}),
          ...(wrongMount ? { mountedAt: otherMount } : {}),
        });
      }

      const branchIdx = actionSubset.indexOf(submitted);
      const branchPath = `/oneOf/${branchIdx}/`;
      const ajvErrors = validationError.validation ?? [];
      const scoped = ajvErrors.filter(
        (e) =>
          e.keyword !== "oneOf" &&
          (e.schemaPath?.includes(branchPath) || !e.schemaPath?.includes("/oneOf/")),
      );
      const useErrors = scoped.length > 0 ? scoped : ajvErrors;

      const scopedError = new Error(
        `Validation failed for action '${submitted}' on '${resourceName}'`,
      ) as Error & {
        statusCode: number;
        code: string;
        validation: typeof useErrors;
        validationContext: string;
        meta: { action: string };
      };
      scopedError.statusCode = 400;
      scopedError.code = "arc.validation_error";
      scopedError.validation = useErrors;
      scopedError.validationContext = "body";
      scopedError.meta = { action: submitted };
      throw scopedError;
    };

    // Auth (+ arc decorator) run at onRequest — BEFORE body parsing and AJV,
    // so unauthenticated callers get a 401 without paying validation cost or
    // learning the action schema from 400s. The validation formatter stays
    // FIRST in preHandler: `attachValidation` parks AJV errors at the
    // preValidation stage (after onRequest), so by preHandler time the
    // formatter sees them — and only authenticated callers reach it.
    const hooks = buildRouteHooks({
      arcDecorator,
      authMw,
      permissionMw,
      pluginMw: selectPluginMw("POST", pluginMw),
      routeGuards,
    });
    const preHandler = [actionValidationFormatter, ...hooks.preHandler];

    tryRegisterRoute(
      fastify,
      {
        method: "POST",
        url: urlPath,
        schema: routeSchema as FastifySchema,
        // `attachValidation: true` parks AJV errors on `request.validationError`
        // so the formatter above can re-throw with the matching action's scope.
        attachValidation: true,
        ...routeHookOptions({ onRequest: hooks.onRequest, preHandler }),
        ...buildRouteConfig(rateLimitConfig, extensions),
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { action, ...data } = req.body as { action: string; [key: string]: unknown };
          // For id-less mounts there's no `:id` param — pass empty string.
          // Handlers declared with `id: false` are documented to receive `""`.
          const id = hasId ? (req.params as { id: string }).id : "";

          // Layer per-request entity handle on top of the frozen resource
          // meta (`idField` rides on the meta set once by `buildArcDecorator`).
          // Skip for id-less routes — `entityId: ""` is useless and
          // `getEntityQuery(req)` callers shouldn't see it.
          if (hasId) {
            const reqWithExtras = req as RequestWithExtras;
            reqWithExtras.arc = {
              ...(reqWithExtras.arc ?? {}),
              entityId: id,
            };
          }

          // `buildActionPermissionMw` has rejected invalid actions / denied
          // permissions before we get here. The defensive fallback stays for
          // hosts that bypass the preHandler chain (internal invocation).
          const handler = wrappedHandlers.get(action);
          if (!handler) {
            throw createError(
              400,
              `Invalid action '${action}'. Valid actions: ${actionSubset.join(", ")}`,
              { validActions: actionSubset },
            );
          }

          try {
            const response = await handler(id, data, req as RequestWithExtras);
            sendControllerResponse(reply, response, req);
            // Return the reply (not the void result) so Fastify treats the
            // response as owned and doesn't race an async serialization hook
            // — same contract as `createFastifyHandler`. Without this, an
            // async `preSerialization` (payload encryption) flushes an empty
            // body first → ERR_HTTP_HEADERS_SENT.
            return reply;
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

            if (
              (error as { name?: string })?.name === "ArcError" ||
              error instanceof Error === false
            ) {
              throw error;
            }
            throw createError(
              statusCode,
              (err.message as string) || `Failed to execute '${action}' action`,
              { code: errorCode },
            );
          }
        },
      },
      { resourceName, op: `action${urlPath}` },
    );

    fastify.log.debug(
      { actions: actionSubset, mount: urlPath, tag, resourceName },
      "[createActionRouter] Registered action endpoint",
    );
  };

  // Two mounts for two intents. Id-bound is the legacy default; id-less
  // light up when the resource declares `id: false` actions.
  registerActionRoute({
    urlPath: "/:id/action",
    actionSubset: idBoundActionNames,
    hasId: true,
  });
  registerActionRoute({
    urlPath: "/action",
    actionSubset: idLessActions,
    hasId: false,
  });
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

// ============================================================================
// OpenAPI description helper
// ============================================================================

/**
 * Build OpenAPI description for an action mount from the action map + the
 * permission map for THAT mount's subset. Used by both `/:id/action` and
 * `/action` to render an "Available actions" list with role hints.
 */
function buildActionDescription(
  actions: Record<string, ActionHandler>,
  actionPermissions: Record<string, PermissionCheck>,
): string {
  const lines = ["Unified action endpoint for state transitions.\n\n**Available actions:**"];
  for (const action of Object.keys(actions)) {
    const perm = actionPermissions[action];
    const roles = (perm as PermissionCheck | undefined)?._roles;
    const roleStr = roles?.length ? ` (requires: ${roles.join(" or ")})` : "";
    lines.push(`- \`${action}\`${roleStr}`);
  }
  return lines.join("\n");
}
