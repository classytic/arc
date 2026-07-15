/**
 * Action types (v2.8) — state-transition handlers mounted on the unified
 * `POST /:id/action` (or `POST /action`) endpoint.
 */

import type { PermissionCheck } from "../../permissions/types.js";
import type { RequestWithExtras } from "../fastify.js";
import type { RouteMcpConfig } from "./routes.js";

/**
 * Action handler function for state transitions. Receives the resource
 * ID, action-specific data, and the request.
 */
export type ActionHandlerFn = (
  id: string,
  data: Record<string, unknown>,
  req: RequestWithExtras,
) => Promise<unknown>;

/**
 * Full action configuration with handler, permissions, and schema.
 *
 * Rate limiting is intentionally NOT per-action: every action shares one
 * `POST /:id/action` (or `POST /action`) mount, so Fastify's per-route limit
 * can't distinguish them. Actions inherit the resource-level `rateLimit`; to
 * throttle a specific operation, promote it to a `routes:` entry (which
 * supports `RouteDefinition.rateLimit`).
 */
export interface ActionDefinition {
  readonly handler: ActionHandlerFn;
  /** Per-action permission (overrides resource-level `actionPermissions`) */
  readonly permissions?: PermissionCheck;
  /**
   * JSON Schema or Zod v4 schema for action-specific body fields.
   *
   * Typed `unknown` (not `Record<string, unknown>`) so Zod class instances
   * — `ZodObject<...>` carries no string index signature — assign without
   * a cast. Same convention as `RouteDefinition.schema.body` / `customSchemas`.
   * Runtime feature-detects via `convertRouteSchema` / `toJsonSchema`.
   */
  readonly schema?: unknown;
  /** Description for OpenAPI docs and MCP tool */
  readonly description?: string;
  /**
   * Whether this action needs an entity id from the URL.
   *
   * - `true` (default) — mounts under `POST /<prefix>/:id/action`. The `id`
   *   path param is required; handler receives it as the first argument.
   *   Use for actions that operate on an existing entity: `approve`,
   *   `dispatch`, `cancel`, `archive`.
   * - `false` — mounts under `POST /<prefix>/action` (no `:id` segment).
   *   Handler receives an empty-string first argument. Use for
   *   collection-level actions that create / search / bulk-mutate:
   *   `propose` (creates a new entity), `search` (returns rows), `bulk`.
   *
   * 2.15.5: previously every action had to live under `:id/action`, forcing
   * `propose`-style actions to swallow a meaningless URL parameter and
   * making the auto-generated MCP tool advertise an `id` field agents
   * had no value for. Setting `id: false` mounts the action at the
   * resource root and drops `id` from the MCP tool's input shape.
   */
  readonly id?: boolean;
  /**
   * MCP tool generation:
   * - omitted/true: auto-generate
   * - false: skip
   * - object: explicit config
   */
  readonly mcp?: boolean | RouteMcpConfig;
}

/** Action config: bare handler function OR full ActionDefinition. */
export type ActionEntry = ActionHandlerFn | ActionDefinition;

/** Actions configuration map. */
export type ActionsMap = Record<string, ActionEntry>;
