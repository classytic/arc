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

export { PrismaAdapter, createPrismaAdapter } from './prisma.js';
export type { PrismaAdapterOptions } from './prisma.js';
