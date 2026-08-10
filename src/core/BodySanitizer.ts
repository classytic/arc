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
  /**
   * What to do when an update body carries an `immutable` /
   * `immutableAfterCreate` field. Default: `'strip'` — today's behaviour.
   *
   * `'reject'` throws a 403 instead of returning 200 with the field silently
   * unchanged (observed live: `PATCH {"type":"rent"}` → 200, `"type":"purchase"`).
   *
   * NOT folded into {@link onFieldWriteDenied}, which defaults to `'reject'`:
   * a full-object PATCH echoing an immutable field back UNCHANGED is legitimate,
   * and the sanitizer has no stored document to distinguish it from a real
   * change. Sharing that default would break those callers. Opt in per resource,
   * or fleet-wide via `ARC_STRICT_IMMUTABLE_WRITES`.
   */
  onImmutableWrite?: FieldWriteDenialPolicy;
}

// ============================================================================
// BodySanitizer Class
// ============================================================================

export class BodySanitizer {
  private schemaOptions: RouteSchemaOptions;
  private onFieldWriteDenied: FieldWriteDenialPolicy;
  private onImmutableWrite: FieldWriteDenialPolicy;

  constructor(config: BodySanitizerConfig) {
    this.schemaOptions = config.schemaOptions;
    this.onFieldWriteDenied = config.onFieldWriteDenied ?? DEFAULT_FIELD_WRITE_DENIAL_POLICY;
    // `??` not `||`: an explicit 'strip' must beat the env switch, so one
    // resource can opt out of a fleet-wide setting.
    this.onImmutableWrite =
      config.onImmutableWrite ??
      (process.env.ARC_STRICT_IMMUTABLE_WRITES === "true" ? "reject" : "strip");
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

    // Resolve the caller's scope once — used below to honor the
    // `preserveForElevated` opt-in on individual field rules.
    const scopeForRules = req
      ? ((meta ?? (req.metadata as ArcInternalMetadata | undefined))?._scope ?? PUBLIC_SCOPE)
      : undefined;
    const scopeIsElevated = scopeForRules ? isElevated(scopeForRules) : false;

    // Strip fields marked as systemManaged, readonly, or immutable (on updates) in fieldRules.
    // `preserveForElevated: true` short-circuits the strip for elevated
    // scopes — needed for cross-tenant admin writes where the tenant
    // field is the only way to pick a target org (defineResource auto-sets
    // this flag on `tenantField`; see src/core/defineResource.ts).
    const fieldRules = this.schemaOptions.fieldRules ?? {};
    const immutableAttempts: string[] = [];
    for (const [field, rules] of Object.entries(fieldRules)) {
      const bypass = Boolean(rules.preserveForElevated) && scopeIsElevated;
      if ((rules.systemManaged || rules.readonly) && !bypass) {
        delete sanitized[field];
      }
      // Immutable fields cannot be changed after creation
      if (_operation === "update" && (rules.immutable || rules.immutableAfterCreate) && !bypass) {
        // Only an ATTEMPT when the caller actually sent the field. This loop
        // walks the RULES, not the body, so recording unconditionally would
        // reject every update on any resource that merely DECLARES an immutable
        // field — including bodies that never mention it.
        if (Object.hasOwn(sanitized, field)) immutableAttempts.push(field);
        delete sanitized[field];
      }
    }

    // An immutable write was silently dropped and the caller told 200 — the
    // field came back unchanged and nothing said why. arc ALREADY decided this
    // class of write should surface rather than no-op (`onFieldWriteDenied`
    // defaults to 'reject': "surface the misconfiguration as a 403"); immutable
    // simply never routed through it.
    //
    // Opt-in and separate from `onFieldWriteDenied`, deliberately: a full-object
    // PATCH that echoes an immutable field back UNCHANGED is legitimate and
    // common, and the sanitizer cannot tell it from a real change because it
    // has no stored document to compare against. Rejecting by default would
    // break those callers. Hosts that send partial patches should turn it on.
    if (immutableAttempts.length > 0 && this.onImmutableWrite === "reject") {
      throw new ForbiddenError(
        `Cannot modify immutable field${immutableAttempts.length === 1 ? "" : "s"}: ${immutableAttempts.join(", ")}`,
      );
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
