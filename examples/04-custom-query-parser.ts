/**
 * Custom Query Parser with OpenAPI Schema Example
 *
 * Demonstrates how to integrate a custom query parser (like MongoKit's QueryParser)
 * with Arc and have the query parameters automatically documented in OpenAPI.
 *
 * Features shown:
 * - Custom queryParser injection
 * - OpenAPI listQuery schema for documentation
 * - Advanced filtering, sorting, and pagination
 * - Full-text search support
 *
 * @example
 * // Supported query parameters (documented in OpenAPI)
 * GET /products?page=1&limit=20
 * GET /products?sort=-price
 * GET /products?search=laptop
 * GET /products?status=active
 * GET /products?price[gte]=100&price[lte]=500
 * GET /products?category[in]=electronics,computers
 * GET /products?populate=category,brand
 * GET /products?select=name,price,category
 */

import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, permissions, allowPublic, requireRoles } from '@classytic/arc';
import type { QueryParserInterface, QueryParserSchema } from '@classytic/arc';
import { Repository, QueryParser } from '@classytic/mongokit';

// ============================================================================
// 1. Define the Mongoose Schema
// ============================================================================

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      text: true, // Enable text search
    },
    slug: {
      type: String,
      unique: true,
    },
    description: {
      type: String,
      text: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    compareAtPrice: Number,
    status: {
      type: String,
      default: 'draft',
      enum: ['draft', 'active', 'archived'],
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
    },
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Brand',
    },
    tags: [String],
    stock: {
      type: Number,
      default: 0,
    },
    deletedAt: Date,
  },
  { timestamps: true }
);

// Create text index for search
productSchema.index({ name: 'text', description: 'text' });

const Product = mongoose.model('Product', productSchema);

// ============================================================================
// 2. Create Repository
// ============================================================================

const productRepository = new Repository(Product);

// ============================================================================
// 3. Create Query Parser with OpenAPI Schema
// ============================================================================

/**
 * Create MongoKit QueryParser instance
 * This parser supports advanced MongoDB query features
 */
const queryParser = new QueryParser({
  maxLimit: 100,
  maxRegexLength: 500,
  maxFilterDepth: 5,
  enableLookups: true,
  // Keep aggregations disabled for security (opt-in only)
  enableAggregations: false,
});

/**
 * OpenAPI schema for query parameters
 *
 * This schema documents all the query parameters your API supports.
 * Arc will use this to generate accurate OpenAPI documentation.
 */
const productQuerySchema: QueryParserSchema = {
  type: 'object',
  properties: {
    // Pagination
    page: {
      type: 'integer',
      description: 'Page number for pagination',
      default: 1,
      minimum: 1,
      example: 1,
    },
    limit: {
      type: 'integer',
      description: 'Number of items per page',
      default: 20,
      minimum: 1,
      maximum: 100,
      example: 20,
    },

    // Sorting
    sort: {
      type: 'string',
      description: 'Sort field (prefix with - for descending). Multiple fields separated by comma.',
      example: '-createdAt',
    },

    // Full-text search
    search: {
      type: 'string',
      description: 'Full-text search query across name and description',
      example: 'laptop gaming',
    },

    // Field selection
    select: {
      type: 'string',
      description: 'Fields to include/exclude (comma-separated, prefix with - to exclude)',
      example: 'name,price,category,-description',
    },

    // Population (joins)
    populate: {
      type: 'string',
      description: 'Related fields to populate (comma-separated)',
      example: 'category,brand',
    },

    // Filters - exact match
    status: {
      type: 'string',
      description: 'Filter by status',
      enum: ['draft', 'active', 'archived'],
    },

    // Filters - numeric range
    'price[gte]': {
      type: 'number',
      description: 'Minimum price (greater than or equal)',
      example: 100,
    },
    'price[lte]': {
      type: 'number',
      description: 'Maximum price (less than or equal)',
      example: 1000,
    },
    'price[gt]': {
      type: 'number',
      description: 'Price greater than',
    },
    'price[lt]': {
      type: 'number',
      description: 'Price less than',
    },

    // Filters - stock
    'stock[gte]': {
      type: 'integer',
      description: 'Minimum stock quantity',
    },
    'stock[lte]': {
      type: 'integer',
      description: 'Maximum stock quantity',
    },

    // Filters - array contains
    'category[in]': {
      type: 'string',
      description: 'Filter by categories (comma-separated IDs)',
      example: '507f1f77bcf86cd799439011,507f1f77bcf86cd799439012',
    },
    'tags[in]': {
      type: 'string',
      description: 'Filter by tags (comma-separated)',
      example: 'featured,sale',
    },

    // Filters - text matching
    'name[contains]': {
      type: 'string',
      description: 'Filter by name containing text (case-insensitive)',
      example: 'phone',
    },
    'name[like]': {
      type: 'string',
      description: 'Filter by name pattern (regex)',
      example: '^iPhone',
    },

    // Filters - existence
    'compareAtPrice[exists]': {
      type: 'boolean',
      description: 'Filter items that have/don\'t have compareAtPrice',
    },

    // Date range filters
    'createdAt[gte]': {
      type: 'string',
      format: 'date-time',
      description: 'Created after date',
      example: '2024-01-01T00:00:00Z',
    },
    'createdAt[lte]': {
      type: 'string',
      format: 'date-time',
      description: 'Created before date',
    },

    // Include deleted items (for soft delete)
    includeDeleted: {
      type: 'boolean',
      description: 'Include soft-deleted items in results',
      default: false,
    },
  },
};

