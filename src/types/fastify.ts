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
   * Arc metadata — set by createCrudRouter. Contains resource configuration
   * and schema options.
   */
  arc?: {
    resourceName?: string;
    schemaOptions?: import("./resource.js").RouteSchemaOptions;
    permissions?: import("./resource.js").ResourcePermissions;
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
