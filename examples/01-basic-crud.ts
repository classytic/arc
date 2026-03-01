/**
 * Example: Basic CRUD Resource with Mongoose
 *
 * Demonstrates the adapter-based architecture with defineResource().
 */

import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, permissions, allowPublic } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

// ============================================================================
// 1. Define Mongoose Model
// ============================================================================

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, sparse: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

productSchema.index({ name: 1 });
productSchema.index({ slug: 1 });

const Product = mongoose.model('Product', productSchema);

// ============================================================================
// 2. Create Repository (MongoKit)
// ============================================================================

class ProductRepository extends Repository {
  constructor() {
    super(Product);
  }

  async getBySlug(slug: string) {
    return this.Model.findOne({ slug: slug.toLowerCase(), deletedAt: null }).lean();
  }

  async getDeleted() {
    return this.Model.find({ deletedAt: { $ne: null } }).sort({ deletedAt: -1 }).lean();
  }

  async restore(id: string) {
    return this.Model.findByIdAndUpdate(id, { deletedAt: null }, { new: true }).lean();
  }
}

const productRepository = new ProductRepository();

// ============================================================================
// 3. Define Resource with Adapter
// ============================================================================

export const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  module: 'catalog',

  adapter: createMongooseAdapter(Product, productRepository),

  // Presets add functionality without code
  presets: ['softDelete', 'slugLookup'],

  // Permissions — public read, admin write
  permissions: permissions.publicReadAdminWrite(),

  // Custom routes
  additionalRoutes: [
    {
      method: 'GET',
      path: '/search',
      wrapHandler: false,
      permissions: allowPublic(),
      summary: 'Search products by name',
      handler: async (req, reply) => {
        const { q } = req.query as { q: string };
        const results = await Product.find({
          name: { $regex: q, $options: 'i' },
          deletedAt: null,
        }).lean();
        return reply.send({ success: true, data: results });
      },
    },
  ],

  // Events
  events: {
    created: { description: 'Product created' },
    updated: { description: 'Product updated' },
    priceChanged: { description: 'Product price changed', schema: { oldPrice: 'number', newPrice: 'number' } },
  },
});

// ============================================================================
// 4. Register with Fastify
// ============================================================================

// In your app:
// await fastify.register(productResource.toPlugin());

// Routes auto-generated:
// GET    /products          - List all
// GET    /products/:id      - Get by ID
// POST   /products          - Create (admin only)
// PATCH  /products/:id      - Update (admin only)
// DELETE /products/:id      - Delete (admin only)
//
// From presets:
// GET    /products/slug/:slug  - Get by slug
// GET    /products/deleted     - List soft-deleted
// POST   /products/:id/restore - Restore soft-deleted
//
// Custom:
// GET    /products/search?q=laptop - Search by name
