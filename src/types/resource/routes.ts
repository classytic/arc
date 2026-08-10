/**
 * Custom-route types — `RouteDefinition` (the single custom-route
 * shape), the HTTP method union, and per-route/action MCP config.
 */

import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { RouteCorsConfig } from "../../core/middlewares/rateLimit.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ControllerHandler, RawRouteHandler } from "../handlers.js";
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
 * - `rawHandler` → raw Fastify handler → no pipeline, no MCP by default
 */
export interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to resource prefix */
  readonly path: string;
  /**
   * Route handler.
   * - String: controller method name (Arc pipeline) — runtime lookup, no TS coverage on typos.
   * - Function: receives IRequestContext, returns IControllerResponse (Arc pipeline)
   * - For a raw Fastify handler `(request, reply)`, use {@link rawHandler}
   *
   * Prefer `controllerMethod` (2.16) over the string form when you want the
   * compiler to catch typos. `handler` stays optional when `controllerMethod`
   * is set — exactly one of the two must be declared.
   */
  readonly handler?: string | ControllerHandler;
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
   * PIPELINE-ONLY: the referenced method is invoked as a `ControllerHandler`
   * (one `IRequestContext`), because the router derives "is this raw?" from
   * {@link rawHandler} alone and this field is mutually exclusive with it.
   * There is no flag that could make a `controllerMethod` route raw. For a
   * Fastify-native controller method, put its NAME in `rawHandler` — the
   * lookup is the same, and the field states the calling convention.
   *
   * Mutually exclusive with `handler` — passing both throws at boot
   * with a clear "pick one" message.
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
  readonly controllerMethod?: (controller: unknown) => ControllerHandler;
  /** Permission check — REQUIRED */
  readonly permissions: PermissionCheck;
  /**
   * PUBLISH this route's gate in the permission matrix, under this key.
   *
   * ## Why a route needs to opt in, when CRUD and actions do not
   *
   * `introspectRegistry` walks `permissions`, `actions` and `aggregations` —
   * each of which has a stable NAME to key by. A route has only a method and a
   * path, and a path is not an identity: `/recompute` becoming
   * `/classification/recompute` would silently break every client gating on it.
   * So routes were skipped, and the consequence was not a missing feature but an
   * invisible one — a resource whose gates live entirely on `routes[]` publishes
   * NOTHING, is absent from the matrix, and every `can()` against it returns
   * `false`. A UI that gates on it hides the feature from everyone including
   * admins, which reads as "my permissions are broken" rather than "this key was
   * never published".
   *
   * Declaring `capability` gives the gate the stable name it was missing. The key
   * is BARE, sitting alongside `list` / `get` / `create` — a consumer asks
   * `can('sku-classification', 'recompute')` and does not need to know whether
   * the verb is implemented as a route, an action or a CRUD slot.
   *
   * Omit it for routes nothing needs to gate a UI on (a health check, a public
   * manifest). The route is still ENFORCED either way — this only controls
   * whether clients can SEE the decision in advance.
   *
   * Collides with a CRUD slot, an `action:`, an `agg:` or another route on the
   * same resource ⇒ `defineResource()` THROWS at boot. A silent overwrite would
   * let one gate answer for a different verb, and `introspectRegistry` refuses
   * the same collision as a backstop for hand-built registry entries.
   *
   * @example
   * { method: 'POST', path: '/recompute', capability: 'recompute',
   *   permissions: requireRoles(['admin']) }
   */
  readonly capability?: string;
  /**
   * Fastify-native handler — receives `(request, reply)` and owns the response.
   * Bypasses arc's pipeline entirely: no `IControllerResponse` shaping, no
   * field-write sanitization.
   *
   * Mutually exclusive with {@link handler}. The FIELD carries the intent, so
   * there is no flag to forget: the previous `raw: boolean` let a Fastify-shaped
   * function sit in `handler` without it (silently run through the pipeline) or
   * a pipeline handler sit there with it (silently unwrapped), and neither
   * mismatch was a type error.
   *
   * Splitting the two also restores inference. One field carrying both shapes
   * meant a union of several function types, which has no single contextual
   * signature — so an inline `handler: async (req) => …` reported TS7006 and
   * every author annotated `req` by hand. Fastify types its own
   * `RouteOptions.handler` as ONE function type for exactly this reason; see
   * {@link RawRouteHandler} for why arc declares its own rather than reusing
   * `RouteHandlerMethod` directly.
   *
   * Accepts a controller-method NAME as well, same as {@link handler} — the
   * lookup is identical and only the calling convention differs, so a
   * Fastify-native controller method stays reachable by name.
   */
  readonly rawHandler?: string | RawRouteHandler;
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
   * SSE streaming mode. Requires {@link rawHandler} — the handler is invoked
   * with `(request, reply)` and owns the response. Two shapes work:
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
   * `rawHandler` routes ALWAYS bypass this — they've opted out of the
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
   * Per-route CORS override, forwarded to `@fastify/cors` as
   * `routeOptions.config.cors`. `undefined` inherits the app policy; `false`
   * disables CORS for this route; an object replaces the app policy for it.
   *
   * Needed because one app-wide policy cannot serve both an API and a public
   * asset: an API wants `credentials: true` with a pinned origin list, a public
   * asset wants `origin: "*"`, and `*` + credentials is forbidden by the spec
   * (arc throws at boot on that pair).
   *
   * ```ts
   * { method: "GET", path: "/manifest.json", permissions: allowPublic(),
   *   cors: { origin: "*", credentials: false }, handler }
   * ```
   */
  readonly cors?: RouteCorsConfig;
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
   * Fastify route CONFIG — `reply.routeOptions.config` at request time.
   *
   * Fastify's own first-class route option (Reference/Routes.md § Config), passed
   * straight through. Arc adds no semantics: it is the documented seam every Fastify
   * plugin uses to take per-route options, and arc forwarding it is what makes those
   * plugins reachable from a `defineResource` route at all.
   *
   * ## Why this is not optional polish
   *
   * Arc REGISTERS `fastify-raw-body` with `global: false` (see `registerSecurity`),
   * which means a route opts in with `config: { rawBody: true }`. Without this field
   * that opt-in had nowhere to live, so the plugin arc itself installs was
   * unreachable from any resource — and a route that wrote it got no error, just a
   * silently absent `request.rawBody`.
   *
   * The cost of that was found end-to-end, not by review: every HMAC-signed webhook
   * verified its signature against a body it never received, so a real provider
   * callback 401'd in production while every unit test passed.
   *
   * @example
   * // Signature verification needs the exact transmitted bytes.
   * { method: 'POST', path: '/webhooks', config: { rawBody: true }, rawHandler }
   *
   * @example
   * // Anything a plugin reads per-route — rate-limit overrides, feature flags.
   * { method: 'GET', path: '/report', config: { rateLimit: { max: 5 } } }
   */
  readonly config?: Record<string, unknown>;

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
