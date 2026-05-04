/**
 * TreeMixin — `getTree` + `getChildren` endpoints for hierarchical resources.
 *
 * Thin delegation over `repository.getTree()` / `repository.getChildren()`.
 * Repos that don't implement these return 501. `parentField` is resolved
 * from `presetFields.parentField` (configured by the tree preset) with
 * `'parent'` as the fallback.
 *
 * @example
 * ```ts
 * class CategoryController extends TreeMixin(BaseCrudController<Category>) {}
 * ```
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { AnyRecord, IControllerResponse, IRequestContext } from "../../types/index.js";
import { createError } from "../../utils/errors.js";
import type { BaseCrudController } from "../BaseCrudController.js";

// biome-ignore lint/suspicious/noExplicitAny: standard TS mixin Constructor pattern
type Constructor<T> = new (...args: any[]) => T;

/** Public surface contributed by TreeMixin. */
export interface TreeExt {
  getTree(req: IRequestContext): Promise<IControllerResponse<AnyRecord[]>>;
  getChildren(req: IRequestContext): Promise<IControllerResponse<AnyRecord[]>>;
}

export function TreeMixin<TBase extends Constructor<BaseCrudController>>(
  Base: TBase,
): TBase & Constructor<TreeExt> {
  return class TreeController extends Base {
    async getTree(req: IRequestContext): Promise<IControllerResponse<AnyRecord[]>> {
      const repo = this.repository as RepositoryLike & {
        getTree?: (options?: unknown) => Promise<AnyRecord[]>;
      };
      if (!repo.getTree) {
        throw createError(501, "Tree structure not implemented");
      }

      const options = this.queryResolver.resolve(req, this.meta(req));
      const tree = await repo.getTree(options);

      return { data: tree, status: 200 };
    }

    async getChildren(req: IRequestContext): Promise<IControllerResponse<AnyRecord[]>> {
      const repo = this.repository as RepositoryLike & {
        getChildren?: (parentId: string, options?: unknown) => Promise<AnyRecord[]>;
      };
      if (!repo.getChildren) {
        throw createError(501, "Tree structure not implemented");
      }

      // `_presetFields` is protected state populated by the tree preset. Fall
      // back to `'parent'` so direct BaseController usage works without a preset.
      const self = this as unknown as { _presetFields: { parentField?: string } };
      const parentField = self._presetFields.parentField ?? "parent";
      const parentId = (req.params[parentField] ?? req.params.parent ?? req.params.id) as string;
      const options = this.queryResolver.resolve(req, this.meta(req));
      const children = await repo.getChildren(parentId, options);

      return { data: children, status: 200 };
    }
  };
}
