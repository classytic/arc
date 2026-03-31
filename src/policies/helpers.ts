/**
 * Policy Helper Utilities
 *
 * Common operations for working with PolicyEngine implementations.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PolicyEngine, PolicyResult } from "./PolicyInterface.js";

/**
 * Helper to create Fastify middleware from any PolicyEngine implementation
 *
 * This is a convenience function that provides a standard middleware pattern.
 * Most policies can use this instead of implementing toMiddleware() manually.
 *
 * @param policy - Policy engine instance
 * @param operation - Operation name (list, get, create, update, delete)
 * @returns Fastify preHandler middleware
 *
 * @example
 * ```typescript
 * class SimplePolicy implements PolicyEngine {
 *   can(user, operation) {
 *     return { allowed: user.isActive };
 *   }
 *
 *   toMiddleware(operation) {
 *     return createPolicyMiddleware(this, operation);
 *   }
 * }
 * ```
 */
export function createPolicyMiddleware(
  policy: PolicyEngine,
  operation: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function policyMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Build context from request
    const context = {
      document: request.document,
      body: request.body,
      params: request.params,
      query: request.query,
    };

    // Check policy
    const result = await policy.can(request.user, operation, context);

    if (!result.allowed) {
      return reply.code(403).send({
        success: false,
        error: "Access denied",
        message: result.reason || "You do not have permission to perform this action",
      });
    }

    // Attach result to request for downstream use
    request.policyResult = result;

    // Apply policy filters on trusted location (for list operations)
    if (result.filters && Object.keys(result.filters).length > 0) {
      request._policyFilters = result.filters;
    }

    // Apply field mask (for response serialization)
    if (result.fieldMask) {
      request.fieldMask = result.fieldMask;
    }

    // Attach metadata (for downstream middleware/logging)
    if (result.metadata) {
      request.policyMetadata = result.metadata;
    }
  };
}

/**
 * Combine multiple policies with AND logic
 *
 * All policies must allow the operation for it to succeed.
 * First denial stops evaluation and returns the denial reason.
 *
 * @param policies - Array of policy engines to combine
 * @returns Combined policy engine
 *
 * @example
 * ```typescript
 * const combinedPolicy = combinePolicies(
 *   rbacPolicy,        // Must have correct role
 *   ownershipPolicy,   // Must own the resource
 *   auditPolicy,       // Logs access for compliance
 * );
 *
 * // All three policies must pass for the operation to succeed
 * const result = await combinedPolicy.can(user, 'update', context);
 * ```
 *
 * @example Multi-tenant + RBAC
 * ```typescript
 * const policy = combinePolicies(
 *   definePolicy({ tenant: { field: 'organizationId' } }),
 *   definePolicy({ roles: { update: ['admin', 'editor'] } }),
 * );
 * ```
 */
export function combinePolicies(...policies: PolicyEngine[]): PolicyEngine {
  if (policies.length === 0) {
    throw new Error("combinePolicies requires at least one policy");
  }

  if (policies.length === 1) {
    return policies[0]!;
  }

  return {
    async can(user: any, operation: string, context?: any): Promise<PolicyResult> {
      const results: PolicyResult[] = [];

      for (const policy of policies) {
        const result = await policy.can(user, operation, context);

        if (!result.allowed) {
          // First denial stops evaluation
          return result;
        }

        results.push(result);
      }

      // Merge all results
      const mergedResult: PolicyResult = {
        allowed: true,
        filters: {},
        metadata: {},
      };

      // Merge filters (AND logic - all filters must match)
      for (const result of results) {
        if (result.filters) {
          Object.assign(mergedResult.filters!, result.filters);
        }
      }

      // Merge field masks (union of excludes, intersection of includes)
      const allExcludes = new Set<string>();
      const allIncludes: Set<string>[] = [];

      for (const result of results) {
        if (result.fieldMask?.exclude) {
          for (const field of result.fieldMask.exclude) allExcludes.add(field);
        }
        if (result.fieldMask?.include) {
          allIncludes.push(new Set(result.fieldMask.include));
        }
      }

      if (allExcludes.size > 0 || allIncludes.length > 0) {
        mergedResult.fieldMask = {};

        if (allExcludes.size > 0) {
          mergedResult.fieldMask.exclude = Array.from(allExcludes);
        }

        if (allIncludes.length > 0) {
          // Intersection of all includes
          const intersection = allIncludes.reduce((acc, set) => {
            return new Set([...acc].filter((x) => set.has(x)));
          });
          if (intersection.size > 0) {
            mergedResult.fieldMask.include = Array.from(intersection);
          }
        }
      }

      // Merge metadata
      for (const result of results) {
        if (result.metadata) {
          Object.assign(mergedResult.metadata!, result.metadata);
        }
      }

      // Clean up empty objects
      if (Object.keys(mergedResult.filters!).length === 0) {
        delete mergedResult.filters;
      }
      if (Object.keys(mergedResult.metadata!).length === 0) {
        delete mergedResult.metadata;
      }

      return mergedResult;
    },

    toMiddleware(operation: string) {
      const middlewares = policies.map((p) => p.toMiddleware(operation));

      return async (request: FastifyRequest, reply: FastifyReply) => {
        for (const middleware of middlewares) {
          await middleware(request, reply);

          // Stop if response was sent (denial)
          if (reply.sent) {
            return;
          }
        }
      };
    },
  };
}

