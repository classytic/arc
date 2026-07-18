/**
 * Per-record grants — the `requireGrant` combinator + mode lattice.
 *
 * The one ACL idea arc's permission vocabulary lacked (design verdict:
 * `designs/record-sharing.md`): subject × record × mode grants, Puter-style,
 * WITHOUT Puter's mistakes. Arc ships only the GATE — grant storage is a
 * host `defineResource` (tenant-scoped, `audit: true`, any kit via
 * repo-core's `RepositoryLike`), and the `resolve` callback is structural,
 * so core stays DB-agnostic and storage-free by construction.
 *
 * What this design deliberately avoids (verified against Puter's source):
 *   - string-typed permissions (`fs:<uuid>:read` VARCHARs that silently
 *     never match when malformed) → typed {@link GrantMode} union
 *   - per-item ACL checks on list responses (their readdir returns
 *     unfiltered children; the UI stats each item — N+1) → resolutions
 *     return `filters` that compose into THE list query via
 *     `PermissionResult.filters` (one paginated, permission-correct query)
 *   - un-revocable capability tokens → share links should reference a
 *     grant ROW (`subjectType: 'link'`); delete the row, the link dies
 *
 * @example
 * ```ts
 * // Host owns the grants table — it's just a resource:
 * //   { resource, resourceId, subjectType: 'user'|'team'|'link',
 * //     subjectId, mode, grantedBy, expiresAt? }
 * import { anyOf, requireGrant, requireOwnership } from '@classytic/arc/permissions';
 *
 * defineResource({
 *   name: 'document',
 *   permissions: {
 *     get:    anyOf(requireOwnership('ownerId'), requireGrant({ mode: 'read',  resolve })),
 *     update: anyOf(requireOwnership('ownerId'), requireGrant({ mode: 'write', resolve })),
 *     list:   requireGrant({
 *       mode: 'list',
 *       // List-shaped resolution: return filters — owner OR granted ids.
 *       resolve: async (ctx) => ({
 *         filters: {
 *           $or: [
 *             { ownerId: ctx.user?.id },
 *             { _id: { $in: await grants.grantedIds(ctx) } },
 *           ],
 *         },
 *       }),
 *     }),
 *   },
 * });
 * ```
 */

import type { PermissionCheck, PermissionContext, PermissionResult } from "./types.js";
import { getUserRoles } from "./types.js";

/**
 * The grant-mode lattice, weakest → strongest. Holding a mode satisfies
 * every mode at or below it (`write` ⊇ `read` ⊇ `list` ⊇ `see`); `manage`
 * (grant/revoke rights) satisfies everything. Same semantics as Puter's
 * `see < list < read < write` hierarchy with `manage` folded into the
 * lattice top instead of a separate string namespace.
 */
export const GRANT_MODES = ["see", "list", "read", "write", "manage"] as const;

/** One mode from the {@link GRANT_MODES} lattice. */
export type GrantMode = (typeof GRANT_MODES)[number];

/**
 * Does a HELD mode satisfy a REQUIRED mode? Lattice implication —
 * `modeSatisfies('write', 'read') === true`, `modeSatisfies('see', 'read')
 * === false`. Unknown strings (a corrupted grant row) never satisfy
 * anything: fail-closed.
 */
export function modeSatisfies(held: string | undefined, required: GrantMode): boolean {
  if (held === undefined) return false;
  const heldRank = GRANT_MODES.indexOf(held as GrantMode);
  if (heldRank === -1) return false;
  return heldRank >= GRANT_MODES.indexOf(required);
}

/**
 * What a grant `resolve` callback may return:
 *
 * - `boolean` — the host did the whole check itself (already compared modes).
 * - `{ mode }` — the strongest mode the caller holds on `ctx.resourceId`;
 *   the combinator applies the lattice against the required mode.
 * - `{ filters }` — list-shaped resolution: row filters that scope the
 *   query to visible records (flows through `PermissionResult.filters` →
 *   `_policyFilters` → the repository query). Grants access with the
 *   filters attached.
 * - `{ mode, filters }` — mode gates; filters ride along when it passes.
 *
 * An empty object (neither `mode` nor `filters`) and a thrown error both
 * DENY — grant resolution is fail-closed, same stance as `isRevoked`.
 */
export type GrantResolution =
  | boolean
  | {
      mode?: GrantMode | string;
      filters?: Record<string, unknown>;
      /** Optional denial reason surfaced on the 403 (clamped by the framework). */
      reason?: string;
    };

export interface RequireGrantOptions {
  /** The mode this operation needs (lattice-checked against the held mode). */
  mode: GrantMode;
  /**
   * Look up the caller's grant. Receives the full `PermissionContext`
   * (`resourceId` for single-record ops, `request` for headers/scope —
   * e.g. a share-link token). May be sync or async.
   *
   * NOTE: unauthenticated callers are NOT rejected up front — share links
   * grant access to anonymous callers by design. If your grants are
   * session-only, return `false` when `ctx.user` is null (or compose with
   * `requireAuth()` via `allOf`).
   */
  resolve: (ctx: PermissionContext) => GrantResolution | Promise<GrantResolution>;
  /** Roles that skip the grant check entirely (platform admins). */
  bypassRoles?: readonly string[];
}

/**
 * Per-record grant gate. Same combinator tier as `requireOwnership` —
 * compose with `anyOf`/`allOf` like any other `PermissionCheck`.
 *
 * Fail-closed contract: resolver throws → denied (logged via
 * `ctx.request.log`); resolution carries neither `mode` nor `filters` →
 * denied; unknown/corrupted mode strings → denied.
 */
export function requireGrant(options: RequireGrantOptions): PermissionCheck {
  const { mode: required, resolve, bypassRoles } = options;

  return async (ctx: PermissionContext): Promise<boolean | PermissionResult> => {
    if (bypassRoles && ctx.user && getUserRoles(ctx.user).some((r) => bypassRoles.includes(r))) {
      return true;
    }

    let resolution: GrantResolution;
    try {
      resolution = await resolve(ctx);
    } catch (err) {
      // Fail-closed: a broken grant store must read as "no grant", never
      // as open access. The real error is logged for the operator.
      ctx.request.log?.warn?.(
        { err, resource: ctx.resource, action: ctx.action },
        "requireGrant: resolve threw — denying (fail-closed)",
      );
      return { granted: false, reason: "Grant lookup failed" };
    }

    if (typeof resolution === "boolean") {
      return resolution;
    }

    const { mode: held, filters, reason } = resolution;

    // Mode present → lattice check; filters (if any) ride along on grant.
    if (held !== undefined) {
      if (!modeSatisfies(held, required)) {
        return { granted: false, ...(reason ? { reason } : {}) };
      }
      return { granted: true, ...(filters ? { filters } : {}) };
    }

    // List-shaped resolution: filters scope the query — that IS the grant.
    if (filters !== undefined) {
      return { granted: true, filters };
    }

    // Neither mode nor filters — fail closed.
    return { granted: false, ...(reason ? { reason } : {}) };
  };
}
