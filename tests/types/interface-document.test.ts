/**
 * A document typed as an INTERFACE (no index signature — the shape mongoose and kernels declare)
 * works through BaseController and defineResource with no cast.
 */

import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { requireAuth } from "../../src/permissions/index.js";

interface Matter {
  _id: string;
  matterNumber: string;
  title: string;
}

declare const repository: RepositoryLike<Matter>;
declare const adapter: DataAdapter<Matter>;

class MatterController extends BaseController<Matter> {}

describe("interface-typed documents", () => {
  it("BaseController and defineResource accept them — the compile IS the assertion", () => {
    const build = () =>
      defineResource<Matter>({
        name: "matter",
        adapter,
        controller: new MatterController(repository),
        permissions: {
          list: requireAuth(),
          get: requireAuth(),
          create: requireAuth(),
          update: requireAuth(),
          delete: requireAuth(),
        },
      });
    expect(typeof build).toBe("function");
  });
});
