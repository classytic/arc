/**
 * The fixtures the suite already writes by hand, written once.
 *
 * `list: allowPublic()` blocks appear in 141 files and hand-rolled `{ type:
 * "custom", name: "mem", repository }` adapters in 7 more. Retyping a fixture
 * is not just noise — it lets copies DRIFT, so a test can silently assert
 * against a shape no other test uses.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import type { RequestScope } from "../../src/scope/types.js";

type AnyRecord = Record<string, unknown>;

/** The permission matrices the suite actually uses. */
export const PERMS = {
  /** Every CRUD op public — the default for tests that are not ABOUT permissions. */
  all: {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  },
  /** Reads public, writes authenticated. */
  readPublicWriteAuth: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireAuth(),
  },
} as const;

/**
 * An in-memory repository good enough to mount routes against.
 *
 * Deliberately NOT a full store: tests that need real persistence take a
 * database from `db.ts`. This exists so a test about ROUTING or PERMISSIONS
 * does not have to care about storage at all.
 */
export function anAdapter<TDoc extends AnyRecord = AnyRecord>(
  seed: TDoc[] = [],
): DataAdapter<TDoc> {
  const rows = [...seed];
  const repository = {
    capabilities: { transactions: false, nestedTransactions: false, upsert: true },
    async getAll() {
      return { method: "offset", data: rows, total: rows.length, page: 1, limit: 20 };
    },
    async getById(id: string) {
      return rows.find((r) => String((r as AnyRecord)._id) === id) ?? null;
    },
    async findAll() {
      return rows;
    },
    async count() {
      return rows.length;
    },
    async create(doc: Partial<TDoc>) {
      const row = { _id: `id-${rows.length + 1}`, ...doc } as TDoc;
      rows.push(row);
      return row;
    },
    async update(id: string, patch: Partial<TDoc>) {
      const row = rows.find((r) => String((r as AnyRecord)._id) === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async delete(id: string) {
      const i = rows.findIndex((r) => String((r as AnyRecord)._id) === id);
      if (i < 0) return null;
      rows.splice(i, 1);
      return { success: true };
    },
  };
  return { type: "custom", name: "harness", repository } as unknown as DataAdapter<TDoc>;
}

/** A resource with everything a mountable resource needs, and nothing else. */
export function aResource(name: string, overrides: AnyRecord = {}) {
  return defineResource({
    name,
    adapter: anAdapter(),
    permissions: PERMS.all,
    ...overrides,
  } as never);
}

/**
 * The five `RequestScope` shapes, by name.
 *
 * Tests build these inline constantly and get them subtly wrong — a `member`
 * without `orgRoles`, an `authenticated` carrying an `organizationId`. The
 * union is discriminated for a reason; these are the valid inhabitants.
 */
export const aScope = {
  public: (): RequestScope => ({ kind: "public" }) as RequestScope,
  authenticated: (userId = "u1"): RequestScope =>
    ({ kind: "authenticated", userId, userRoles: [] }) as RequestScope,
  member: (over: AnyRecord = {}): RequestScope =>
    ({
      kind: "member",
      userId: "u1",
      userRoles: [],
      organizationId: "org-1",
      orgRoles: ["member"],
      ...over,
    }) as RequestScope,
  service: (over: AnyRecord = {}): RequestScope =>
    ({
      kind: "service",
      clientId: "client-1",
      organizationId: "org-1",
      scopes: [],
      ...over,
    }) as RequestScope,
  /**
   * `elevatedBy` is REQUIRED by the union — an elevated scope always records
   * who granted it, because "escalated privilege with no attributable source"
   * is the shape an audit cannot answer questions about.
   */
  elevated: (over: AnyRecord = {}): RequestScope =>
    ({
      kind: "elevated",
      userId: "u1",
      organizationId: "org-1",
      elevatedBy: "platform-admin",
      ...over,
    }) as RequestScope,
} as const;