/**
 * Combine multiple policies with OR logic
 *
 * At least one policy must allow the operation for it to succeed.
 * If all policies deny, returns the first denial reason.
 *
 * @param policies - Array of policy engines to combine
 * @returns Combined policy engine
 *
 * @example
 * ```typescript
 * const policy = anyPolicy(
 *   ownerPolicy,    // User owns the resource
 *   adminPolicy,    // OR user is admin
 *   publicPolicy,   // OR resource is public
 * );
 *
 * // Any one of these policies passing allows the operation
 * ```
 */
export function anyPolicy(...policies: PolicyEngine[]): PolicyEngine {
  if (policies.length === 0) {
    throw new Error("anyPolicy requires at least one policy");
  }

  if (policies.length === 1) {
    return policies[0]!;
  }

  return {
    async can(user: any, operation: string, context?: any): Promise<PolicyResult> {
      let firstDenial: PolicyResult | null = null;

      for (const policy of policies) {
        const result = await policy.can(user, operation, context);

        if (result.allowed) {
          // First success stops evaluation
          return result;
        }

        if (!firstDenial) {
          firstDenial = result;
        }
      }

      // All policies denied - return first denial
      return firstDenial!;
    },

    toMiddleware(operation: string) {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const results: PolicyResult[] = [];

        for (const policy of policies) {
          const result = await policy.can(request.user, operation, {
            document: request.document,
            body: request.body,
            params: request.params,
            query: request.query,
          });

          if (result.allowed) {
            // First success - attach result and continue
            request.policyResult = result;

            if (result.filters) {
              request._policyFilters = result.filters;
            }

            if (result.fieldMask) {
              request.fieldMask = result.fieldMask;
            }

            if (result.metadata) {
              request.policyMetadata = result.metadata;
            }

            return;
          }

          results.push(result);
        }

        // All policies denied
        return reply.code(403).send({
          success: false,
          error: "Access denied",
          message: results[0]?.reason || "You do not have permission to perform this action",
        });
      };
    },
  };
}

/**
 * Create a pass-through policy that always allows
 *
 * Useful for testing or for routes that don't need authorization.
 *
 * @example
 * ```typescript
 * const policy = allowAll();
 * const result = await policy.can(user, 'any-operation');
 * // result.allowed === true
 * ```
 */
export function allowAll(): PolicyEngine {
  return {
    can() {
      return { allowed: true };
    },

    toMiddleware() {
      return async () => {
        // No-op - always allow
      };
    },
  };
}

/**
 * Create a policy that always denies
 *
 * Useful for explicitly blocking operations or for testing.
 *
 * @param reason - Denial reason
 *
 * @example
 * ```typescript
 * const policy = denyAll('This resource is deprecated');
 * const result = await policy.can(user, 'any-operation');
 * // result.allowed === false
 * // result.reason === 'This resource is deprecated'
 * ```
 */
export function denyAll(reason = "Operation not allowed"): PolicyEngine {
  return {
    can() {
      return { allowed: false, reason };
    },

    toMiddleware() {
      return async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.code(403).send({
          success: false,
          error: "Access denied",
          message: reason,
        });
      };
    },
  };
}
