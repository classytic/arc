/**
 * Utility Types — type-level inference helpers and aliases. All
 * compile-time-only (zero runtime cost).
 */

import type { StandardRepo } from "@classytic/repo-core/repository";
import type { DataAdapter } from "../adapters/interface.js";
import type { IController } from "./handlers.js";
import type { ResourceConfig } from "./resource.js";

/**
 * Infer document type from a `DataAdapter` or `ResourceConfig`. Smart
 * inference that works with multiple sources.
 *
 * @example
 * ```typescript
 * type Doc1 = InferDocType<typeof adapter>;     // From DataAdapter
 * type Doc2 = InferDocType<typeof resource>;    // From ResourceConfig
 * ```
 */
export type InferDocType<T> =
  T extends DataAdapter<infer D> ? D : T extends ResourceConfig<infer D> ? D : never;

/**
 * Infer document type from a `DataAdapter`. Falls back to `unknown`
 * (not `never`) — safe for generic constraints.
 *
 * @example
 * ```typescript
 * const adapter = createMongooseAdapter({ model: ProductModel, repository: productRepo });
 * type ProductDoc = InferAdapterDoc<typeof adapter>;
 * ```
 */
export type InferAdapterDoc<A> = A extends DataAdapter<infer D> ? D : unknown;

export type InferResourceDoc<T> = T extends ResourceConfig<infer D> ? D : never;

export type TypedResourceConfig<TDoc> = ResourceConfig<TDoc>;
export type TypedController<TDoc> = IController<TDoc>;
export type TypedRepository<TDoc> = StandardRepo<TDoc>;
