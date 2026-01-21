/**
 * Adapters Module - Database Abstraction Layer
 *
 * Export all adapter interfaces and implementations.
 */

export type {
  DataAdapter,
  SchemaMetadata,
  FieldMetadata,
  RelationMetadata,
  ValidationResult,
  AdapterFactory,
  RepositoryLike,
} from './interface.js';

export { MongooseAdapter, createMongooseAdapter } from './mongoose.js';
export type { MongooseAdapterOptions } from './mongoose.js';

export { PrismaAdapter, createPrismaAdapter, PrismaQueryParser } from './prisma.js';
export type {
  PrismaAdapterOptions,
  PrismaQueryParserOptions,
  PrismaQueryOptions,
} from './prisma.js';
