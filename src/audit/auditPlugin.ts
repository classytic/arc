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
import { MongoAuditStore, type MongoConnection } from './stores/mongodb.js';
import type { UserBase, RequestContext } from '../types/index.js';

export interface AuditPluginOptions {
  /** Enable audit logging (default: false) */
  enabled?: boolean;
  /** Storage backends to use */
  stores?: ('memory' | 'mongodb')[];
  /** MongoDB connection (required if using mongodb store) */
  mongoConnection?: MongoConnection;
  /** MongoDB collection name (default: 'audit_logs') */
  mongoCollection?: string;
  /** TTL in days for MongoDB (default: 90) */
  ttlDays?: number;
  /** Custom stores (advanced) */
  customStores?: AuditStore[];
  /**
   * Automatically audit CRUD operations via the hook system (default: true when enabled).
   * When enabled, create/update/delete operations are auto-logged without manual calls.
   *
   * - `true`: Auto-audit all CRUD operations on all resources
   * - `{ operations: ['create', 'delete'] }`: Only auto-audit specific operations
   * - `{ exclude: ['health', 'metrics'] }`: Skip specific resources
   * - `false`: Disable auto-audit (manual calls only)
   */
  autoAudit?: boolean | {
    operations?: ('create' | 'update' | 'delete')[];
    exclude?: string[];
  };
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
          connection: mongoConnection,
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

    // Derive org ID from request.scope (set by auth adapters)
    const scope = request.scope;
    const auditOrgId = scope?.kind === 'member' ? scope.organizationId
      : scope?.kind === 'elevated' ? scope.organizationId
      : undefined;

    request.auditContext = {
      user,
      organizationId: auditOrgId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      endpoint: undefined,
      duration: undefined,
    };
  });

  // Populate endpoint and duration after response is sent
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.auditContext) {
      request.auditContext.endpoint = `${request.method} ${request.routeOptions?.url ?? request.url}`;
      request.auditContext.duration = Math.round(reply.elapsedTime);
    }
  });

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    await Promise.all(stores.map((store) => store.close?.()));
  });

  // Auto-audit CRUD operations via hook system
  const autoAuditConfig = opts.autoAudit ?? true;
  if (autoAuditConfig !== false) {
    const defaultOps = ['create', 'update', 'delete'] as const;
    const ops = typeof autoAuditConfig === 'object'
      ? autoAuditConfig.operations ?? defaultOps
      : defaultOps;
    const excludeResources = new Set(
      typeof autoAuditConfig === 'object' ? autoAuditConfig.exclude ?? [] : [],
    );

    // Wire hooks after all plugins are registered (onReady) so arc-core is available
    fastify.addHook('onReady', async () => {
      // fastify.arc is declared via module augmentation in arcCorePlugin.ts
      const arc = 'arc' in fastify ? fastify.arc : undefined;
      if (!arc?.hooks) {
        fastify.log?.debug?.('Auto-audit skipped: arc-core plugin not registered');
        return;
      }

      for (const op of ops) {
        arc.hooks.after('*', op, async (ctx) => {
          if (excludeResources.has(ctx.resource)) return;

          const docId = autoAuditExtractId(ctx.result);
          const scope = (ctx.context as Record<string, unknown> | undefined)?._scope;
          const auditCtx: AuditContext = {
            user: ctx.user,
            organizationId: scope ? autoAuditGetOrgId(scope) : undefined,
          };

          try {
            if (op === 'create') {
              await audit.create(ctx.resource, docId, autoAuditToPlain(ctx.result), auditCtx);
            } else if (op === 'update') {
              await audit.update(
                ctx.resource,
                docId,
                autoAuditToPlain(ctx.meta?.existing),
                autoAuditToPlain(ctx.result),
                auditCtx,
              );
            } else if (op === 'delete') {
              await audit.delete(ctx.resource, docId, autoAuditToPlain(ctx.result), auditCtx);
            }
          } catch (err) {
            fastify.log?.warn?.(
              { resource: ctx.resource, op, err },
              'Auto-audit failed',
            );
          }
        }, 90); // Priority 90 — after user hooks, before event hooks at 100
      }

      fastify.log?.debug?.({ ops, exclude: [...excludeResources] }, 'Auto-audit hooks registered');
    });
  }

  fastify.log?.debug?.({ stores: storeTypes }, 'Audit plugin enabled');
};

/** Extract document ID from a result */
function autoAuditExtractId(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const d = doc as Record<string, unknown>;
  const rawId = d._id ?? d.id;
  return rawId != null ? String(rawId) : '';
}

/** Convert Mongoose doc or plain object to plain object */
function autoAuditToPlain(doc: unknown): Record<string, unknown> {
  if (!doc || typeof doc !== 'object') return {};
  if (typeof (doc as Record<string, unknown>).toObject === 'function') {
    return (doc as { toObject: () => Record<string, unknown> }).toObject();
  }
  return doc as Record<string, unknown>;
}

/** Extract org ID from scope (avoids importing scope module to prevent circular deps) */
function autoAuditGetOrgId(scope: unknown): string | undefined {
  if (!scope || typeof scope !== 'object') return undefined;
  const s = scope as Record<string, unknown>;
  if (s.kind === 'member' || s.kind === 'elevated') {
    return s.organizationId as string | undefined;
  }
  return undefined;
}

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
  dependencies: ['arc-core'],
});

export { auditPlugin };
