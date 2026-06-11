/**
 * configure() partial-rebuild retention — construction-time `defaultSort`
 * and `onFieldWriteDenied` must survive rebuilds triggered by OTHER keys.
 *
 * Regression: `configure({ schemaOptions })` rebuilds QueryResolver and
 * BodySanitizer; before the fix the rebuild passed local-only values
 * (undefined), silently re-enabling the `-createdAt` default sort (breaks
 * SQL kits without a createdAt column) and resetting `strip` write-denial
 * back to `reject` (breaks legacy hosts relying on strip semantics).
 */

import { describe, expect, it } from "vitest";
import { BaseCrudController } from "../../src/core/BaseCrudController.js";
import type { RepositoryLike } from "../../src/types/repository.js";

const stubRepo = {
  getOne: async () => null,
  getAll: async () => [],
  create: async (d: unknown) => d,
  update: async () => null,
  delete: async () => false,
} as unknown as RepositoryLike<Record<string, unknown>>;

function resolverDefaultSort(controller: BaseCrudController): string | undefined {
  return (controller.queryResolver as unknown as { defaultSort?: string }).defaultSort;
}

function sanitizerPolicy(controller: BaseCrudController): string {
  return (controller.bodySanitizer as unknown as { onFieldWriteDenied: string })
    .onFieldWriteDenied;
}

describe("configure() retains construction-time defaultSort / onFieldWriteDenied", () => {
  it("defaultSort: false survives a schemaOptions-only rebuild", () => {
    const controller = new BaseCrudController(stubRepo, { defaultSort: false });
    expect(resolverDefaultSort(controller)).toBeUndefined();

    controller.configure({ schemaOptions: { fieldRules: { name: {} } } });
    expect(resolverDefaultSort(controller)).toBeUndefined();
  });

  it("custom defaultSort survives a maxLimit-only rebuild", () => {
    const controller = new BaseCrudController(stubRepo, { defaultSort: "name" });
    controller.configure({ maxLimit: 50 });
    expect(resolverDefaultSort(controller)).toBe("name");
  });

  it("onFieldWriteDenied: 'strip' survives a schemaOptions-only rebuild", () => {
    const controller = new BaseCrudController(stubRepo, { onFieldWriteDenied: "strip" });
    expect(sanitizerPolicy(controller)).toBe("strip");

    controller.configure({ schemaOptions: { fieldRules: { name: {} } } });
    expect(sanitizerPolicy(controller)).toBe("strip");
  });

  it("configure-supplied values still win and persist across later rebuilds", () => {
    const controller = new BaseCrudController(stubRepo, {});
    controller.configure({ defaultSort: false, onFieldWriteDenied: "strip" });
    expect(resolverDefaultSort(controller)).toBeUndefined();
    expect(sanitizerPolicy(controller)).toBe("strip");

    controller.configure({ schemaOptions: { fieldRules: { title: {} } } });
    expect(resolverDefaultSort(controller)).toBeUndefined();
    expect(sanitizerPolicy(controller)).toBe("strip");
  });

  it("unset options keep their documented defaults after rebuilds", () => {
    const controller = new BaseCrudController(stubRepo, {});
    controller.configure({ schemaOptions: { fieldRules: { name: {} } } });
    expect(resolverDefaultSort(controller)).toBe("-createdAt");
    expect(sanitizerPolicy(controller)).toBe("reject");
  });
});
