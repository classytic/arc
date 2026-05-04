/**
 * SlugMixin — `getBySlug` endpoint for resources with a slug primary key.
 *
 * Prefers the repo's own `getBySlug(slug, options)` when available, falls
 * back to `getOne({ [slugField]: slug, ...filter })`. Full access-control:
 * org scope + policy filters run after the lookup, matching `GET /:id`.
 *
 * @example
 * ```ts
 * class ArticleController extends SlugMixin(BaseCrudController<Article>) {}
 * ```
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { AnyRecord, IControllerResponse, IRequestContext } from "../../types/index.js";
import { createError, NotFoundError } from "../../utils/errors.js";
import type { BaseCrudController } from "../BaseCrudController.js";

// biome-ignore lint/suspicious/noExplicitAny: standard TS mixin Constructor pattern
type Constructor<T> = new (...args: any[]) => T;

/** Public surface contributed by SlugMixin. */
export interface SlugExt {
  getBySlug(req: IRequestContext): Promise<IControllerResponse<AnyRecord>>;
}

export function SlugMixin<TBase extends Constructor<BaseCrudController>>(
  Base: TBase,
): TBase & Constructor<SlugExt> {
  return class SlugController extends Base {
    async getBySlug(req: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
      // `_presetFields` is populated by the slugLookup preset.
      const self = this as unknown as { _presetFields: { slugField?: string } };
      const slugField = self._presetFields.slugField ?? "slug";
      const slug = (req.params[slugField] ?? req.params.slug) as string;

      const baseOptions = this.queryResolver.resolve(req, this.meta(req));
      const options = {
        ...(baseOptions as Record<string, unknown>),
        ...this.tenantRepoOptions(req),
      } as typeof baseOptions;

      const repo = this.repository as RepositoryLike & {
        getBySlug?: (slug: string, options?: unknown) => Promise<AnyRecord | null>;
        getOne?: (filter: Record<string, unknown>, options?: unknown) => Promise<AnyRecord | null>;
      };

      let item: AnyRecord | null = null;
      if (repo.getBySlug) {
        item = (await repo.getBySlug(slug, options)) as AnyRecord | null;
      } else if (repo.getOne) {
        const filter = {
          [slugField]: slug,
          ...((options as Record<string, unknown>)?.filter ?? {}),
        } as Record<string, unknown>;
        item = (await repo.getOne(filter, options)) as AnyRecord | null;
      } else {
        throw createError(
          501,
          "Slug lookup not implemented — repository needs getBySlug() or getOne()",
        );
      }

      // Full access control: org scope + policy filters (same as GET /:id).
      if (!this.accessControl.validateItemAccess(item as AnyRecord, req)) {
        // POLICY_FILTERED when the item exists but was filtered out — keeps
        // the details.code signal consistent with the GET /:id path.
        const code = item ? "POLICY_FILTERED" : "NOT_FOUND";
        const resource = (this as unknown as { resourceName?: string }).resourceName ?? "Resource";
        const err = new NotFoundError(resource);
        (err as unknown as { details: Record<string, unknown> }).details = {
          ...(err.details ?? {}),
          code,
        };
        throw err;
      }

      return { data: item as AnyRecord, status: 200 };
    }
  };
}
