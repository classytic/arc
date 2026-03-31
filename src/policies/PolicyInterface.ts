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
 *       allowed: getUserRoles(user).includes('admin'),
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

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PermissionCheck } from "../permissions/types.js";

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
 *     if (!getUserRoles(user).some(r => allowedRoles.includes(r))) {
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
  can(user: any, operation: string, context?: PolicyContext): PolicyResult | Promise<PolicyResult>;

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
  toMiddleware(operation: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
/**
 * Access control statement
 *
 * Maps to Better Auth's organization permission model
 * where permissions are defined as resource + action pairs.
 */
export interface AccessControlStatement {
  /** Resource name (e.g., 'product', 'order') */
  resource: string;
  /** Allowed actions on this resource */
  action: string[];
}

/**
 * Options for createAccessControlPolicy
 */
export interface AccessControlPolicyOptions {
  /** Permission statements defining resource-action pairs */
  statements: AccessControlStatement[];
  /**
   * Optional async permission check against external source (e.g., org role permissions).
   * Called when the static statements allow the action — use this for dynamic checks
   * like verifying the user's org role actually grants the permission.
   *
   * @param userId - ID of the user
   * @param resource - Resource being accessed
   * @param action - Action being performed
   * @returns Whether the user has the permission
   */
  checkPermission?: (userId: string, resource: string, action: string) => Promise<boolean>;
}

/**
 * Create a PermissionCheck from access control statements.
 *
 * Maps Better Auth's statement-based access control model to Arc's
 * PermissionCheck function, which can be used directly in resource permissions.
 *
 * The returned PermissionCheck:
 * 1. Looks up the resource + action in the statements list
 * 2. If no matching statement exists, denies access
 * 3. If a matching statement exists and `checkPermission` is provided,
 *    calls it for dynamic verification (e.g., check org role)
 * 4. If `checkPermission` is not provided, allows access based on static statements
 *
 * @example Static statements only
 * ```typescript
 * import { createAccessControlPolicy } from '@classytic/arc/policies';
 *
 * const editorPermissions = createAccessControlPolicy({
 *   statements: [
 *     { resource: 'product', action: ['create', 'update'] },
 *     { resource: 'order', action: ['read'] },
 *   ],
 * });
 *
 * // Use in resource config
 * defineResource({
 *   name: 'product',
 *   permissions: {
 *     create: editorPermissions,
 *     update: editorPermissions,
 *   },
 * });
 * ```
 *
 * @example With dynamic permission check (Better Auth org roles)
 * ```typescript
 * const policy = createAccessControlPolicy({
 *   statements: [
 *     { resource: 'product', action: ['create', 'update'] },
 *     { resource: 'order', action: ['read'] },
 *   ],
 *   checkPermission: async (userId, resource, action) => {
 *     return hasOrgPermission(userId, resource, action);
 *   },
 * });
 * ```
 */
export function createAccessControlPolicy(options: AccessControlPolicyOptions): PermissionCheck {
  // Pre-compute a lookup map: resource -> Set<action> for O(1) checks
  const statementMap = new Map<string, Set<string>>();
  for (const statement of options.statements) {
    const existing = statementMap.get(statement.resource);
    if (existing) {
      for (const action of statement.action) {
        existing.add(action);
      }
    } else {
      statementMap.set(statement.resource, new Set(statement.action));
    }
  }

  const permissionCheck: PermissionCheck = async (context) => {
    const { user, resource, action } = context;

    // Check if the action is allowed by any statement
    const allowedActions = statementMap.get(resource);
    if (!allowedActions?.has(action)) {
      return {
        granted: false,
        reason: `Action '${action}' is not permitted on resource '${resource}'`,
      };
    }

    // If a dynamic permission check is provided, verify against it
    if (options.checkPermission) {
      const userId = user?.id ?? user?._id;
      if (!userId) {
        return {
          granted: false,
          reason: "Authentication required",
        };
      }

      const hasPermission = await options.checkPermission(String(userId), resource, action);
      if (!hasPermission) {
        return {
          granted: false,
          reason: `User does not have '${action}' permission on '${resource}'`,
        };
      }
    }

    return { granted: true };
  };

  return permissionCheck;
}

declare module "fastify" {
  interface FastifyRequest {
    policyResult?: PolicyResult;
  }
}
