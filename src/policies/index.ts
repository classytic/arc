/**
 * Policy System
 *
 * Pluggable authorization interface for Arc.
 *
 * Arc provides the **interface** (contract), apps provide the **implementation** (strategy).
 *
 * ## Quick Start
 *
 * ```typescript
 * import { PolicyEngine, PolicyResult, createPolicyMiddleware } from '@classytic/arc/policies';
 *
 * class MyPolicy implements PolicyEngine {
 *   can(user, operation, context) {
 *     return {
 *       allowed: getUserRoles(user).includes('admin'),
 *       reason: 'Admin role required',
 *     };
 *   }
 *
 *   toMiddleware(operation) {
 *     return createPolicyMiddleware(this, operation);
 *   }
 * }
 *
 * const policy = new MyPolicy();
 * ```
 *
 * ## Examples
 *
 * ### RBAC (Role-Based Access Control)
 * ```typescript
 * class RBACPolicy implements PolicyEngine {
 *   constructor(private roles: Record<string, string[]>) {}
 *
 *   can(user, operation) {
 *     const allowedRoles = this.roles[operation] || [];
 *     const hasRole = getUserRoles(user).some(r => allowedRoles.includes(r));
 *     return {
 *       allowed: hasRole,
 *       reason: hasRole ? undefined : `Requires one of: ${allowedRoles.join(', ')}`,
 *     };
 *   }
 *
 *   toMiddleware(operation) {
 *     return createPolicyMiddleware(this, operation);
 *   }
 * }
 * ```
 *
 * ### Ownership Check
 * ```typescript
 * class OwnershipPolicy implements PolicyEngine {
 *   can(user, operation, context) {
 *     if (!['update', 'delete'].includes(operation)) {
 *       return { allowed: true };
 *     }
 *
 *     const isOwner = context?.document?.userId === user.id;
 *     return {
 *       allowed: isOwner,
 *       reason: isOwner ? undefined : 'Only the owner can perform this action',
 *     };
 *   }
 *
 *   toMiddleware(operation) {
 *     return createPolicyMiddleware(this, operation);
 *   }
 * }
 * ```
 *
 * ### Multi-Tenant Isolation
 * ```typescript
 * class TenantPolicy implements PolicyEngine {
 *   can(user, operation, context) {
 *     if (operation === 'list') {
 *       return {
 *         allowed: true,
 *         filters: { organizationId: user.organizationId },
 *       };
 *     }
 *
 *     if (context?.document) {
 *       const isSameTenant = context.document.organizationId === user.organizationId;
 *       return {
 *         allowed: isSameTenant,
 *         reason: isSameTenant ? undefined : 'Resource belongs to another organization',
 *       };
 *     }
 *
 *     return { allowed: true };
 *   }
 *
 *   toMiddleware(operation) {
 *     return createPolicyMiddleware(this, operation);
 *   }
 * }
 * ```
 *
 * ### Combining Policies
 * ```typescript
 * const policy = combinePolicies(
 *   new RBACPolicy({ update: ['admin', 'editor'] }),
 *   new TenantPolicy(),
 *   new OwnershipPolicy(),
 * );
 *
 * // All three policies must pass for the operation to succeed
 * ```
 *
 * @module policies
 */

export {
  allowAll,
  anyPolicy,
  combinePolicies,
  createPolicyMiddleware,
  denyAll,
} from "./helpers.js";
export type {
  AccessControlPolicyOptions,
  AccessControlStatement,
  PolicyContext,
  PolicyEngine,
  PolicyFactory,
  PolicyResult,
} from "./PolicyInterface.js";
export { createAccessControlPolicy } from "./PolicyInterface.js";
