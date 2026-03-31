/**
 * Adapters Module - Database Abstraction Layer
 *
 * Export all adapter interfaces and implementations.
 */

export type {
  AdapterFactory,
  DataAdapter,
  FieldMetadata,
  RelationMetadata,
  RepositoryLike,
  SchemaMetadata,
  ValidationResult,
} from "./interface.js";
export type { MongooseAdapterOptions } from "./mongoose.js";
export { createMongooseAdapter, MongooseAdapter } from "./mongoose.js";
export type {
  PrismaAdapterOptions,
  PrismaQueryOptions,
  PrismaQueryParserOptions,
} from "./prisma.js";
export { createPrismaAdapter, PrismaAdapter, PrismaQueryParser } from "./prisma.js";
