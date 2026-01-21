/**
 * Prisma + PostgreSQL Resource Example
 *
 * Demonstrates using Arc with Prisma ORM for PostgreSQL/MySQL/SQLite.
 * This example shows a complete product catalog with:
 * - Full CRUD operations
 * - Soft delete
 * - Multi-tenant organization scoping
 * - Custom query parsing
 * - Permission-based access control
 *
 * Prerequisites:
 * 1. Install Prisma: npm install @prisma/client
 * 2. Initialize Prisma: npx prisma init
 * 3. Define your schema in prisma/schema.prisma
 * 4. Run migrations: npx prisma migrate dev
 *
 * @example prisma/schema.prisma
 * ```prisma
 * model Product {
 *   id             String    @id @default(cuid())
 *   name           String
 *   slug           String    @unique
 *   description    String?
 *   price          Decimal   @db.Decimal(10, 2)
 *   sku            String    @unique
 *   stock          Int       @default(0)
 *   isActive       Boolean   @default(true)
 *   organizationId String
 *   createdBy      String?
 *   createdAt      DateTime  @default(now())
 *   updatedAt      DateTime  @updatedAt
 *   deletedAt      DateTime?
 *
 *   @@index([organizationId])
 *   @@index([slug])
 *   @@index([deletedAt])
 * }
 * ```
 */

import { PrismaClient, Prisma } from '@prisma/client';
import {
  defineResource,
  createPrismaAdapter,
  PrismaQueryParser,
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
} from '@classytic/arc';
import type { CrudRepository, ServiceContext, QueryOptions } from '@classytic/arc';

// ============================================================================
// 1. Initialize Prisma Client
// ============================================================================

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// ============================================================================
// 2. Define TypeScript Types
// ============================================================================

type Product = Prisma.ProductGetPayload<{}>;
type ProductCreateInput = Prisma.ProductCreateInput;
type ProductUpdateInput = Prisma.ProductUpdateInput;

// ============================================================================
// 3. Create Prisma Repository
// ============================================================================

/**
 * Product Repository - Implements CrudRepository interface for Prisma
 *
 * Arc's Prisma adapter delegates CRUD operations to your repository,
 * giving you full control over query logic while maintaining the Arc interface.
 */
class ProductRepository implements CrudRepository<Product> {
  private queryParser = new PrismaQueryParser();

  /**
   * Get all products with filtering, pagination, and sorting
   */
  async getAll(options?: QueryOptions): Promise<Product[]> {
    const prismaQuery = this.queryParser.toPrismaQuery(
      {
        filters: options?.filter,
        limit: options?.limit ?? 20,
        page: options?.page ?? 1,
        sort: options?.sort,
      },
      options?.filters // Policy filters (org scope, ownership)
    );

    return prisma.product.findMany({
      where: prismaQuery.where,
      orderBy: prismaQuery.orderBy,
      take: prismaQuery.take,
      skip: prismaQuery.skip,
    });
  }

  /**
   * Get product by ID
   */
  async getById(id: string, options?: QueryOptions): Promise<Product | null> {
    const policyFilters = options?.filters ?? {};

    return prisma.product.findFirst({
      where: {
        id,
        deletedAt: null,
        ...policyFilters,
      },
    });
  }

  /**
   * Create new product
   */
  async create(data: Partial<Product>, context?: ServiceContext): Promise<Product> {
    return prisma.product.create({
      data: {
        name: data.name!,
        slug: data.slug ?? this.generateSlug(data.name!),
        description: data.description,
        price: data.price!,
        sku: data.sku!,
        stock: data.stock ?? 0,
        isActive: data.isActive ?? true,
        organizationId: context?.organizationId ?? data.organizationId!,
        createdBy: context?.userId,
      },
    });
  }

  /**
   * Update product
   */
  async update(id: string, data: Partial<Product>, context?: ServiceContext): Promise<Product> {
    const policyFilters = context?.filters ?? {};

    // Verify product exists and user has access
    const existing = await prisma.product.findFirst({
      where: { id, deletedAt: null, ...policyFilters },
    });

    if (!existing) {
      throw new Error('Product not found or access denied');
    }

    return prisma.product.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.slug && { slug: data.slug }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.price && { price: data.price }),
        ...(data.sku && { sku: data.sku }),
        ...(data.stock !== undefined && { stock: data.stock }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });
  }

  /**
   * Soft delete product
   */
  async delete(id: string, context?: ServiceContext): Promise<void> {
    const policyFilters = context?.filters ?? {};

    await prisma.product.updateMany({
      where: { id, deletedAt: null, ...policyFilters },
      data: { deletedAt: new Date() },
    });
  }

  // ========================================
  // Preset Methods (softDelete, slugLookup)
  // ========================================

  /**
   * Get soft-deleted products (for admin restore UI)
   */
  async getDeleted(options?: QueryOptions): Promise<Product[]> {
    const policyFilters = options?.filters ?? {};

    return prisma.product.findMany({
      where: {
        deletedAt: { not: null },
        ...policyFilters,
      },
      orderBy: { deletedAt: 'desc' },
      take: options?.limit ?? 50,
    });
  }

  /**
   * Restore soft-deleted product
   */
  async restore(id: string, context?: ServiceContext): Promise<Product> {
    const policyFilters = context?.filters ?? {};

    const existing = await prisma.product.findFirst({
      where: { id, deletedAt: { not: null }, ...policyFilters },
    });

    if (!existing) {
      throw new Error('Deleted product not found or access denied');
    }

    return prisma.product.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /**
   * Get product by slug
   */
  async getBySlug(slug: string, options?: QueryOptions): Promise<Product | null> {
    const policyFilters = options?.filters ?? {};

    return prisma.product.findFirst({
      where: {
        slug: slug.toLowerCase(),
        deletedAt: null,
        ...policyFilters,
      },
    });
  }

  // ========================================
  // Custom Business Logic Methods
  // ========================================

  /**
   * Bulk update stock levels
   */
  async updateStock(updates: Array<{ id: string; stock: number }>): Promise<number> {
    const results = await Promise.all(
      updates.map(({ id, stock }) =>
        prisma.product.update({
          where: { id },
          data: { stock },
        })
      )
    );
    return results.length;
  }

  /**
   * Get low stock products
   */
  async getLowStock(threshold: number, organizationId: string): Promise<Product[]> {
    return prisma.product.findMany({
      where: {
        stock: { lte: threshold },
        isActive: true,
        deletedAt: null,
        organizationId,
      },
      orderBy: { stock: 'asc' },
    });
  }

  /**
   * Search products by name/description
   */
  async search(query: string, organizationId: string): Promise<Product[]> {
    return prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { sku: { contains: query, mode: 'insensitive' } },
        ],
        deletedAt: null,
        organizationId,
      },
      take: 50,
    });
  }

  // ========================================
  // Helper Methods
  // ========================================

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

