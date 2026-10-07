/**
 * BulkMixin — `bulkCreate` / `bulkUpdate` / `bulkDelete` endpoints.
 *
 * Security-critical: every bulk operation routes through the same write
 * permissions, tenant scope, and policy filters as the single-doc paths.
 * Cross-tenant writes are blocked at the controller layer regardless of
 * what middleware the host has wired up.
 *
 * Per-doc lifecycle hooks (`before:create` / `after:create` / etc.) do
 * NOT fire for bulk operations — use the single-doc path if you need
 * them, or subscribe to the bulk lifecycle event from the events plugin.
 *
 * @example
 * ```ts
 * class OrderController extends BulkMixin(BaseCrudController<Order>) {}
 * ```
 */

import { conjoinPolicyFilters } from "../../permissions/filter-merge.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IControllerResponse,
  IRequestContext,
  UserLike,
} from "../../types/index.js";
import { createError } from "../../utils/errors.js";
import { withRepoFeatures } from "../../utils/repoFeature.js";
import type { BaseCrudController } from "../BaseCrudController.js";
import type { MixinConstructor } from "../controllerTypes.js";
import { resolveTenancy } from "../tenancy.js";

/** Public surface contributed by BulkMixin. */
export interface BulkExt {
  bulkCreate(req: IRequestContext): Promise<IControllerResponse<object[]>>;
  bulkUpdate(
    req: IRequestContext,
  ): Promise<IControllerResponse<{ matchedCount: number; modifiedCount: number }>>;
  bulkDelete(req: IRequestContext): Promise<IControllerResponse<{ deletedCount: number }>>;
}

