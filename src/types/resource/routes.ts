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
 * - `handler: function` → arc pipeline + MCP tool (the normal form)
 * - `rawHandler: function` → raw Fastify handler → no pipeline, no MCP by default
 *   (streams, raw-body webhooks, files, redirects)
 */
export interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to resource prefix */
  readonly path: string;
  /**
   * Route handler: receives `IRequestContext`, returns `IControllerResponse`
   * (arc pipeline + MCP tool). To reach a controller method, call it:
   * `handler: (ctx) => controller.getStats(ctx)`. For a raw Fastify handler
   * `(request, reply)`, use {@link rawHandler}.
   *
   * The STRING form (a controller method name) is deprecated: it warns once per
   * process and is removed in the next minor.
   */
  readonly handler?: string | ControllerHandler;
  /**
   * Function-reference handler: receives the controller, returns the method.
   *
   * @deprecated Use a function `handler` that calls the controller method:
   * `handler: (ctx) => controller.getStats(ctx)`. Warns once per process;
   * removed in the next minor.
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
   * The STRING form (a controller method name) is deprecated: pass the function,
   * `rawHandler: (request, reply) => controller.download(request, reply)`. It
   * warns once per process and is removed in the next minor.
   *
   * An async raw handler that calls `reply.send()` must `return reply` (as `handleRaw`
   * does): resolving `undefined` while an async `preSerialization` hook runs sends an empty body.
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
   * The multiTenant preset's guard on this route. On a resource with `multiTenantPreset`:
   *
   * - omitted: a `handler` route gets the tenant filter (401 anonymous, 403 without an
   *   organization, rows pinned to the caller's), as CRUD and actions do; a preset route
   *   gets exactly what the CRUD route it maps to gets. A `rawHandler` route gets nothing.
   * - `true`: filter plus body injection (what `update` gets), on any route, raw included.
   * - `false`: no tenant middleware; the route handles tenancy itself.
   *
   * `true` without a multiTenant preset throws at boot.
   */
  readonly tenantScope?: boolean;
  /**
   * INTERNAL — the CRUD slot whose tenant middlewares a built-in preset route shares
   * (`slugLookup` → `get`, `tree` → `list`). Hosts must not set this.
   *
   * @internal
   */
  readonly _tenantSlot?: "list" | "get" | "create" | "update" | "delete";
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
