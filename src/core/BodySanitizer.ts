/**
 * BodySanitizer - Composable body sanitization logic extracted from BaseController.
 *
 * Strips readonly fields, system-managed fields, and applies field-level
 * write permissions from request bodies before create/update operations.
 *
 * Designed to be used standalone or composed into controllers.
 */

import type {
  AnyRecord,
  ArcInternalMetadata,
  IRequestContext,
  RouteSchemaOptions,
} from '../types/index.js';
import { applyFieldWritePermissions, resolveEffectiveRoles } from '../permissions/fields.js';
import { getUserRoles } from '../permissions/types.js';
import { isElevated, isMember, PUBLIC_SCOPE } from '../scope/types.js';
import { SYSTEM_FIELDS } from '../constants.js';

// ============================================================================
// Configuration
// ============================================================================

export interface BodySanitizerConfig {
  /** Schema options for field sanitization */
  schemaOptions: RouteSchemaOptions;
}

// ============================================================================
// BodySanitizer Class
// ============================================================================

export class BodySanitizer {
  private schemaOptions: RouteSchemaOptions;

  constructor(config: BodySanitizerConfig) {
    this.schemaOptions = config.schemaOptions;
  }

  /**
   * Strip readonly and system-managed fields from request body.
   * Prevents clients from overwriting _id, timestamps, __v, etc.
   *
   * Also applies field-level write permissions when the request has
   * field permission metadata.
   */
  sanitize(body: AnyRecord, _operation: 'create' | 'update', req?: IRequestContext, meta?: ArcInternalMetadata): AnyRecord {
    let sanitized = { ...body };

    // Strip universal system fields
    for (const field of SYSTEM_FIELDS) {
      delete sanitized[field];
    }

    // Strip fields marked as systemManaged or readonly in fieldRules
    const fieldRules = this.schemaOptions.fieldRules ?? {};
    for (const [field, rules] of Object.entries(fieldRules)) {
      if (rules.systemManaged || rules.readonly) {
        delete sanitized[field];
      }
    }

    // Apply field-level write permissions (strip fields user can't write)
    // Merges global user roles with org roles for org-scoped resources
    // Elevated scope (platform admin) skips field restrictions --
    // consistent with requireOrgRole() which also bypasses for elevated scope.
    if (req) {
      const arcContext = meta ?? (req.metadata as ArcInternalMetadata | undefined);
      const scope = arcContext?._scope ?? PUBLIC_SCOPE;
      if (!isElevated(scope)) {
        const fieldPerms = arcContext?.arc?.fields;
        if (fieldPerms) {
          const globalRoles = getUserRoles(req.user as Record<string, unknown> | undefined);
          const orgRoles = isMember(scope) ? scope.orgRoles : [];
          const effectiveRoles = resolveEffectiveRoles(globalRoles, orgRoles);
          sanitized = applyFieldWritePermissions(sanitized, fieldPerms, effectiveRoles);
        }
      }
    }

    return sanitized;
  }
}
