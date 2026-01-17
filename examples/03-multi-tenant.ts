/**
 * Multi-Tenant Resource Example
 *
 * Demonstrates organization-scoped resources with tenant isolation.
 * Each organization can only see and modify their own data.
 *
 * Features shown:
 * - multiTenant preset for automatic org filtering
 * - Organization scoping on routes
 * - Soft delete within tenant context
 * - Permission-based access control
 *
 * @example
 * // Request with organization context
 * GET /invoices
 * Headers:
 *   Authorization: Bearer <jwt>
 *   x-organization-id: 507f1f77bcf86cd799439011
 *
 * // Only returns invoices belonging to that organization
 */

import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

// ============================================================================
// 1. Define the Mongoose Schema
// ============================================================================

const invoiceSchema = new mongoose.Schema(
  {
    // Invoice details
    number: {
      type: String,
      required: true,
      unique: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'EUR', 'GBP', 'BDT'],
    },
    status: {
      type: String,
      default: 'draft',
      enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'],
    },
    dueDate: Date,

    // Customer reference
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },

    // Multi-tenant: Organization ownership
    // This field is automatically filtered/injected by the multiTenant preset
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true, // Index for efficient tenant queries
    },

    // Soft delete support
    deletedAt: {
      type: Date,
      default: null,
    },

    // Audit fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient tenant + status queries
invoiceSchema.index({ organizationId: 1, status: 1 });
invoiceSchema.index({ organizationId: 1, createdAt: -1 });

const Invoice = mongoose.model('Invoice', invoiceSchema);

// ============================================================================
// 2. Create Repository (MongoKit)
// ============================================================================

class InvoiceRepository extends Repository<typeof Invoice> {
  constructor() {
    super(Invoice);
  }

  /**
   * Get invoices by status within organization
   * Note: organizationId filter is automatically applied by middleware
   */
  async getByStatus(status: string, orgFilters?: Record<string, unknown>) {
    return this.model.find({
      status,
      deletedAt: null,
      ...orgFilters,
    });
  }

  /**
   * Get overdue invoices
   */
  async getOverdue(orgFilters?: Record<string, unknown>) {
    return this.model.find({
      status: { $in: ['sent', 'overdue'] },
      dueDate: { $lt: new Date() },
      deletedAt: null,
      ...orgFilters,
    });
  }

  /**
   * Calculate total revenue for organization
   */
  async getTotalRevenue(orgFilters?: Record<string, unknown>) {
    const result = await this.model.aggregate([
      {
        $match: {
          status: 'paid',
          deletedAt: null,
          ...orgFilters,
        },
      },
      {
        $group: {
          _id: '$currency',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);
    return result;
  }
}

const invoiceRepository = new InvoiceRepository();

// ============================================================================
// 3. Define Resource with Multi-Tenant Preset
// ============================================================================

/**
 * Invoice Resource
 *
 * Multi-tenant resource that automatically:
 * - Filters queries by organizationId
 * - Injects organizationId on create
 * - Prevents cross-tenant access
 * - Allows superadmin to bypass (for support/admin tasks)
 */
export const invoiceResource = defineResource({
  name: 'invoice',
  displayName: 'Invoices',
  tag: 'Finance',
  prefix: '/invoices',

  // Database adapter
  adapter: createMongooseAdapter({
    model: Invoice,
    repository: invoiceRepository,
  }),

  // Apply presets: multi-tenant isolation + soft delete
  presets: [
    'multiTenant', // Auto-filter by organizationId
    'softDelete', // Soft delete support
  ],

  // Enable organization scoping on all routes
  organizationScoped: true,

  // Permission configuration
  // Members can view, admins can modify
  permissions: {
    list: ['member', 'admin', 'finance'],
    get: ['member', 'admin', 'finance'],
    create: ['admin', 'finance'],
    update: ['admin', 'finance'],
    delete: ['admin'],
    // Soft delete preset permissions
    deleted: ['admin'],
    restore: ['admin'],
  },

  // Custom routes for business logic
  additionalRoutes: [
    {
      method: 'GET',
      path: '/overdue',
      handler: 'getOverdue',
      summary: 'Get overdue invoices',
      authRoles: ['admin', 'finance'],
    },
    {
      method: 'GET',
      path: '/stats',
      handler: 'getStats',
      summary: 'Get invoice statistics',
      authRoles: ['admin', 'finance'],
    },
    {
      method: 'POST',
      path: '/:id/send',
      handler: 'sendInvoice',
      summary: 'Send invoice to customer',
      authRoles: ['admin', 'finance'],
    },
    {
      method: 'POST',
      path: '/:id/mark-paid',
      handler: 'markPaid',
      summary: 'Mark invoice as paid',
      authRoles: ['admin', 'finance'],
    },
  ],

  // Event definitions for integration
  events: {
    created: {
      description: 'Invoice created',
      schema: {
        invoiceId: 'string',
        organizationId: 'string',
        amount: 'number',
      },
    },
    sent: {
      description: 'Invoice sent to customer',
    },
    paid: {
      description: 'Invoice marked as paid',
    },
    overdue: {
      description: 'Invoice became overdue',
    },
  },
});

// ============================================================================
// 4. Usage Example
// ============================================================================

/*
// In your main application:

import { createApp } from '@classytic/arc';
import mongoose from 'mongoose';
import { invoiceResource } from './modules/finance/invoice.resource';

await mongoose.connect(process.env.MONGO_URI);

const app = await createApp({
  preset: 'production',
  jwtSecret: process.env.JWT_SECRET,
  plugins: async (fastify) => {
    // Register the multi-tenant invoice resource
    await fastify.register(invoiceResource.toPlugin());
  },
});

// API calls will automatically be scoped to the user's organization:

// List invoices (automatically filtered by x-organization-id header)
// GET /invoices
// Headers: Authorization: Bearer <jwt>, x-organization-id: <org-id>

// Create invoice (organizationId automatically injected)
// POST /invoices
// Body: { number: "INV-001", amount: 1000, customerId: "..." }

// Get overdue invoices for the organization
// GET /invoices/overdue

// Mark invoice as paid
// POST /invoices/:id/mark-paid
*/

export default invoiceResource;
