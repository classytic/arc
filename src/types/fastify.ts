/**
 * Fastify-specific Types — extras on FastifyRequest, decorators on
 * FastifyInstance, middleware-handler signature.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import "./base.js";

export interface FastifyRequestExtras {
  user?: Record<string, unknown>;
}

export interface RequestWithExtras extends FastifyRequest {
  /**
   * Arc metadata — set by createCrudRouter / createActionRouter / etc.
   * Contains resource configuration and runtime resolution of the URL
   * `:id` path param into the resource's `idField`.
   */
  arc?: {
    resourceName?: string;
    schemaOptions?: import("./resource.js").RouteSchemaOptions;
    permissions?: import("./resource.js").ResourcePermissions;
    /**
     * The configured `idField` for this resource (e.g. `_id`, `slug`,
     * `reportId`). Set by routers that bind a path `:id` segment so
     * handlers can compose the right query without remembering the
     * resource-config detail.
     *
     * Use `getEntityQuery(req)` for the canonical
     * `{ [idField]: entityId }` filter shape — saves the action handler
     * from a typo class where `Model.findById(id)` silently fails when
     * `idField !== "_id"`.
     */
    idField?: string;
    /**
     * The current request's `:id` path-param value, surfaced verbatim.
     * For most resources this equals `req.params.id`; we mirror it on
     * `req.arc` so middleware that doesn't have a typed `params` shape
     * can still read the entity handle.
     */
    entityId?: string;
  };
  context?: Record<string, unknown>;
  _policyFilters?: Record<string, unknown>;
  fieldMask?: { include?: string[]; exclude?: string[] };
  _ownershipCheck?: Record<string, unknown>;
}

export type FastifyWithAuth = FastifyInstance & {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

/**
 * Arc core decorator — added by `arcCorePlugin`. Provides instance-scoped
 * hooks and resource registry.
 */
export interface ArcDecorator {
  hooks: import("../hooks/HookSystem.js").HookSystem;
  registry: import("../registry/ResourceRegistry.js").ResourceRegistry;
  /** Whether event emission is enabled */
  emitEvents: boolean;
}

/** Events decorator — added by `eventPlugin`. Provides event pub/sub. */
export interface EventsDecorator {
  publish: <T>(
    type: string,
    payload: T,
    meta?: Partial<{ id: string; timestamp: Date }>,
  ) => Promise<void>;
  /**
   * Subscribe to an event pattern. Handler receives the full
   * `DomainEvent<T> = { type, payload, meta }` envelope — destructure
   * `payload` if you only need the body, or read `meta.correlationId` /
   * `meta.timestamp` for tracing. See CHANGELOG 2.10 for the migration
   * note from 2.9.x's loose `unknown` type.
   */
  subscribe: <T = unknown>(
    pattern: string,
    handler: (event: import("../events/EventTransport.js").DomainEvent<T>) => void | Promise<void>,
  ) => Promise<() => void>;
  transportName: string;
}

/**
 * Fastify instance with Arc decorators. Arc adds these via plugins/presets.
 */
export type FastifyWithDecorators = FastifyInstance & {
  arc?: ArcDecorator;
  events?: EventsDecorator;
  authenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  optionalAuthenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Organization-scoped filtering — from `multiTenant` preset */
  organizationScoped?: (options?: { required?: boolean }) => RouteHandlerMethod;
  [key: string]: unknown;
};

/** Handler signature for middleware functions. */
export type MiddlewareHandler = (
  request: RequestWithExtras,
  reply: FastifyReply,
) => Promise<unknown>;
