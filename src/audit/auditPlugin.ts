/**
 * Audit Plugin
 *
 * Optional audit trail with flexible storage options.
 * Disabled by default - enable explicitly for enterprise use cases.
 *
 * @example
 * import { auditPlugin } from '@classytic/arc/audit';
 *
 * // Development: in-memory
 * await fastify.register(auditPlugin, {
 *   enabled: true,
 *   stores: ['memory'],
 * });
 *
 * // Production: MongoDB with TTL
 * await fastify.register(auditPlugin, {
 *   enabled: true,
 *   stores: ['mongodb'],
 *   mongoConnection: mongoose.connection,
 *   ttlDays: 90,
 * });
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AuditContext, AuditEntry, AuditStore } from './stores/interface.js';
import { createAuditEntry } from './stores/interface.js';
import { MemoryAuditStore } from './stores/memory.js';
import { MongoAuditStore } from './stores/mongodb.js';
import type { UserBase, RequestContext } from '../types/index.js';

export interface AuditPluginOptions {
  /** Enable audit logging (default: false) */
  enabled?: boolean;
  /** Storage backends to use */
  stores?: ('memory' | 'mongodb')[];
  /** MongoDB connection (required if using mongodb store) */
  mongoConnection?: { collection: (name: string) => unknown };
  /** MongoDB collection name (default: 'audit_logs') */
  mongoCollection?: string;
  /** TTL in days for MongoDB (default: 90) */
  ttlDays?: number;
  /** Custom stores (advanced) */
  customStores?: AuditStore[];
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Log an audit entry */
    audit: AuditLogger;
  }

  interface FastifyRequest {
    /** Audit context for current request */
    auditContext?: AuditContext;
  }
}

export interface AuditLogger {
  /** Log a create action */
  create: (
    resource: string,
    documentId: string,
    data: Record<string, unknown>,
    context?: AuditContext
  ) => Promise<void>;

  /** Log an update action */
  update: (
    resource: string,
    documentId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    context?: AuditContext
  ) => Promise<void>;

  /** Log a delete action */
  delete: (
    resource: string,
    documentId: string,
    data: Record<string, unknown>,
    context?: AuditContext
  ) => Promise<void>;

  /** Log a restore action (soft delete undo) */
  restore: (
    resource: string,
    documentId: string,
    data: Record<string, unknown>,
    context?: AuditContext
  ) => Promise<void>;

  /** Log a custom action */
  custom: (
    resource: string,
    documentId: string,
    action: string,
    data?: Record<string, unknown>,
    context?: AuditContext
  ) => Promise<void>;

  /** Query audit logs (if stores support it) */
  query: (options: import('./stores/interface.js').AuditQueryOptions) => Promise<AuditEntry[]>;
}

const auditPlugin: FastifyPluginAsync<AuditPluginOptions> = async (
  fastify: FastifyInstance,
  opts: AuditPluginOptions = {}
) => {
  const {
    enabled = false,
    stores: storeTypes = ['memory'],
    mongoConnection,
    mongoCollection = 'audit_logs',
    ttlDays = 90,
    customStores = [],
  } = opts;

  // Skip if not enabled
  if (!enabled) {
    // Provide no-op audit methods
    fastify.decorate('audit', createNoopLogger());
    fastify.decorateRequest('auditContext', undefined);
    fastify.log?.debug?.('Audit plugin disabled');
    return;
  }

  // Initialize stores
  const stores: AuditStore[] = [...customStores];

  for (const type of storeTypes) {
    switch (type) {
      case 'memory':
        stores.push(new MemoryAuditStore());
        break;
      case 'mongodb':
        if (!mongoConnection) {
          throw new Error('Audit: mongoConnection required for mongodb store');
        }
        stores.push(new MongoAuditStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          connection: mongoConnection as any,
          collection: mongoCollection,
          ttlDays,
        }));
        break;
    }
  }

  if (stores.length === 0) {
    throw new Error('Audit: at least one store must be configured');
  }

  // Log to all stores
  async function logToStores(entry: AuditEntry): Promise<void> {
    await Promise.all(stores.map((store) => store.log(entry)));
  }

  // Create audit logger
  const audit: AuditLogger = {
    async create(resource, documentId, data, context) {
      const entry = createAuditEntry(resource, documentId, 'create', context ?? {}, {
        after: data,
      });
      await logToStores(entry);
    },

    async update(resource, documentId, before, after, context) {
      const entry = createAuditEntry(resource, documentId, 'update', context ?? {}, {
        before,
        after,
      });
      await logToStores(entry);
    },

    async delete(resource, documentId, data, context) {
      const entry = createAuditEntry(resource, documentId, 'delete', context ?? {}, {
        before: data,
      });
      await logToStores(entry);
    },

    async restore(resource, documentId, data, context) {
      const entry = createAuditEntry(resource, documentId, 'restore', context ?? {}, {
        after: data,
      });
      await logToStores(entry);
    },

    async custom(resource, documentId, action, data, context) {
      const entry = createAuditEntry(resource, documentId, 'custom', context ?? {}, {
        metadata: { customAction: action, ...data },
      });
      await logToStores(entry);
    },

    async query(options) {
      // Use first store that supports querying
      for (const store of stores) {
        if (store.query) {
          return store.query(options);
        }
      }
      return [];
    },
  };

  fastify.decorate('audit', audit);

  // Extract audit context from request
  fastify.decorateRequest('auditContext', undefined);

  fastify.addHook('onRequest', async (request) => {
    const user = (request as FastifyRequest & { user?: UserBase }).user;
    const context = (request as FastifyRequest & { context?: RequestContext }).context;

    request.auditContext = {
      user,
      organizationId: context?.organizationId ?? undefined,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  });

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    await Promise.all(stores.map((store) => store.close?.()));
  });

  fastify.log?.info?.({ stores: storeTypes }, 'Audit plugin enabled');
};

/**
 * Create no-op logger for when audit is disabled
 */
function createNoopLogger(): AuditLogger {
  const noop = async () => {};
  return {
    create: noop,
    update: noop,
    delete: noop,
    restore: noop,
    custom: noop,
    query: async () => [],
  };
}

export default fp(auditPlugin, {
  name: 'arc-audit',
  fastify: '5.x',
});

export { auditPlugin };
