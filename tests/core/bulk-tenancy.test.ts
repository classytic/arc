/**
 * Bulk writes follow the same tenancy rule as everything else.
 *
 * `buildBulkFilter` and `bulkCreate` each short-circuited for ANY elevated
 * caller before looking at the org:
 *   - an admin who had SELECTED org-9 ran `bulkDelete` / `bulkUpdate` across
 *     EVERY tenant, while the same admin deleting one row by id was scoped to
 *     org-9 (`buildIdFilter`);
 *   - the same admin's `bulkCreate` stamped no org at all, while a single
 *     create was stamped org-9 by the preset.
 * Both now go through `resolveTenancy`. Only the platform view — elevated with
 * NO org — writes across tenants.
 */

import { describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

const member = { kind: "member", userId: "u1", userRoles: [], organizationId: "org-1", orgRoles: [] };
const elevatedWithOrg = { kind: "elevated", elevatedBy: "admin", organizationId: "org-9" };
const platform = { kind: "elevated", elevatedBy: "admin" };
const noOrg = { kind: "authenticated", userId: "u2", userRoles: [] };
const anonymous = { kind: "public" };

function controller() {
  const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
  const updateMany = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  const createMany = vi.fn(async (items: unknown[]) => items);
  const repo = {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany,
    updateMany,
    createMany,
  };
  const ctl = new BaseController(repo, { resourceName: "order" });
  return { ctl, deleteMany, updateMany, createMany };
}

const req = (body: unknown, scope: unknown) => ({
  params: {},
  query: {},
  body,
  headers: {},
  user: { _id: "u" },
  metadata: { arc: { hooks: new HookSystem() }, _scope: scope },
});

/** The filter a bulk delete reached the repository with, or null if refused. */
async function bulkDeleteFilter(scope: unknown): Promise<unknown> {
  const { ctl, deleteMany } = controller();
  const res = await ctl
    .bulkDelete(req({ filter: { status: "draft" } }, scope) as never)
    .catch((e: { status?: number; statusCode?: number }) => ({ status: e.status ?? e.statusCode }));
  if (deleteMany.mock.calls.length === 0) return { refused: (res as { status?: number }).status };
  return deleteMany.mock.calls[0]?.[0];
}

const hasOrg = (filter: unknown, org: string) => JSON.stringify(filter).includes(`"${org}"`);

describe("bulkDelete / bulkUpdate tenancy", () => {
  it("an elevated admin who SELECTED an org is scoped to it", async () => {
    // Pre-fix: no org filter at all — every tenant's drafts.
    expect(hasOrg(await bulkDeleteFilter(elevatedWithOrg), "org-9")).toBe(true);
  });

  it("a member is scoped to their org", async () => {
    expect(hasOrg(await bulkDeleteFilter(member), "org-1")).toBe(true);
  });

  it("the platform view (elevated, no org) writes across tenants — unchanged", async () => {
    const filter = await bulkDeleteFilter(platform);
    expect(filter).not.toHaveProperty("refused");
    expect(JSON.stringify(filter)).not.toContain("organizationId");
  });

  it.each([
    ["signed in, no org", noOrg],
    ["anonymous", anonymous],
  ])("%s is refused", async (_label, scope) => {
    const out = (await bulkDeleteFilter(scope)) as { refused?: number };
    expect(out.refused).toBe(403);
  });

  it("a cross-tenant READ flag never widens a write", async () => {
    const { ctl, deleteMany } = controller();
    const r = req({ filter: { status: "draft" } }, member);
    (r.metadata as Record<string, unknown>)._crossTenantRead = true;
    await ctl.bulkDelete(r as never).catch(() => {});
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("bulkUpdate follows the same rule", async () => {
    const { ctl, updateMany } = controller();
    await ctl.bulkUpdate(
      req({ filter: { status: "draft" }, data: { $set: { status: "x" } } }, elevatedWithOrg) as never,
    );
    expect(hasOrg(updateMany.mock.calls[0]?.[0], "org-9")).toBe(true);
  });
});

describe("bulkCreate tenancy", () => {
  const items = [{ name: "a", organizationId: "org-SMUGGLED" }, { name: "b" }];

  it("an elevated admin who SELECTED an org stamps it on every item", async () => {
    // Pre-fix: nothing was stamped, so item one kept its smuggled org.
    const { ctl, createMany } = controller();
    await ctl.bulkCreate(req({ items }, elevatedWithOrg) as never);
    const created = createMany.mock.calls[0]?.[0] as Array<{ organizationId?: string }>;
    expect(created.map((i) => i.organizationId)).toEqual(["org-9", "org-9"]);
  });

  it("a member stamps their own org, overriding what the body said", async () => {
    const { ctl, createMany } = controller();
    await ctl.bulkCreate(req({ items }, member) as never);
    const created = createMany.mock.calls[0]?.[0] as Array<{ organizationId?: string }>;
    expect(created.every((i) => i.organizationId === "org-1")).toBe(true);
  });

  it("the platform view picks per-item orgs — no injection", async () => {
    const { ctl, createMany } = controller();
    await ctl.bulkCreate(req({ items: [{ name: "a", organizationId: "org-3" }] }, platform) as never);
    const created = createMany.mock.calls[0]?.[0] as Array<{ organizationId?: string }>;
    expect(created[0]?.organizationId).toBe("org-3");
  });

  it.each([
    ["signed in, no org", noOrg],
    ["anonymous", anonymous],
  ])("%s is refused with ORG_CONTEXT_REQUIRED", async (_label, scope) => {
    const { ctl, createMany } = controller();
    await expect(ctl.bulkCreate(req({ items }, scope) as never)).rejects.toMatchObject({
      code: "ORG_CONTEXT_REQUIRED",
    });
    expect(createMany).not.toHaveBeenCalled();
  });
});
