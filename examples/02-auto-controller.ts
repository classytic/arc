/**
 * Example: Auto-Generated Controller
 *
 * defineResource() automatically creates BaseController from the adapter.
 * This reduces boilerplate for standard CRUD resources.
 */

import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, permissions } from '../src/index.js';
import { Repository } from '@classytic/mongokit';

// ============================================================================
// Model + Repository
// ============================================================================

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  displayOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const Category = mongoose.model('Category', categorySchema);

class CategoryRepository extends Repository {
  constructor() {
    super(Category);
  }

  async getTree() {
    const all = await this.Model.find({ isActive: true }).sort({ displayOrder: 1 }).lean();
    const map = new Map();
    const roots: unknown[] = [];

    for (const item of all) {
      map.set(item._id.toString(), { ...item, children: [] });
    }

    for (const item of all) {
      const node = map.get(item._id.toString());
      const parentId = (item as { parent?: unknown }).parent;
      if (parentId && map.has(parentId.toString())) {
        map.get(parentId.toString()).children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async getChildren(parentId: string) {
    return this.Model.find({ parent: parentId, isActive: true }).sort({ displayOrder: 1 }).lean();
  }

  async getBySlug(slug: string) {
    return this.Model.findOne({ slug: slug.toLowerCase() }).lean();
  }
}

// ============================================================================
// Resource — defineResource() auto-creates BaseController
// ============================================================================

export const categoryResource = defineResource({
  name: 'category',
  adapter: createMongooseAdapter(Category, new CategoryRepository()),

  presets: ['tree', 'slugLookup'],

  // Public read, admin write
  permissions: permissions.publicReadAdminWrite(),
});

// Auto-generated controller provides:
// - Standard CRUD operations
// - Org scoping (if multiTenant preset)
// - Ownership checks (if ownedByUser preset)
// - Policy filtering
// - Hook integration
// - Event emission
