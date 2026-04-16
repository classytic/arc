/**
 * BodySanitizer - Composable body sanitization logic extracted from BaseController.
 *
 * Strips readonly fields, system-managed fields, and applies field-level
 * write permissions from request bodies before create/update operations.
 *
 * Designed to be used standalone or composed into controllers.
 */

import { SYSTEM_FIELDS } from "../constants.js";
import { applyFieldWritePermissions, resolveEffectiveRoles } from "../permissions/fields.js";
import { getUserRoles } from "../permissions/types.js";
import { isElevated, isMember, PUBLIC_SCOPE } from "../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IRequestContext,
  RouteSchemaOptions,
} from "../types/index.js";
import { ForbiddenError } from "../utils/errors.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Policy for handling fields the caller lacks write permission for.
 *
 * - `'reject'` (default, secure): throw 403 listing the denied fields so
 *   misconfigurations and attacks surface instead of silently disappearing.
 * - `'strip'` (legacy): silently drop the field and continue. Preserved for
 *   apps that relied on the pre-2.9 behaviour — new code should not use it.
 */
export type FieldWriteDenialPolicy = "reject" | "strip";

export const DEFAULT_FIELD_WRITE_DENIAL_POLICY: FieldWriteDenialPolicy = "reject";

export interface BodySanitizerConfig {
  /** Schema options for field sanitization */
  schemaOptions: RouteSchemaOptions;
  /**
   * What to do when a request contains fields the caller can't write.
   * Default: `'reject'` — surface the misconfiguration as a 403.
   */
  onFieldWriteDenied?: FieldWriteDenialPolicy;
}

// ============================================================================
// BodySanitizer Class
// ============================================================================

export class BodySanitizer {
  private schemaOptions: RouteSchemaOptions;
  private onFieldWriteDenied: FieldWriteDenialPolicy;

  constructor(config: BodySanitizerConfig) {
    this.schemaOptions = config.schemaOptions;
    this.onFieldWriteDenied = config.onFieldWriteDenied ?? DEFAULT_FIELD_WRITE_DENIAL_POLICY;
  }

  /**
   * Strip readonly and system-managed fields from request body.
   * Prevents clients from overwriting _id, timestamps, __v, etc.
   *
   * Also applies field-level write permissions when the request has
   * field permission metadata.
   */
  sanitize(
    body: AnyRecord,
    _operation: "create" | "update",
    req?: IRequestContext,
    meta?: ArcInternalMetadata,
  ): AnyRecord {
    let sanitized = { ...body };

    // Strip universal system fields
    for (const field of SYSTEM_FIELDS) {
      delete sanitized[field];
    }

    // Strip fields marked as systemManaged, readonly, or immutable (on updates) in fieldRules
    const fieldRules = this.schemaOptions.fieldRules ?? {};
    for (const [field, rules] of Object.entries(fieldRules)) {
      if (rules.systemManaged || rules.readonly) {
        delete sanitized[field];
      }
      // Immutable fields cannot be changed after creation
      if (_operation === "update" && (rules.immutable || rules.immutableAfterCreate)) {
        delete sanitized[field];
      }
    }

    // Apply field-level write permissions.
    // Merges global user roles with org roles for org-scoped resources.
    // Elevated scope (platform admin) skips field restrictions — consistent
    // with requireOrgRole() which also bypasses for elevated scope.
    if (req) {
      const arcContext = meta ?? (req.metadata as ArcInternalMetadata | undefined);
      const scope = arcContext?._scope ?? PUBLIC_SCOPE;
      if (!isElevated(scope)) {
        const fieldPerms = arcContext?.arc?.fields;
        if (fieldPerms) {
          const globalRoles = getUserRoles(req.user as Record<string, unknown> | undefined);
          const orgRoles = isMember(scope) ? scope.orgRoles : [];
          const effectiveRoles = resolveEffectiveRoles(globalRoles, orgRoles);
          const { body: filtered, deniedFields } = applyFieldWritePermissions(
            sanitized,
            fieldPerms,
            effectiveRoles,
          );
          if (deniedFields.length > 0 && this.onFieldWriteDenied === "reject") {
            throw new ForbiddenError(
              `Not permitted to write field${deniedFields.length === 1 ? "" : "s"}: ${deniedFields.join(", ")}`,
            );
          }
          sanitized = filtered;
        }
      }
    }

    return sanitized;
  }
}