const productRepository = new ProductRepository();

// ============================================================================
// 4. Define Resource with Prisma Adapter
// ============================================================================

export const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  tag: 'Catalog',
  prefix: '/products',

  // Prisma adapter with DMMF for OpenAPI schema generation
  adapter: createPrismaAdapter({
    client: prisma,
    modelName: 'Product',
    repository: productRepository,
    dmmf: Prisma.dmmf, // Enables automatic OpenAPI schema generation
    softDeleteEnabled: true,
    softDeleteField: 'deletedAt',
  }),

  // Presets: soft delete + slug lookup
  presets: ['softDelete', 'slugLookup', 'multiTenant'],

  // Enable organization scoping
  organizationScoped: true,

  // Permission configuration
  permissions: {
    list: allowPublic(), // Anyone can browse products
    get: allowPublic(), // Anyone can view product details
    create: requireRoles(['admin', 'inventory']), // Only admins/inventory can create
    update: requireRoles(['admin', 'inventory']), // Only admins/inventory can update
    delete: requireRoles(['admin']), // Only admins can delete
    // Preset permissions
    deleted: requireRoles(['admin']), // Only admins can see deleted
    restore: requireRoles(['admin']), // Only admins can restore
  },

  // Custom routes for business logic
  additionalRoutes: [
    {
      method: 'GET',
      path: '/low-stock',
      handler: 'getLowStock',
      summary: 'Get products with low stock',
      authRoles: ['admin', 'inventory'],
    },
    {
      method: 'POST',
      path: '/bulk-stock',
      handler: 'bulkUpdateStock',
      summary: 'Bulk update stock levels',
      authRoles: ['admin', 'inventory'],
    },
    {
      method: 'GET',
      path: '/search',
      handler: 'search',
      summary: 'Search products by name/description',
      authRoles: [], // Public search
    },
  ],

  // Event definitions
  events: {
    created: { description: 'Product created' },
    updated: { description: 'Product updated' },
    deleted: { description: 'Product deleted (soft)' },
    restored: { description: 'Product restored' },
    lowStock: { description: 'Product stock fell below threshold' },
  },
});

// ============================================================================
// 5. Usage Example - Application Setup
// ============================================================================

/*
// In your main application file:

import Fastify from 'fastify';
import { createApp } from '@classytic/arc';
import { productResource } from './modules/catalog/product.resource';

async function bootstrap() {
  // Connect to database
  await prisma.$connect();

  // Create Arc app with Fastify
  const app = await createApp({
    preset: 'production',
    auth: {
      jwt: { secret: process.env.JWT_SECRET! },
    },
    plugins: async (fastify) => {
      // Register product resource
      await fastify.register(productResource.toPlugin());
    },
  });

  // Start server
  await app.listen({ port: 3000 });
  console.log('Server running on http://localhost:3000');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await app.close();
    await prisma.$disconnect();
  });
}

bootstrap().catch(console.error);
*/

// ============================================================================
// 6. API Examples
// ============================================================================

/*
# List products (public)
GET /products?page=1&limit=20&sort=-createdAt

# Filter by price range
GET /products?price[gte]=10&price[lte]=100

# Filter by status
GET /products?isActive=true

# Get by ID (public)
GET /products/cuid123

# Get by slug (public)
GET /products/slug/awesome-product

# Create product (requires admin/inventory role)
POST /products
Headers: Authorization: Bearer <jwt>, x-organization-id: org123
Body: {
  "name": "Awesome Product",
  "price": 29.99,
  "sku": "PROD-001",
  "description": "An awesome product"
}

# Update product (requires admin/inventory role)
PATCH /products/cuid123
Body: { "price": 24.99, "stock": 100 }

# Delete product (requires admin role)
DELETE /products/cuid123

# Get deleted products (requires admin role)
GET /products/deleted

# Restore product (requires admin role)
POST /products/cuid123/restore

# Custom: Get low stock (requires admin/inventory role)
GET /products/low-stock?threshold=10

# Custom: Bulk update stock (requires admin/inventory role)
POST /products/bulk-stock
Body: { "updates": [{ "id": "cuid123", "stock": 50 }] }

# Custom: Search products (public)
GET /products/search?q=awesome
*/

export default productResource;
