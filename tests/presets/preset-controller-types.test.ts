/**
 * `IPresetController` — type-level contract.
 *
 * Pre-2.20 the type used a distributive conditional, so a UNION of preset
 * names produced a UNION of controller contracts — which a class cannot
 * `implements`; the documented multi-preset example
 * (`implements IPresetController<Product, 'softDelete' | 'slugLookup'>`)
 * didn't compile. Now an indexed lookup + union-to-intersection fold yields
 * the intersection the docs promise. These assertions run at `tsc --noEmit`
 * time; the single runtime `it` keeps vitest from reporting an empty file.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  IPresetController,
  ISlugLookupController,
  ISoftDeleteController,
  ITreeController,
} from "../../src/presets/types.js";
import type { AnyRecord } from "../../src/types/index.js";

type Doc = AnyRecord;

describe("IPresetController (type-level)", () => {
  it("a union of preset names yields the INTERSECTION of contracts", () => {
    type Combined = IPresetController<Doc, "softDelete" | "slugLookup" | "tree">;

    // The combined type must satisfy every individual contract — that is
    // what makes it usable in an `implements` clause.
    expectTypeOf<Combined>().toExtend<ISoftDeleteController<Doc>>();
    expectTypeOf<Combined>().toExtend<ISlugLookupController<Doc>>();
    expectTypeOf<Combined>().toExtend<ITreeController<Doc>>();

    // And a value implementing all three satisfies Combined (the reverse
    // direction — intersection, not union).
    type AllThree = ISoftDeleteController<Doc> & ISlugLookupController<Doc> & ITreeController<Doc>;
    expectTypeOf<AllThree>().toExtend<Combined>();

    expect(true).toBe(true);
  });

  it("a single preset name yields exactly that contract", () => {
    expectTypeOf<IPresetController<Doc, "slugLookup">>().toEqualTypeOf<
      ISlugLookupController<Doc>
    >();
    expect(true).toBe(true);
  });
});
