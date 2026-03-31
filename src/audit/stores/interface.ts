/**
 * Audit Store Interface
 *
 * Pluggable storage backend for audit logs.
 * Implementations: memory (dev), mongodb, event (emit only)
 */

import type { UserBase } from "../../types/index.js";

export type AuditAction = "create" | "update" | "delete" | "restore" | "custom";

export interface AuditEntry {
  /** Unique audit log ID */
  id: string;
  /** Resource name (e.g., 'product', 'user') */
  resource: string;
  /** Document/entity ID */
  documentId: string;
  /** Action performed */
  action: AuditAction;
  /** User who performed the action */
  userId?: string;
  /** Organization context */
  organizationId?: string;
  /** Previous state (for updates) */
  before?: Record<string, unknown>;
  /** New state (for creates/updates) */
  after?: Record<string, unknown>;
  /** Changed fields (for updates) */
  changes?: string[];
  /** Request ID for tracing */
  requestId?: string;
  /** IP address */
  ipAddress?: string;
  /** User agent */
  userAgent?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** When the action occurred */
  timestamp: Date;
}

export interface AuditContext {
  user?: UserBase;
  organizationId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** HTTP method + route pattern (e.g., 'PATCH /api/products/:id') */
  endpoint?: string;
  /** Request duration in milliseconds */
  duration?: number;
}

export interface AuditStoreOptions {
  /** Store name for logging */
  name: string;
}

/**
 * Abstract audit store interface
 */
export interface AuditStore {
  /** Store name */
  readonly name: string;

  /** Log an audit entry */
  log(entry: AuditEntry): Promise<void>;

  /** Query audit logs (optional - not all stores support querying) */
  query?(options: AuditQueryOptions): Promise<AuditEntry[]>;

  /** Close/cleanup (optional) */
  close?(): Promise<void>;
}

export interface AuditQueryOptions {
  resource?: string;
  documentId?: string;
  userId?: string;
  organizationId?: string;
  action?: AuditAction | AuditAction[];
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Create audit entry from context
 */
export function createAuditEntry(
  resource: string,
  documentId: string,
  action: AuditAction,
  context: AuditContext,
  data?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): AuditEntry {
  const changes = data?.before && data?.after ? detectChanges(data.before, data.after) : undefined;

  return {
    id: generateAuditId(),
    resource,
    documentId,
    action,
    userId: context.user?._id?.toString() ?? context.user?.id,
    organizationId: context.organizationId,
    before: data?.before,
    after: data?.after,
    changes,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: data?.metadata,
    timestamp: new Date(),
  };
}

/**
 * Detect changed fields between two objects
 */
function detectChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    // Skip internal fields
    if (key.startsWith("_") || key === "updatedAt") continue;

    const oldVal = JSON.stringify(before[key]);
    const newVal = JSON.stringify(after[key]);

    if (oldVal !== newVal) {
      changes.push(key);
    }
  }

  return changes;
}

/**
 * Generate unique audit ID
 */
function generateAuditId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `aud_${timestamp}${random}`;
}