export function BulkMixin<TBase extends MixinConstructor<BaseCrudController<object>>>(
  Base: TBase,
): TBase & MixinConstructor<BulkExt> {
  return class BulkController extends Base {
    async bulkCreate(req: IRequestContext): Promise<IControllerResponse<AnyRecord[]>> {
      const repo = withRepoFeatures<{
        createMany?: (items: unknown[], options?: unknown) => Promise<AnyRecord[]>;
      }>(this.repository);
      if (!repo.createMany) {
        throw createError(501, "Repository does not support createMany");
      }

      const rawItems = (req.body as { items?: unknown[] })?.items;
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw createError(400, "Bulk create requires a non-empty items array");
      }
      const items = rawItems;

      // SECURITY: sanitize EACH item the same way single-doc create does —
      // strip system fields, systemManaged/readonly/immutable fields, and
      // apply field-level write permissions. Without this, a tenant-scoped
      // user can overwrite createdBy, organizationId, or any other protected
      // field via the bulk endpoint.
      const arcContext = this.meta(req);
      const user = req.user as UserLike | undefined;
      const sanitizedItems = items.map((item) =>
        this.bodySanitizer.sanitize((item ?? {}) as AnyRecord, "create", req, arcContext),
      );

      // SECURITY: inject the tenant into every item, decided by
      // `resolveTenancy` — the same rule as reads and as single-doc create:
      //   - No scope at all (unit tests) → no injection (controller lenient)
      //   - A caller WITH an org (member, service, or an elevated admin who
      //     selected one) → that org is injected into every item
      //   - Elevated with NO org (platform view) → no injection; the admin
      //     picks per-item orgs
      //   - No org, or anonymous → 403
      //
      // Elevated callers used to skip injection whether or not they had
      // selected an org, so an admin acting as org-9 bulk-created rows under
      // whatever `organizationId` each body carried — while a single create by
      // the same admin was stamped org-9 by the preset.
      let scopedItems: AnyRecord[] = sanitizedItems;
      if (this.tenantField && arcContext?._scope) {
        const tenancy = resolveTenancy(arcContext, this.tenantField);
        if (tenancy.mode === "scoped") {
          scopedItems = sanitizedItems.map((item) => ({
            ...item,
            [tenancy.field]: tenancy.orgId,
          }));
        } else if (tenancy.reason !== "platform" && tenancy.reason !== "untenanted-resource") {
          throw createError(403, "Organization context required to bulk-create resources", {
            code: "ORG_CONTEXT_REQUIRED",
          });
        }
      }

      const created = await repo.createMany(scopedItems, { user, context: arcContext });
      const requested = items.length;
      const inserted = created.length;
      const skipped = requested - inserted;

      return {
        data: created,
        // Partial-success reporting:
        //   all inserted  → 201
        //   some inserted → 207 Multi-Status
        //   none inserted → 422 Unprocessable Entity (caller sent garbage)
        status: skipped === 0 ? 201 : inserted === 0 ? 422 : 207,
        meta: {
          count: inserted,
          requested,
          inserted,
          skipped,
          ...(skipped > 0 && {
            partial: true,
            reason: inserted === 0 ? "all_invalid" : "some_invalid",
          }),
        },
      };
    }

    /**
     * Build a tenant-scoped filter for bulk update/delete.
     *
     * Same tenancy as `AccessControl.buildIdFilter` — both go through
     * `resolveTenancy`:
     *   - Always merge `_policyFilters` (from permission middleware)
     *   - A caller with an org (member, service, or an elevated admin who
     *     selected one) → add org filter
     *   - Elevated with NO org (platform view) → no org filter
     *   - No org, or anonymous, on a tenant resource → deny
     *   - No scope at all (unit tests) → leave filter unchanged
     *
     * Returns the merged filter, or `null` when access must be denied.
     */
    protected buildBulkFilter(
      userFilter: Record<string, unknown>,
      req: IRequestContext,
    ): Record<string, unknown> | null {
      // Caller filter, permission policy, and tenant scope are INDEPENDENT
      // restrictions — conjoin with AND, never overwrite. A bare
      // `Object.assign`/`filter[tenantField] = orgId` let a policy replace a
      // caller constraint (or the tenant assignment clobber a policy's tenant
      // constraint), so a bulk update/delete could hit rows the policy excluded.
      // Conjunction guarantees every layer's restriction is enforced together.
      const arcContext = this.meta(req);
      const filter = conjoinPolicyFilters(userFilter, arcContext?._policyFilters);

      // No scope at all is a direct/unit-test call, not a request.
      if (!this.tenantField || !arcContext?._scope) return filter;

      // Tenancy is `resolveTenancy`'s — the rule every read uses — with the
      // write-side refusals on top. This used to return early for ANY elevated
      // caller, before looking at the org: an admin who had SELECTED org-9 got
      // a bulk update/delete across EVERY tenant, while the same admin deleting
      // one row by id was scoped to org-9. The docblock promised parity with
      // `buildIdFilter`; the code did not have it.
      const tenancy = resolveTenancy(arcContext, this.tenantField);
      switch (tenancy.mode) {
        case "scoped":
          return conjoinPolicyFilters(filter, { [tenancy.field]: tenancy.orgId });
        case "unscoped":
          // Only the platform view (elevated, NO org) may write across tenants.
          // A caller with no org, and a cross-tenant READ flag that somehow
          // reached a write, are both refused: a bulk write is never the place
          // tenancy is allowed to go missing.
          return tenancy.reason === "platform" || tenancy.reason === "untenanted-resource"
            ? filter
            : null;
      }
    }

    /**
     * Sanitize a bulk update data payload through the same write-permission
     * pipeline as single-doc update. Handles both shapes:
     *   - Flat:           `{ name: 'x', status: 'y' }`
     *   - Mongo operator: `{ $set: { name: 'x' }, $inc: { views: 1 } }`
     *
     * Mixed shapes (operator + flat keys) are rejected — mongo silently
     * drops the flat keys in operator mode, which is a footgun.
     */
    protected sanitizeBulkUpdateData(
      data: AnyRecord,
      req: IRequestContext,
      arcContext: ArcInternalMetadata | undefined,
    ): { sanitized: AnyRecord; stripped: string[]; mixedShape: boolean } {
      const stripped = new Set<string>();
      const keys = Object.keys(data);
      const operatorKeys = keys.filter((k) => k.startsWith("$"));
      const flatKeys = keys.filter((k) => !k.startsWith("$"));
      const isOperatorShape = operatorKeys.length > 0;
      if (isOperatorShape && flatKeys.length > 0) {
        return { sanitized: {}, stripped: [], mixedShape: true };
      }

      if (!isOperatorShape) {
        const before = new Set(Object.keys(data));
        const sanitized = this.bodySanitizer.sanitize(data, "update", req, arcContext);
        for (const key of before) {
          if (!(key in sanitized)) stripped.add(key);
        }
        return { sanitized, stripped: [...stripped], mixedShape: false };
      }

      const sanitized: AnyRecord = {};
      for (const [op, operand] of Object.entries(data)) {
        if (!op.startsWith("$") || operand === null || typeof operand !== "object") {
          sanitized[op] = operand;
          continue;
        }
        const operandObj = operand as AnyRecord;
        const before = new Set(Object.keys(operandObj));
        const sanitizedOperand = this.bodySanitizer.sanitize(operandObj, "update", req, arcContext);
        for (const key of before) {
          if (!(key in sanitizedOperand)) stripped.add(key);
        }
        if (Object.keys(sanitizedOperand).length > 0) {
          sanitized[op] = sanitizedOperand;
        }
      }
      return { sanitized, stripped: [...stripped], mixedShape: false };
    }

    async bulkUpdate(
      req: IRequestContext,
    ): Promise<IControllerResponse<{ matchedCount: number; modifiedCount: number }>> {
      const repo = withRepoFeatures<{
        updateMany?: (
          filter: Record<string, unknown>,
          data: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => Promise<{
          matchedCount: number;
          modifiedCount: number;
          acknowledged?: boolean;
          upsertedCount?: number;
        }>;
      }>(this.repository);
      if (!repo.updateMany) {
        throw createError(501, "Repository does not support updateMany");
      }

      const body = req.body as {
        filter?: Record<string, unknown>;
        data?: Record<string, unknown>;
      };
      if (!body.filter || Object.keys(body.filter).length === 0) {
        throw createError(400, "Bulk update requires a non-empty filter");
      }
      if (!body.data || Object.keys(body.data).length === 0) {
        throw createError(400, "Bulk update requires non-empty data");
      }

      // SECURITY: merge tenant scope + policy filters into the user filter.
      const scopedFilter = this.buildBulkFilter(body.filter, req);
      if (scopedFilter === null) {
        throw createError(403, "Organization context required for bulk update", {
          code: "ORG_CONTEXT_REQUIRED",
        });
      }

      // SECURITY: run the data payload through the same write-permission
      // pipeline as single-doc update. Handles both flat and operator shapes.
      const arcContext = this.meta(req);
      const user = req.user as UserLike | undefined;
      const { sanitized, stripped, mixedShape } = this.sanitizeBulkUpdateData(
        body.data,
        req,
        arcContext,
      );

      if (mixedShape) {
        throw createError(
          400,
          "Bulk update payload cannot mix operator keys ($set, $inc, ...) with flat fields. Pick one shape.",
          { code: "MIXED_UPDATE_SHAPE" },
        );
      }

      if (Object.keys(sanitized).length === 0) {
        throw createError(400, "Bulk update payload contained only protected fields", {
          code: "ALL_FIELDS_STRIPPED",
          stripped,
        });
      }

      const result = await repo.updateMany(scopedFilter, sanitized, { user, context: arcContext });
      return {
        data: result,
        status: 200,
        ...(stripped.length > 0 && { meta: { stripped } }),
      };
    }

    /**
     * Bulk delete by `filter` or `ids`.
     *
     * Body shape (one of):
     *   - `{ filter: { status: 'archived' } }` — delete by query filter
     *   - `{ ids: ['id1', 'id2', 'id3'] }`     — delete specific docs by id
     *
     * The `ids` form translates to `{ [idField]: { $in: ids } }` using the
     * resource's `idField` (so it works with custom PKs like `slug`, `jobId`,
     * UUID). Tenant scope and policy filters are merged in either way.
     *
     * Both forms perform a single `repo.deleteMany()` DB call — no per-doc
     * fetch loop. Per-doc lifecycle hooks do NOT fire.
     */
    async bulkDelete(req: IRequestContext): Promise<IControllerResponse<{ deletedCount: number }>> {
      const repo = withRepoFeatures<{
        deleteMany?: (
          filter: Record<string, unknown>,
          options?: { mode?: "hard" | "soft"; [key: string]: unknown },
        ) => Promise<{ deletedCount: number; acknowledged?: boolean; soft?: boolean }>;
      }>(this.repository);
      if (!repo.deleteMany) {
        throw createError(501, "Repository does not support deleteMany");
      }

      const body = req.body as {
        filter?: Record<string, unknown>;
        ids?: ReadonlyArray<string>;
        mode?: "hard" | "soft";
      };

      let userFilter: Record<string, unknown>;
      if (body.ids && body.ids.length > 0) {
        if (body.filter && Object.keys(body.filter).length > 0) {
          throw createError(400, "Bulk delete accepts either `ids` or `filter`, not both");
        }
        userFilter = { [this.idField]: { $in: body.ids } };
      } else if (body.filter && Object.keys(body.filter).length > 0) {
        userFilter = body.filter;
      } else {
        throw createError(400, "Bulk delete requires a non-empty `filter` or `ids` array");
      }

      // SECURITY: merge tenant scope + policy filters into the user filter.
      const scopedFilter = this.buildBulkFilter(userFilter, req);
      if (scopedFilter === null) {
        throw createError(403, "Organization context required for bulk delete", {
          code: "ORG_CONTEXT_REQUIRED",
        });
      }

      // Hard-delete opt-in: `?hard=true` query or `{ mode: 'hard' }` body.
      // SECURITY: delete permission has already run; gate separately in your
      // PermissionCheck if hard-delete needs stricter rules.
      const hardHint =
        req.query?.hard === "true" || req.query?.hard === true || body.mode === "hard";
      const arcContext = this.meta(req);
      const user = req.user as UserLike | undefined;
      const options: { mode?: "hard"; user?: UserLike; context?: ArcInternalMetadata } = {
        user,
        context: arcContext,
      };
      if (hardHint) options.mode = "hard";
      const result = await repo.deleteMany(scopedFilter, options);
      return { data: result, status: 200 };
    }
  };
}
