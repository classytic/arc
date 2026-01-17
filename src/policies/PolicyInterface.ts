/**
 * Policy Interface
 *
 * Pluggable authorization interface for Arc.
 * Apps implement this interface to define custom authorization strategies.
 *
 * @example RBAC Policy
 * ```typescript
 * class RBACPolicy implements PolicyEngine {
 *   can(user, operation, context) {
 *     return {
 *       allowed: user.roles.includes('admin'),
 *       reason: 'Admin role required',
 *     };
 *   }
 *   toMiddleware(operation) {
 *     return async (request, reply) => {
 *       const result = await this.can(request.user, operation);
 *       if (!result.allowed) {
 *         reply.code(403).send({ error: result.reason });
 *       }
 *     };
 *   }
 * }
 * ```
 *
 * @example ABAC (Attribute-Based) Policy
 * ```typescript
 * class ABACPolicy implements PolicyEngine {
 *   can(user, operation, context) {
 *     return {
 *       allowed: this.evaluateAttributes(user, operation, context),
 *       filters: { department: user.department },
 *       fieldMask: { exclude: ['salary', 'ssn'] },
 *     };
 *   }
 *   // ...
 * }
 * ```
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Policy result returned by can() method
 */
export interface PolicyResult {
  /**
   * Whether the operation is allowed
   */
  allowed: boolean;

  /**
   * Human-readable reason if denied
   * Returned in 403 error responses
   */
  reason?: string;

  /**
   * Query filters to apply (for list operations)
   *
   * @example
   * ```typescript
   * // Multi-tenant filter
   * { organizationId: user.organizationId }
   *
   * // Ownership filter
   * { userId: user.id }
   *
   * // Complex filter
   * { $or: [{ public: true }, { createdBy: user.id }] }
   * ```
   */
  filters?: Record<string, any>;

  /**
   * Fields to include/exclude in response
   *
   * @example
   * ```typescript
   * // Hide sensitive fields from non-admins
   * { exclude: ['password', 'ssn', 'salary'] }
   *
   * // Only show specific fields
   * { include: ['name', 'email', 'role'] }
   * ```
   */
  fieldMask?: {
    include?: string[];
    exclude?: string[];
  };

  /**
   * Additional context for downstream middleware
   *
   * @example
   * ```typescript
   * {
   *   auditLog: { action: 'read', resource: 'patient', userId: user.id },
   *   rateLimit: { tier: user.subscriptionTier },
   * }
   * ```
   */
  metadata?: Record<string, any>;
}

/**
 * Policy context provided to can() method
 */
export interface PolicyContext {
  /**
   * The document being accessed (for update/delete/get)
   * Populated by fetchDocument middleware
   */
  document?: any;

  /**
   * Request body (for create/update)
   */
  body?: any;

  /**
   * Request params (e.g., :id from route)
   */
  params?: any;

  /**
   * Request query parameters
   */
  query?: any;

  /**
   * Additional app-specific context
   * Can include anything your policy needs to make decisions
   */
  [key: string]: any;
}

/**
 * Policy Engine Interface
 *
 * Implement this interface to create your own authorization strategy.
 *
 * Arc provides the interface, apps provide the implementation.
 * This follows the same pattern as:
 * - Database drivers (interface: query(), implementation: PostgreSQL, MySQL)
 * - Storage providers (interface: upload(), implementation: S3, Azure)
 * - Authentication strategies (interface: verify(), implementation: JWT, OAuth)
 *
 * @example E-commerce RBAC + Ownership
 * ```typescript
 * class EcommercePolicyEngine implements PolicyEngine {
 *   constructor(private config: { roles: Record<string, string[]> }) {}
 *
 *   can(user, operation, context) {
 *     // Check RBAC
 *     const allowedRoles = this.config.roles[operation] || [];
 *     if (!user.roles.some(r => allowedRoles.includes(r))) {
 *       return { allowed: false, reason: 'Insufficient permissions' };
 *     }
 *
 *     // Check ownership for update/delete
 *     if (['update', 'delete'].includes(operation)) {
 *       if (context.document.userId !== user.id) {
 *         return { allowed: false, reason: 'Not the owner' };
 *       }
 *     }
 *
 *     // Multi-tenant filter for list
 *     if (operation === 'list') {
 *       return {
 *         allowed: true,
 *         filters: { organizationId: user.organizationId },
 *       };
 *     }
 *
 *     return { allowed: true };
 *   }
 *
 *   toMiddleware(operation) {
 *     return async (request, reply) => {
 *       const result = await this.can(request.user, operation, {
 *         document: request.document,
 *         body: request.body,
 *         params: request.params,
 *         query: request.query,
 *       });
 *
 *       if (!result.allowed) {
 *         reply.code(403).send({ error: result.reason });
 *       }
 *
 *       // Attach filters/fieldMask to request
 *       request.policyResult = result;
 *     };
 *   }
 * }
 * ```
 *
 * @example HIPAA Compliance
 * ```typescript
 * class HIPAAPolicyEngine implements PolicyEngine {
 *   can(user, operation, context) {
 *     // Check patient consent
 *     // Verify user certifications
 *     // Check data sensitivity level
 *     // Create audit log entry
 *
 *     return {
 *       allowed: this.checkHIPAACompliance(user, operation, context),
 *       reason: 'HIPAA compliance check failed',
 *       metadata: {
 *         auditLog: this.createAuditEntry(user, operation),
 *       },
 *     };
 *   }
 *
 *   toMiddleware(operation) {
 *     // HIPAA-specific middleware with audit logging
 *   }
 * }
 * ```
 */
export interface PolicyEngine {
  /**
   * Check if user can perform operation
   *
   * @param user - User object from request (request.user)
   * @param operation - Operation name (list, get, create, update, delete, custom)
   * @param context - Additional context (document, body, params, query, etc.)
   * @returns Policy result with allowed/denied and optional filters/fieldMask
   *
   * @example
   * ```typescript
   * const result = await policy.can(request.user, 'update', {
   *   document: existingDocument,
   *   body: request.body,
   * });
   *
   * if (!result.allowed) {
   *   throw new Error(result.reason);
   * }
   * ```
   */
  can(
    user: any,
    operation: string,
    context?: PolicyContext
  ): PolicyResult | Promise<PolicyResult>;

  /**
   * Generate Fastify middleware for this policy
   *
   * Called during route registration to create preHandler middleware.
   * Middleware should:
   * 1. Call can() with request context
   * 2. Return 403 if denied
   * 3. Attach result to request for downstream use
   *
   * @param operation - Operation name (list, get, create, update, delete)
   * @returns Fastify preHandler middleware
   *
   * @example
   * ```typescript
   * const middleware = policy.toMiddleware('update');
   * fastify.put('/products/:id', {
   *   preHandler: [authenticate, middleware],
   * }, handler);
   * ```
   */
  toMiddleware(
    operation: string
  ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Policy factory function signature
 *
 * Policies are typically created via factory functions that accept configuration.
 *
 * @example
 * ```typescript
 * export function definePolicy(config: PolicyConfig): PolicyEngine {
 *   return new MyPolicyEngine(config);
 * }
 *
 * // Usage
 * const productPolicy = definePolicy({
 *   resource: 'product',
 *   roles: { list: ['user'], create: ['admin'] },
 *   ownership: { field: 'userId', operations: ['update', 'delete'] },
 * });
 * ```
 */
export type PolicyFactory<TConfig = any> = (config: TConfig) => PolicyEngine;

/**
 * Extended Fastify request with policy result
 */
declare module 'fastify' {
  interface FastifyRequest {
    policyResult?: PolicyResult;
  }
}
