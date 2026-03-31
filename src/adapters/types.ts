/**
 * Type Utilities for Adapters
 *
 * Type-safe helpers for working with database adapters.
 * Eliminates the need for 'as any' casts in application code.
 */

import type { Document, Model } from "mongoose";
import type { CrudRepository } from "../types/index.js";

// ============================================================================
// Type Inference Helpers
// ============================================================================

/**
 * Infer document type from Mongoose model
 *
 * @example
 * const ProductModel = mongoose.model('Product', productSchema);
 * type ProductDoc = InferMongooseDoc<typeof ProductModel>;
 * // Result: ProductDocument with all fields typed
 */
export type InferMongooseDoc<M> = M extends Model<infer D> ? D : never;

/**
 * Infer document type from repository
 *
 * @example
 * const productRepo = new ProductRepository();
 * type ProductDoc = InferRepoDoc<typeof productRepo>;
 */
export type InferRepoDoc<R> = R extends CrudRepository<infer D> ? D : never;

/**
 * Infer document type from data adapter
 *
 * @example
 * const adapter = createMongooseAdapter({ model, repository });
 * type Doc = InferAdapterDoc<typeof adapter>;
 */
export type InferAdapterDoc<A> = A extends { repository: CrudRepository<infer D> } ? D : never;

/**
 * Extract clean document type (removes Mongoose-specific fields)
 *
 * @example
 * type CleanProduct = CleanDoc<ProductDocument>;
 * // Result: Product without _id, __v, save(), etc.
 */
export type CleanDoc<T> = T extends Document
  ? Omit<T, keyof Document | "_id" | "__v" | "$__" | "$isNew" | "save" | "remove">
  : T;

// ============================================================================
// Adapter Constraint Types
// ============================================================================

/**
 * Ensures type is a valid Mongoose document
 */
export type MongooseDocument = Document & Record<string, unknown>;

/**
 * Ensures type is a valid repository
 */
export type ValidRepository<TDoc> = CrudRepository<TDoc> & {
  getAll: CrudRepository<TDoc>["getAll"];
  getById: CrudRepository<TDoc>["getById"];
  create: CrudRepository<TDoc>["create"];
  update: CrudRepository<TDoc>["update"];
  delete: CrudRepository<TDoc>["delete"];
};

/**
 * Ensures model matches repository document type
 */
export type MatchingModel<TDoc> = Model<TDoc & Document>;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if value is a Mongoose model
 */
export function isMongooseModel(value: unknown): value is Model<Document> {
  return (
    typeof value === "function" && value.prototype && "modelName" in value && "schema" in value
  );
}

/**
 * Check if value is a repository
 */
export function isRepository(value: unknown): value is CrudRepository<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getAll" in value &&
    "getById" in value &&
    "create" in value &&
    "update" in value &&
    "delete" in value
  );
}

// Types are already exported at declaration
// Functions (isMongooseModel, isRepository) are already exported at declaration
