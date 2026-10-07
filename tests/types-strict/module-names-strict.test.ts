/**
 * Under `strictModuleNames`, module references are `ArcModuleRegistry` keys: a misspelt
 * `dependsOn` / `requires.modules` / closure root is a compile error. Own program
 * (`tsconfig.types-strict.json`), because the augmentation is global to a program.
 */
import { describe, expect, it } from "vitest";
import { defineModule, extendModule, resolveModuleClosure } from "../../src/factory/index.js";

declare module "../../src/factory/index.js" {
  interface ArcModuleRegistry {
    order: { place(): void };
    catalog: { sku(id: string): string };
    // arc's own src is in this program, and outbox-admin's default edge names "outbox".
    outbox: unknown;
  }
  interface ArcCompositionConfig {
    strictModuleNames: true;
  }
}

describe("strictModuleNames", () => {
  it("accepts registered names", () => {
    const order = defineModule({
      name: "order",
      dependsOn: ["catalog"],
      requires: { modules: ["catalog"] },
    });
    resolveModuleClosure([order, defineModule({ name: "catalog" })], ["order"]);
    extendModule(order, { dependsOn: ["catalog"] });
  });

  it("rejects a misspelt dependsOn", () => {
    // @ts-expect-error — "catalgo" is not a key of ArcModuleRegistry
    defineModule({ name: "order", dependsOn: ["catalgo"] });
  });

  it("rejects a misspelt requires.modules", () => {
    // @ts-expect-error — "invoic" is not a key of ArcModuleRegistry
    defineModule({ name: "order", requires: { modules: ["invoic"] } });
  });

  it("rejects a misspelt closure root and extension edge", () => {
    // @ts-expect-error — "ordr" is not registered
    expect(() => resolveModuleClosure([], ["ordr"])).toThrow(/unknown root/);
    // @ts-expect-error — "catalgo" is not registered
    extendModule(defineModule({ name: "order" }), { dependsOn: ["catalgo"] });
  });
});