// ============================================================================
// 4. Define Resource with Custom Query Parser
// ============================================================================

export const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  tag: 'Catalog',
  prefix: '/products',

  adapter: createMongooseAdapter(Product, productRepository),

  // Inject custom query parser
  // Arc will use this to parse incoming query parameters
  queryParser: queryParser as unknown as QueryParserInterface,

  // Provide OpenAPI schema for query parameters
  // This ensures accurate API documentation
  openApiSchemas: {
    listQuery: productQuerySchema,
  },

  presets: ['softDelete', 'slugLookup'],

  // Public read, admin write
  permissions: permissions.publicReadAdminWrite(),

  // Schema options for field-level control
  schemaOptions: {
    fieldRules: {
      slug: { systemManaged: true },
    },
    query: {
      // Whitelist allowed populate fields for security
      allowedPopulate: ['category', 'brand'],
    },
  },

  additionalRoutes: [
    {
      method: 'GET',
      path: '/featured',
      handler: 'getFeatured',
      wrapHandler: true,
      permissions: allowPublic(),
      summary: 'Get featured products',
    },
    {
      method: 'GET',
      path: '/low-stock',
      handler: 'getLowStock',
      wrapHandler: true,
      permissions: requireRoles(['admin']),
      summary: 'Get products with low stock',
    },
  ],
});

// ============================================================================
// 5. Alternative: Query Parser with getQuerySchema Method
// ============================================================================

/**
 * You can also create a wrapper that implements getQuerySchema()
 * Arc will auto-detect this and use it for OpenAPI generation
 */
class DocumentedQueryParser implements QueryParserInterface {
  private parser: QueryParser;
  private schema: QueryParserSchema;

  constructor(parser: QueryParser, schema: QueryParserSchema) {
    this.parser = parser;
    this.schema = schema;
  }

  parse(query: Record<string, unknown> | null | undefined) {
    return this.parser.parse(query);
  }

  // Arc will call this method to get the OpenAPI schema
  getQuerySchema(): QueryParserSchema {
    return this.schema;
  }
}

// Usage:
// const documentedParser = new DocumentedQueryParser(queryParser, productQuerySchema);
// Then use documentedParser in defineResource without needing openApiSchemas.listQuery

// ============================================================================
// 6. Usage Examples
// ============================================================================

/*
// All these queries are now documented in OpenAPI:

// Basic pagination
GET /products?page=2&limit=50

// Sorting
GET /products?sort=-price,name
GET /products?sort=createdAt

// Full-text search
GET /products?search=gaming laptop
GET /products?search=wireless headphones

// Field selection
GET /products?select=name,price,stock
GET /products?select=-description,-__v

// Population (joins)
GET /products?populate=category
GET /products?populate=category,brand

// Exact match filtering
GET /products?status=active

// Numeric range filtering
GET /products?price[gte]=100&price[lte]=500
GET /products?stock[gte]=10

// Array contains
GET /products?tags[in]=featured,bestseller
GET /products?category[in]=id1,id2,id3

// Text search (regex)
GET /products?name[contains]=phone
GET /products?name[like]=^iPhone

// Existence checks
GET /products?compareAtPrice[exists]=true

// Date range
GET /products?createdAt[gte]=2024-01-01T00:00:00Z

// Complex combined query
GET /products?status=active&price[gte]=50&price[lte]=200&sort=-createdAt&populate=category&limit=20

// Include deleted (soft delete)
GET /products?includeDeleted=true
*/

export default productResource;
