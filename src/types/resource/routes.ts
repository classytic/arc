/**
 * Custom-route types — `RouteDefinition` (the single custom-route
 * shape), the HTTP method union, and per-route/action MCP config.
 */

import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ControllerHandler } from "../handlers.js";
import type { RateLimitConfig } from "./rate-limit.js";

/** HTTP methods for custom routes. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** MCP tool configuration for a route or action. */
export interface RouteMcpConfig {
  /** Override auto-generated tool description */
  readonly description?: string;
  /** MCP tool annotations */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

/**
 * Route definition — single custom-route shape (user-facing + internal).
 *
 * - `handler: 'string'` → controller method → full Arc pipeline + MCP tool
 * - `handler: function` → inline handler → full Arc pipeline + MCP tool
 * - `raw: true` → raw Fastify handler → no pipeline, no MCP by default
 */
export interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to resource prefix */
  readonly path: string;
  /**
   * Route handler.
   * - String: controller method name (Arc pipeline) — runtime lookup, no TS coverage on typos.
   * - Function without `raw: true`: receives IRequestContext, returns IControllerResponse (Arc pipeline)
   * - Function with `raw: true`: raw Fastify handler `(request, reply)`
   *
   * Prefer `controllerMethod` (2.16) over the string form when you want the
   * compiler to catch typos. `handler` stays optional when `controllerMethod`
   * is set — exactly one of the two must be declared.
   */
  readonly handler?:
    | string
    | ControllerHandler
    | RouteHandlerMethod
    // Raw-handler escape hatch. `never` in the contravariant parameter
    // positions lets TYPED request generics assign without casting —
    // `(req: FastifyRequest<{ Body: CreateBody }>, reply) => …` is not
    // assignable to a `FastifyRequest<Record<string, unknown>>` parameter
    // under strictFunctionTypes, but every concrete handler signature
    // satisfies the `never`-parameter form (the same variance pattern as
    // utils/circuitBreaker's AnyAsyncFn). Runtime always passes the real
    // (request, reply) pair.
    | ((request: never, reply: never) => unknown);
  /**
   * Typed function-reference handler (2.16). Receives the live controller
   * instance and returns the method to invoke — TypeScript catches typos
   * and surfaces autocomplete on the controller's method names. Prefer
   * this over the string `handler` form for any host that uses a typed
   * controller subclass.
   *
   * Resolved ONCE at route-registration time (the same path string
   * handlers go through), so there's no per-request lookup overhead.
   * The returned method is bound to the controller before dispatch.
   *
   * Mutually exclusive with `handler` — passing both throws at boot
   * with a clear "pick one" message. The runtime contract on what the
   * returned function accepts mirrors the `handler` rules: a plain
   * `ControllerHandler` for pipeline routes, a raw Fastify handler when
   * the route is `raw: true`.
   *
   * Typed loosely (`(controller: unknown) => …`) at the type-system
   * boundary because `RouteDefinition` is not generic over the
   * controller shape — host code annotates the parameter to opt in:
   *
   * @example
   * ```ts
   * class PostController extends BaseController<Post> {
   *   async getStats(ctx: IRequestContext) { … }
   * }
   *
   * defineResource({
   *   controller: new PostController(repo),
   *   routes: [{
   *     method: 'GET',
   *     path: '/stats',
   *     controllerMethod: (c: PostController) => c.getStats,
   *     //                       ^^^^^^^^^^^^^^ TS catches typos here
   *     permissions: requireAuth(),
   *   }],
   * });
   * ```
   */
  readonly controllerMethod?: (controller: unknown) => ControllerHandler | RouteHandlerMethod;
  /** Permission check — REQUIRED */
  readonly permissions: PermissionCheck;
  /**
   * Raw mode — bypasses Arc pipeline. Handler receives raw Fastify
   * request/reply. Default: false.
   */
  readonly raw?: boolean;
  /** Logical operation name (pipeline keys, MCP tool naming). */
  readonly operation?: string;
  /** OpenAPI summary */
  readonly summary?: string;
  /** OpenAPI description */
  readonly description?: string;
  /** OpenAPI tags */
  readonly tags?: string[];
  /** Route-level middleware */
  readonly preHandler?: RouteHandlerMethod[] | ((fastify: FastifyInstance) => RouteHandlerMethod[]);
  /** Pre-auth handlers (run before authentication) */
  readonly preAuth?: RouteHandlerMethod[];
  /**
   * Opt this custom route into the multiTenant preset's tenant scoping.
   *
   * When `true` AND the resource declares `multiTenantPreset` (or
   * `flexibleMultiTenantPreset`), arc prepends the preset's tenant
   * filter + injection middleware to this route's chain — the same
   * pair `update` gets. The handler can then read the resolved tenant
   * via `getOrgId(req.scope)` / `req._tenantFields` (or, for write
   * routes, off `req.body` after injection) without re-implementing
   * the scope read + header fallback + 400 boilerplate.
   *
   * Throws at boot if set when no multiTenant preset is wired — the
   * misconfiguration would otherwise be silently insecure (read routes
   * returning every tenant's rows).
   *
   * @default false
   */
  readonly tenantScope?: boolean;
  /**
   * SSE streaming mode. Two handler shapes work:
   *
   * - Write to `reply.raw` directly (NDJSON, custom SSE — historical contract).
   * - Return a Web `ReadableStream` (Vercel AI SDK's `result.toUIMessageStream()`,
   *   `fetch().body`, etc.). 2.17.1+ auto-pipes these through
   *   `pipeUIMessageStreamToReply()` so each chunk is JSON-encoded into
   *   an SSE `data:` frame and client-disconnect cancels the source.
   *   Pre-2.17.1 this crashed with `chunk must be a string or Buffer`.
   */
  readonly streamResponse?: boolean;
  /**
   * INTERNAL — marker stamped by built-in presets (softDelete, tree, …)
   * onto routes they emit. Read by the MCP collision detector
   * (`createMcpServer.resolveToolCollisions`) to attribute the route
   * source ("preset:softDelete vs user `actions.restore`") and to
   * auto-namespace the preset side when a user-authored tool legitimately
   * shadows it. Not part of the public surface — hosts must not set this.
   *
   * @internal
   */
  readonly _presetSource?: string;
  /**
   * Apply the resource's `fields` (field-level write permissions) to this
   * custom route's request body.
   *
   * Default: `true` for body-bearing methods (POST/PUT/PATCH), `false`
   * otherwise. Set to `false` to opt out — handler accepts the body as
   * supplied with no field-write filtering. The resource-level
   * `onFieldWriteDenied: 'reject' | 'strip'` setting governs how denials
   * are surfaced.
   *
   * `raw: true` routes ALWAYS bypass this — they've opted out of the
   * pipeline entirely.
   */
  readonly fieldWrite?: boolean;
  /**
   * Per-route rate limit. A custom route is its own Fastify route, so this
   * overrides the resource-level `rateLimit` for THIS endpoint only:
   *
   *   - omitted                → inherit the resource-level limit (or app default)
   *   - `false`                → disable rate limiting on this route
   *   - `{ max, timeWindow }`  → apply this specific limit
   *
   * Requires `@fastify/rate-limit` registered (arc's factory wires it by
   * default). Use for an expensive `/export` or an auth-sensitive `/reset`
   * that needs a tighter cap than the resource's read-heavy CRUD, or `false`
   * on an internal health/webhook route that must not be throttled.
   *
   * Note: this is per-route because each custom route is a distinct endpoint.
   * `actions` share ONE `POST /:id/action` mount by design, so a per-ACTION
   * limit can't be expressed here — throttle a specific action by promoting
   * it to a dedicated `routes:` entry, or rely on the resource-level limit.
   */
  readonly rateLimit?: RateLimitConfig | false;
  /**
   * Fastify route schema. Each slot (`body`, `querystring`, `params`,
   * `headers`, `response[status]`) accepts a plain JSON Schema object
   * **or** a Zod v4 schema — Arc auto-converts via `convertRouteSchema`.
   */
  readonly schema?: {
    body?: unknown;
    querystring?: unknown;
    params?: unknown;
    headers?: unknown;
    response?: Record<number | string, unknown>;
    [key: string]: unknown;
  };
  /**
   * MCP tool generation:
   * - omitted/true: auto-generate (non-raw routes only)
   * - false: skip MCP
   * - object: explicit config
   */
  readonly mcp?: boolean | RouteMcpConfig;
  /**
   * MCP handler for raw routes — parallel entry point for MCP without
   * changing the HTTP handler.
   */
  readonly mcpHandler?: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}
