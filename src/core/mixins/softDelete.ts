/**
 * SoftDeleteMixin — `getDeleted` + `restore` support for BaseCrudController.
 *
 * Mixin factory: wraps any `BaseCrudController` subclass with soft-delete
 * endpoints. The host repository must implement `getDeleted(params, options)`
 * and `restore(id)` for these methods to succeed — otherwise they return
 * a 501 per the documented contract.
 *
 * @example
 * ```ts
 * class MyController extends SoftDeleteMixin(BaseCrudController<Product>) {}
 * ```
 */

import type { RepositoryLike } from "../../adapters/interface.js";
import type {
  AnyRecord,
  IControllerResponse,
  IRequestContext,
  PaginationResult,
  UserLike,
} from "../../types/index.js";
import type { BaseCrudController } from "../BaseCrudController.js";

// biome-ignore lint/suspicious/noExplicitAny: standard TS mixin Constructor pattern
type Constructor<T> = new (...args: any[]) => T;

/** Public surface contributed by SoftDeleteMixin. */
export interface SoftDeleteExt {
  getDeleted(req: IRequestContext): Promise<IControllerResponse<PaginationResult<AnyRecord>>>;
  restore(req: IRequestContext): Promise<IControllerResponse<AnyRecord>>;
}

export function SoftDeleteMixin<TBase extends Constructor<BaseCrudController>>(
  Base: TBase,
): TBase & Constructor<SoftDeleteExt> {
  return class SoftDeleteController extends Base {
    async getDeleted(
      req: IRequestContext,
    ): Promise<IControllerResponse<PaginationResult<AnyRecord>>> {
      const repo = this.repository as RepositoryLike & {
        getDeleted?: (
          params?: unknown,
          options?: unknown,
        ) => Promise<AnyRecord[] | PaginationResult<AnyRecord>>;
      };
      if (!repo.getDeleted) {
        return {
          success: false,
          error: "Soft delete not implemented",
          status: 501,
        };
      }

      // Pass parsed query as the first arg (params) and scope meta as the
      // second (options), matching the canonical `getDeleted(params, options)`
      // signature. mongokit's softDeletePlugin honors both shapes.
      const parsed = this.queryResolver.resolve(req, this.meta(req));
      const result = await repo.getDeleted(parsed, parsed);

      return {
        success: true,
        data: result as PaginationResult<AnyRecord>,
        status: 200,
      };
    }

    async restore(req: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
      const repo = this.repository as RepositoryLike & {
        restore?: (id: string) => Promise<AnyRecord | null>;
        getById: (id: string, options?: unknown) => Promise<AnyRecord | null>;
      };
      if (!repo.restore) {
        return { success: false, error: "Restore not implemented", status: 501 };
      }

      const id = req.params.id;
      if (!id) {
        return { success: false, error: "ID parameter is required", status: 400 };
      }

      // Pre-restore access control: fetch the (soft-deleted) item and validate
      // org scope, policy filters, and ownership — same as DELETE /:id.
      //
      // `includeDeleted: true` tells the soft-delete plugin to bypass its
      // default `deletedAt: null` filter.
      const existing = await this.accessControl.fetchWithAccessControl<AnyRecord>(id, req, repo, {
        includeDeleted: true,
      });

      if (!existing) {
        return this.notFoundResponse("NOT_FOUND");
      }

      if (!this.accessControl.checkOwnership(existing as AnyRecord, req)) {
        return {
          success: false,
          error: "You do not have permission to restore this resource",
          details: { code: "OWNERSHIP_DENIED" },
          status: 403,
        };
      }

      const arcContext = this.meta(req);
      const user = req.user as UserLike | undefined;

      const repoId = this.resolveRepoId(id, existing as AnyRecord | null);

      const hooks = this.getHooks(req);
      if (hooks && this.resourceName) {
        try {
          await hooks.executeBefore(this.resourceName, "restore", existing as AnyRecord, {
            user,
            context: arcContext,
            meta: { id },
          });
        } catch (err) {
          return {
            success: false,
            error: "Hook execution failed",
            details: {
              code: "BEFORE_RESTORE_HOOK_ERROR",
              message: (err as Error).message,
            },
            status: 400,
          };
        }
      }

      const repoRestore = (): Promise<AnyRecord | null> =>
        // biome-ignore lint/style/noNonNullAssertion: checked above
        repo.restore!(repoId) as Promise<AnyRecord | null>;

      let item: AnyRecord | null;
      if (hooks && this.resourceName) {
        item = (await hooks.executeAround(this.resourceName, "restore", existing, repoRestore, {
          user,
          context: arcContext,
          meta: { id },
        })) as AnyRecord | null;
      } else {
        item = await repoRestore();
      }

      if (!item) {
        return this.notFoundResponse("NOT_FOUND");
      }

      if (hooks && this.resourceName) {
        await hooks.executeAfter(this.resourceName, "restore", item as AnyRecord, {
          user,
          context: arcContext,
          meta: { id },
        });
      }

      return {
        success: true,
        data: item as AnyRecord,
        status: 200,
        meta: { message: "Restored successfully" },
      };
    }
  };
}
