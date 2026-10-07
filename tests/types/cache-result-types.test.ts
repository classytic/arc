/**
 * `CacheResult<T>` is a discriminated union — a miss carries no data.
 *
 * It used to declare `data: T` on every status and return `undefined as T`
 * on a miss, so a consumer could read a missing value as present. If this
 * file fails to compile, the union regressed.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { type CacheResult, QueryCache } from "../../src/cache/QueryCache.js";

describe("CacheResult<T>", () => {
  it("narrows data to T only on fresh/stale", async () => {
    const store = new MemoryCacheStore();
    const qc = new QueryCache(store);
    await qc.set("k", { n: 1 }, { staleTime: 60 });

    const result: CacheResult<{ n: number }> = await qc.get<{ n: number }>("k");
    if (result.status === "miss") {
      expectTypeOf(result.data).toEqualTypeOf<undefined>();
    } else {
      expectTypeOf(result.data).toEqualTypeOf<{ n: number }>();
      expect(result.data.n).toBe(1);
    }

    const miss = await qc.get<{ n: number }>("absent");
    expect(miss).toEqual({ status: "miss", data: undefined });
    // Compile-time only — never called.
    const _unnarrowed = (r: CacheResult<{ n: number }>): number =>
      // @ts-expect-error — un-narrowed data may be undefined
      r.data.n;
    void _unnarrowed;
    await store.close();
  });
});
