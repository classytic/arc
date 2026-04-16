/**
 * Field-Level Permissions
 *
 * Control field visibility and writability per role.
 * Integrated into the response path (read) and sanitization path (write).
 *
 * @example
 * ```typescript
 * import { fields, defineResource } from '@classytic/arc';
 *
 * const userResource = defineResource({
 *   name: 'user',
 *   adapter: userAdapter,
 *   fields: {
 *     salary: fields.visibleTo(['admin', 'hr']),
 *     internalNotes: fields.writableBy(['admin']),
 *     email: fields.redactFor(['viewer']),
 *     password: fields.hidden(),
 *   },
 * });
 * ```
 */

/** Type guard for Mongoose-like documents with toObject() */
function isMongooseDoc(obj: unknown): obj is { toObject(): Record<string, unknown> } {
  return (
    !!obj &&
    typeof obj === "object" &&
    "toObject" in obj &&
    typeof (obj as Record<string, unknown>).toObject === "function"
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldPermissionType = "hidden" | "visibleTo" | "writableBy" | "redactFor";

export interface FieldPermission {
  readonly _type: FieldPermissionType;
  readonly roles?: readonly string[];
  readonly redactValue?: unknown;
}

export type FieldPermissionMap = Record<string, FieldPermission>;

// ---------------------------------------------------------------------------
// Field Permission Helpers
// ---------------------------------------------------------------------------

export const fields = {
  /**
   * Field is never included in responses. Not writable via API.
   *
   * @example
   * ```typescript
   * fields: { password: fields.hidden() }
   * ```
   */
  hidden(): FieldPermission {
    return { _type: "hidden" };
  },

  /**
   * Field is only visible to users with specified roles.
   * Other users don't see the field at all.
   *
   * @example
   * ```typescript
   * fields: { salary: fields.visibleTo(['admin', 'hr']) }
   * ```
   */
  visibleTo(roles: readonly string[]): FieldPermission {
    return { _type: "visibleTo", roles };
  },

  /**
   * Field is only writable by users with specified roles.
   * All users can still read the field. Users without the role
   * have the field silently stripped from write operations.
   *
   * @example
   * ```typescript
   * fields: { role: fields.writableBy(['admin']) }
   * ```
   */
  writableBy(roles: readonly string[]): FieldPermission {
    return { _type: "writableBy", roles };
  },

  /**
   * Field is redacted (replaced with a placeholder) for specified roles.
   * Other users see the real value.
   *
   * @param roles - Roles that see the redacted value
   * @param redactValue - Replacement value (default: '***')
   *
   * @example
   * ```typescript
   * fields: {
   *   email: fields.redactFor(['viewer']),
   *   ssn: fields.redactFor(['basic'], '***-**-****'),
   * }
   * ```
   */
  redactFor(roles: readonly string[], redactValue: unknown = "***"): FieldPermission {
    return { _type: "redactFor", roles, redactValue };
  },
};

// ---------------------------------------------------------------------------
// Application Functions
// ---------------------------------------------------------------------------

/**
 * Apply field-level READ permissions to a response object.
 * Strips hidden fields, enforces visibility, and applies redaction.
 *
 * @param data - The response object (mutated in place for performance)
 * @param fieldPermissions - Field permission map from resource config
 * @param userRoles - Current user's roles (empty array for unauthenticated)
 * @returns The filtered object
 */
export function applyFieldReadPermissions<T extends Record<string, unknown>>(
  data: T,
  fieldPermissions: FieldPermissionMap,
  userRoles: readonly string[],
): T {
  if (!data || typeof data !== "object") return data;

  // Normalize Mongoose documents to plain objects before spreading.
  // HydratedDocument's spread gives internal properties ($__, $isNew, etc.),
  // not the actual document fields — toObject() returns a proper plain object.
  const plain = isMongooseDoc(data) ? (data.toObject() as T) : data;
  const result = { ...plain };

  for (const [field, perm] of Object.entries(fieldPermissions)) {
    switch (perm._type) {
      case "hidden":
        // Always strip
        delete result[field];
        break;

      case "visibleTo":
        // Strip if user doesn't have any of the required roles
        if (!perm.roles?.some((r) => userRoles.includes(r))) {
          delete result[field];
        }
        break;

      case "redactFor":
        // Redact if user HAS any of the specified roles
        if (perm.roles?.some((r) => userRoles.includes(r))) {
          (result as Record<string, unknown>)[field] = perm.redactValue ?? "***";
        }
        break;

      case "writableBy":
        // Write-only permission — no effect on reads
        break;
    }
  }

  return result;
}

/**
 * Result of applying write permissions — includes both the filtered body
 * and the list of fields that were stripped so callers can decide whether
 * to reject the request (secure default) or silently strip (legacy).
 */
export interface FieldWritePermissionResult<T extends Record<string, unknown>> {
  readonly body: T;
  readonly deniedFields: readonly string[];
}

/**
 * Apply field-level WRITE permissions to request body.
 *
 * Returns both the filtered body and the list of denied fields. Callers are
 * expected to reject the request when `deniedFields.length > 0` — silently
 * stripping fields hides misconfigurations and real attacks. See
 * `BodySanitizer` for the default policy.
 *
 * @param body - The request body (returns a new filtered copy)
 * @param fieldPermissions - Field permission map from resource config
 * @param userRoles - Current user's roles
 */
export function applyFieldWritePermissions<T extends Record<string, unknown>>(
  body: T,
  fieldPermissions: FieldPermissionMap,
  userRoles: readonly string[],
): FieldWritePermissionResult<T> {
  const result = { ...body };
  const deniedFields: string[] = [];

  for (const [field, perm] of Object.entries(fieldPermissions)) {
    switch (perm._type) {
      case "hidden":
        // Hidden fields can never be written
        if (field in result) {
          deniedFields.push(field);
          delete result[field];
        }
        break;

      case "writableBy":
        // Only writable by specific roles
        if (field in result && !perm.roles?.some((r) => userRoles.includes(r))) {
          deniedFields.push(field);
          delete result[field];
        }
        break;

      // visibleTo and redactFor don't affect writes
    }
  }

  return { body: result, deniedFields };
}

// ---------------------------------------------------------------------------
// Role Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve effective roles by merging global user roles with org-level roles.
 *
 * Global roles come from `req.user.role` (normalized via getUserRoles()).
 * Org roles come from `req.context.orgRoles` (set by BA adapter's org bridge).
 *
 * When no org context exists, returns global roles only — backward compatible.
 */
export function resolveEffectiveRoles(
  userRoles: readonly string[],
  orgRoles: readonly string[],
): string[] {
  if (orgRoles.length === 0) return [...userRoles];
  if (userRoles.length === 0) return [...orgRoles];
  return [...new Set([...userRoles, ...orgRoles])];
}
