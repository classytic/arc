/**
 * Tests for the 2.15.5+2.16 fields surfaced by `arc describe`.
 *
 * The CLI's describe output is the structured contract consumed by AI
 * agents / codegen / audit scripts. It MUST stay in lockstep with the
 * registry / OpenAPI / MCP — when arc adds a field (id-less actions,
 * cascade flag, idField config), the describe output gains it too.
 *
 * Contract this file locks in:
 *  - Each action carries `requiresId` + `mount` so consumers can pick
 *    the right URL without reading the action definition.
 *  - Resources surface a `tenancy` block (`tenantField`, resolved
 *    `purgeStrategy`) so audit scripts answer "what cascades on
 *    org-delete?" without grepping.
 *  - Action mount routes (`POST /:id/action`, `POST /action`) and
 *    aggregation routes are part of the enumerated `routes[]`.
 *  - `idField` carries through.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describe as arcDescribe } from "../../src/cli/commands/describe.js";

interface DescribeOutput {
  resources: Array<{
    name: string;
    idField: string;
    tenancy: {
      tenantField: string | false | undefined;
      purgeStrategy?: { type: string; source: string };
    };
    actions: Array<{
      name: string;
      requiresId: boolean;
      mount: "/:id/action" | "/action";
    }>;
    routes: Array<{ method: string; path: string; operation: string }>;
  }>;
}

async function runDescribe(entryContent: string): Promise<DescribeOutput> {
  const tempDir = await mkdtemp(join(tmpdir(), "arc-describe-2-16-"));
  const entryPath = join(tempDir, "resources.mjs");
  await writeFile(entryPath, entryContent, "utf8");

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await arcDescribe([entryPath, "--json"]);
    return JSON.parse(logs.join("\n")) as DescribeOutput;
  } finally {
    console.log = originalLog;
    await rm(tempDir, { recursive: true, force: true });
  }
}

// A resource that exercises every 2.15.5+2.16 surface: id-bound action,
// id-less action, tenant field, cascade flag, declared purge strategy,
// custom idField, aggregation, plus baseline CRUD.
const FULL_2_16_RESOURCE = `
function makeRoles(roles) {
  const fn = () => ({ allowed: true });
  fn._roles = roles;
  return fn;
}
function makeAllowPublic() {
  const fn = () => ({ allowed: true });
  fn._isPublic = true;
  return fn;
}

export const invoiceResource = {
  name: 'invoice',
  displayName: 'Invoice',
  tag: 'Invoices',
  prefix: '/invoices',
  idField: 'invoiceNumber',
  tenantField: 'organizationId',
  onTenantDelete: { strategy: { type: 'hard' } },
  resolvedTenantPurge: {
    strategy: { type: 'hard' },
    priority: 100,
    source: 'declared',
  },
  permissions: {
    list: makeRoles(['admin']),
    get: makeRoles(['admin']),
    create: makeRoles(['admin']),
    update: makeRoles(['admin']),
    delete: makeRoles(['admin']),
  },
  _appliedPresets: [],
  routes: [],
  events: {},
  disableDefaultRoutes: false,
  actions: {
    // Id-bound: legacy default.
    recordPayment: {
      handler: async () => ({}),
      permissions: makeRoles(['admin']),
      schema: { type: 'object', properties: { amount: { type: 'number' } } },
      description: 'Record a payment',
    },
    // Id-less: 2.15.5 resource-root mount.
    propose: {
      handler: async () => ({}),
      permissions: makeAllowPublic(),
      id: false,
      schema: { type: 'object', properties: { brief: { type: 'string' } } },
    },
  },
  aggregations: {
    revenueByMonth: {
      summary: 'Monthly revenue',
      groupBy: 'createdAt',
      measures: { total: { op: 'sum', field: 'amount' } },
      permissions: makeRoles(['admin']),
    },
  },
  _registryMeta: {},
  toPlugin() { return async function plugin() {}; },
};
`;

describe("arc describe — 2.16 fields", () => {
  it("emits `tenancy` block with tenantField + resolved purge strategy", async () => {
    const out = await runDescribe(FULL_2_16_RESOURCE);
    const r = out.resources[0];
    expect(r.tenancy.tenantField).toBe("organizationId");
    // The CLI surfaces the resolved strategy + its source so audit
    // scripts read "what happens on org-delete?" without inferring.
    expect(r.tenancy.purgeStrategy).toEqual({ type: "hard", source: "declared" });
  });

  it("surfaces the configured `idField` (defaults to `_id` when omitted)", async () => {
    const out = await runDescribe(FULL_2_16_RESOURCE);
    expect(out.resources[0].idField).toBe("invoiceNumber");
  });

  it("each action carries `requiresId` + `mount` so callers pick the right URL", async () => {
    const out = await runDescribe(FULL_2_16_RESOURCE);
    const byName = Object.fromEntries(out.resources[0].actions.map((a) => [a.name, a]));
    expect(byName.recordPayment.requiresId).toBe(true);
    expect(byName.recordPayment.mount).toBe("/:id/action");
    expect(byName.propose.requiresId).toBe(false);
    expect(byName.propose.mount).toBe("/action");
  });

  it("enumerates BOTH action mount paths when the resource mixes id-bound and id-less", async () => {
    const out = await runDescribe(FULL_2_16_RESOURCE);
    const actionPaths = out.resources[0].routes
      .filter((r) => r.operation === "action")
      .map((r) => r.path);
    // Pre-2.15.5 only the id-bound row was emitted; mixed resources now
    // surface both so the wire surface matches what the runtime mounts.
    expect(actionPaths).toContain("/invoices/:id/action");
    expect(actionPaths).toContain("/invoices/action");
  });

  it("enumerates aggregation routes (v2.13) alongside CRUD + actions", async () => {
    const out = await runDescribe(FULL_2_16_RESOURCE);
    const aggRoute = out.resources[0].routes.find((r) => r.operation.startsWith("aggregation:"));
    expect(aggRoute).toEqual({
      method: "GET",
      path: "/invoices/aggregations/revenueByMonth",
      operation: "aggregation:revenueByMonth",
    });
  });
});
