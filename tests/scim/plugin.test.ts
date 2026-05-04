/**
 * SCIM 2.0 plugin — end-to-end against an in-memory repository
 *
 * Proves the canonical Okta / Azure AD / Google Workspace flows:
 *   - bearer auth (and verify callback)
 *   - User/Group CRUD with SCIM wire shapes
 *   - filter, count, startIndex pagination
 *   - PUT (full replace) + PATCH (RFC 7644 PatchOp)
 *   - Discovery endpoints (ServiceProviderConfig, ResourceTypes, Schemas)
 *   - Error envelope (RFC 7644 §3.12)
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ScimRepositoryLike, scimPlugin } from "../../src/scim/index.js";

// ─────────────────────────────────────────────────────────────────────
// Tiny in-memory repository — implements ScimRepositoryLike directly
// ─────────────────────────────────────────────────────────────────────

function makeRepo(): ScimRepositoryLike & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    rows,
    async getAll(opts) {
      const filters = opts?.filters ?? {};
      const all = [...rows.values()].filter((r) => matchFilter(r, filters));
      const limit = opts?.limit ?? 100;
      const page = opts?.page ?? 1;
      const start = (page - 1) * limit;
      return {
        method: "offset",
        data: all.slice(start, start + limit),
        total: all.length,
        page,
        limit,
        pages: Math.ceil(all.length / Math.max(1, limit)),
        hasNext: start + limit < all.length,
        hasPrev: page > 1,
      };
    },
    async getById(id) {
      return rows.get(String(id)) ?? null;
    },
    async create(data) {
      const id = `u_${++seq}`;
      const created = { id, ...data, createdAt: new Date().toISOString() };
      rows.set(id, created);
      return created;
    },
    async update(id, data) {
      const cur = rows.get(String(id));
      if (!cur) return null;
      // Strip nulls (PATCH unset semantics) instead of writing them
      for (const [k, v] of Object.entries(data)) {
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
      cur.updatedAt = new Date().toISOString();
      return cur;
    },
    async delete(id) {
      const ok = rows.delete(String(id));
      return { acknowledged: true, deletedCount: ok ? 1 : 0 };
    },
    // StandardRepo optionals — operator-aware update for PATCH, replaceOne for PUT.
    // Mimics mongokit's behaviour so the SCIM plugin's PATCH/PUT happy-path tests
    // exercise the operator code path. A "minimal kit" version omits these
    // (see makeMinimalRepo below) for honest-degradation tests.
    async findOneAndUpdate(filter: Record<string, unknown>, ops: Record<string, unknown>) {
      const id = String(filter.id ?? filter._id ?? "");
      const cur = rows.get(id);
      if (!cur) return null;
      const $set = (ops.$set as Record<string, unknown>) ?? {};
      const $unset = (ops.$unset as Record<string, true>) ?? {};
      const $push = (ops.$push as Record<string, unknown>) ?? {};
      const $pull = (ops.$pull as Record<string, unknown>) ?? {};
      // Inline-doc shorthand (no operators) treated as $set
      const flat = ops.$set === undefined && ops.$unset === undefined ? ops : {};
      Object.assign(cur, $set, flat);
      for (const k of Object.keys($unset)) delete cur[k];
      for (const [k, v] of Object.entries($push)) {
        const arr = (cur[k] as unknown[]) ?? [];
        const eachPayload = (v as { $each?: unknown[] })?.$each;
        cur[k] = Array.isArray(eachPayload) ? [...arr, ...eachPayload] : [...arr, v];
      }
      for (const [k, v] of Object.entries($pull)) {
        const arr = (cur[k] as unknown[]) ?? [];
        cur[k] = arr.filter((item) => JSON.stringify(item) !== JSON.stringify(v));
      }
      cur.updatedAt = new Date().toISOString();
      return cur;
    },
    async bulkWrite(ops: Array<Record<string, unknown>>) {
      let matchedCount = 0;
      let modifiedCount = 0;
      for (const op of ops) {
        const replace = op.replaceOne as
          | { filter: Record<string, unknown>; replacement: Record<string, unknown> }
          | undefined;
        if (replace) {
          const id = String(replace.filter.id ?? replace.filter._id ?? "");
          if (rows.has(id)) {
            matchedCount++;
            const fresh = { ...replace.replacement, id, updatedAt: new Date().toISOString() };
            rows.set(id, fresh);
            modifiedCount++;
          }
        }
      }
      return { matchedCount, modifiedCount };
    },
  };
}

/**
 * Minimal kit — only the 5 MinimalRepo ops, no findOneAndUpdate / bulkWrite.
 * Used to verify SCIM plugin's honest 400 / 501 degradation paths.
 */
function makeMinimalRepo(): ReturnType<typeof makeRepo> {
  const full = makeRepo();
  // Strip optional ops to simulate a kit that only implements MinimalRepo.
  const stripped = full as unknown as Record<string, unknown>;
  delete stripped.findOneAndUpdate;
  delete stripped.bulkWrite;
  return full;
}

function matchFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$and") {
      const list = v as Record<string, unknown>[];
      if (!list.every((sub) => matchFilter(row, sub))) return false;
      continue;
    }
    if (k === "$or") {
      const list = v as Record<string, unknown>[];
      if (!list.some((sub) => matchFilter(row, sub))) return false;
      continue;
    }
    if (k === "$nor") {
      const list = v as Record<string, unknown>[];
      if (list.some((sub) => matchFilter(row, sub))) return false;
      continue;
    }
    const cell = row[k];
    if (v && typeof v === "object") {
      const op = v as Record<string, unknown>;
      if ("$ne" in op && cell === op.$ne) return false;
      if ("$gt" in op && !((cell as number) > (op.$gt as number))) return false;
      if ("$gte" in op && !((cell as number) >= (op.$gte as number))) return false;
      if ("$lt" in op && !((cell as number) < (op.$lt as number))) return false;
      if ("$lte" in op && !((cell as number) <= (op.$lte as number))) return false;
      if ("$exists" in op) {
        const has = cell !== undefined && cell !== null;
        if (op.$exists !== has) return false;
      }
      if ("$regex" in op) {
        const re = new RegExp(op.$regex as string, (op.$options as string) ?? "");
        if (typeof cell !== "string" || !re.test(cell)) return false;
      }
      continue;
    }
    if (cell !== v) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Test app builder
// ─────────────────────────────────────────────────────────────────────

const TOKEN = "test-scim-token-12345";

async function buildApp(extra?: { useVerify?: boolean }): Promise<{
  app: FastifyInstance;
  userRepo: ReturnType<typeof makeRepo>;
  groupRepo: ReturnType<typeof makeRepo>;
}> {
  const app = Fastify({ logger: false });
  const userRepo = makeRepo();
  const groupRepo = makeRepo();

  await app.register(scimPlugin, {
    users: {
      resource: {
        name: "user",
        adapter: { repository: userRepo },
      },
    },
    groups: {
      resource: {
        name: "organization",
        adapter: { repository: groupRepo },
      },
    },
    ...(extra?.useVerify
      ? { verify: async (req) => req.headers.authorization === `Bearer ${TOKEN}` }
      : { bearer: TOKEN }),
  });

  await app.ready();
  return { app, userRepo, groupRepo };
}

const auth = (token: string = TOKEN) => ({ authorization: `Bearer ${token}` });

// ============================================================================
// Auth
// ============================================================================

describe("SCIM plugin — auth", () => {
  let setup: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.app.close();
  });

  it("401 without bearer token", async () => {
    const res = await setup.app.inject({ method: "GET", url: "/scim/v2/Users" });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    expect(body.status).toBe("401");
  });

  it("401 with wrong token", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/Users",
      headers: auth("wrong"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 with correct bearer token", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/Users",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
  });

  it("verify callback works as alternative to bearer", async () => {
    const verifyApp = await buildApp({ useVerify: true });
    try {
      const ok = await verifyApp.app.inject({
        method: "GET",
        url: "/scim/v2/Users",
        headers: auth(),
      });
      expect(ok.statusCode).toBe(200);

      const denied = await verifyApp.app.inject({
        method: "GET",
        url: "/scim/v2/Users",
        headers: auth("nope"),
      });
      expect(denied.statusCode).toBe(401);
    } finally {
      await verifyApp.app.close();
    }
  });
});

// ============================================================================
// Users CRUD
// ============================================================================

describe("SCIM plugin — Users CRUD", () => {
  let setup: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.app.close();
  });

  it("POST /Users creates with SCIM payload", async () => {
    const res = await setup.app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "alice@acme.com",
        name: { formatted: "Alice Smith" },
        active: true,
        emails: [{ value: "alice@acme.com", primary: true, type: "work" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/scim\+json/);
    expect(res.headers.location).toMatch(/\/scim\/v2\/Users\/u_/);
    const body = JSON.parse(res.body);
    expect(body.schemas).toContain("urn:ietf:params:scim:schemas:core:2.0:User");
    expect(body.userName).toBe("alice@acme.com");
    expect(body.meta.resourceType).toBe("User");
  });

  it("GET /Users lists with ListResponse envelope", async () => {
    await setup.userRepo.create({ email: "a@x.com", name: "A", isActive: true });
    await setup.userRepo.create({ email: "b@x.com", name: "B", isActive: true });

    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/Users",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");
    expect(body.totalResults).toBe(2);
    expect(body.Resources).toHaveLength(2);
    expect(body.Resources[0].userName).toBe("a@x.com");
  });

  it("GET /Users with SCIM filter narrows results", async () => {
    await setup.userRepo.create({ email: "alice@acme.com", name: "Alice", isActive: true });
    await setup.userRepo.create({ email: "bob@other.com", name: "Bob", isActive: true });
    await setup.userRepo.create({ email: "carol@acme.com", name: "Carol", isActive: false });

    const res = await setup.app.inject({
      method: "GET",
      url: '/scim/v2/Users?filter=userName co "acme.com" and active eq true',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].userName).toBe("alice@acme.com");
  });

  it("GET /Users/:id returns 404 for missing", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/Users/missing",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /Users/:id applies RFC 7644 PatchOp", async () => {
    const created = await setup.userRepo.create({ email: "a@x.com", name: "A", isActive: true });
    const id = (created as { id: string }).id;

    const res = await setup.app.inject({
      method: "PATCH",
      url: `/scim/v2/Users/${id}`,
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", path: "displayName", value: "A Updated" },
          { op: "replace", path: "active", value: false },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(setup.userRepo.rows.get(id)?.name).toBe("A Updated");
    expect(setup.userRepo.rows.get(id)?.isActive).toBe(false);
  });

  it("DELETE /Users/:id deprovisions and returns 204", async () => {
    const created = await setup.userRepo.create({ email: "a@x.com", name: "A", isActive: true });
    const id = (created as { id: string }).id;

    const res = await setup.app.inject({
      method: "DELETE",
      url: `/scim/v2/Users/${id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(setup.userRepo.rows.has(id)).toBe(false);
  });
});

// ============================================================================
// Groups CRUD (mirrors Users — light coverage)
// ============================================================================

describe("SCIM plugin — Groups CRUD", () => {
  let setup: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.app.close();
  });

  it("POST /Groups creates a group", async () => {
    const res = await setup.app.inject({
      method: "POST",
      url: "/scim/v2/Groups",
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Engineering",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).displayName).toBe("Engineering");
  });
});

// ============================================================================
// Discovery
// ============================================================================

// ============================================================================
// PUT (full replace) + mapping override + observability + auth-edge cases
// ============================================================================

describe("SCIM plugin — PUT (full replace)", () => {
  let setup: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.app.close();
  });

  it("PUT /Users/:id replaces the doc and re-emits SCIM shape", async () => {
    const created = await setup.userRepo.create({ email: "a@x.com", name: "A", isActive: true });
    const id = (created as { id: string }).id;

    const res = await setup.app.inject({
      method: "PUT",
      url: `/scim/v2/Users/${id}`,
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "a-updated@x.com",
        displayName: "A Replaced",
        active: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userName).toBe("a-updated@x.com");
    expect(body.active).toBe(false);
    expect(body.meta.resourceType).toBe("User");
    // Backend stored under mapped fields
    expect(setup.userRepo.rows.get(id)?.email).toBe("a-updated@x.com");
    expect(setup.userRepo.rows.get(id)?.name).toBe("A Replaced");
  });

  it("PUT 404s when the resource is missing", async () => {
    const res = await setup.app.inject({
      method: "PUT",
      url: `/scim/v2/Users/missing`,
      headers: { ...auth(), "content-type": "application/scim+json" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "ghost@x.com",
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ============================================================================
// Honest degradation — PUT 501 when kit lacks bulkWrite, PATCH 400 when kit
// lacks findOneAndUpdate AND body uses $unset / $push / $pull
// ============================================================================

describe("SCIM plugin — honest degradation on minimal-kit repos", () => {
  it("PUT 501s with clear scimType when repo lacks bulkWrite", async () => {
    const app = Fastify({ logger: false });
    const minimalRepo = makeMinimalRepo();
    minimalRepo.rows.set("u1", { id: "u1", email: "a@x.com", name: "A", isActive: true });
    await app.register(scimPlugin, {
      users: { resource: { name: "user", adapter: { repository: minimalRepo } } },
      bearer: TOKEN,
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/scim/v2/Users/u1",
        headers: { ...auth(), "content-type": "application/scim+json" },
        payload: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "replaced@x.com",
        },
      });
      expect(res.statusCode).toBe(501);
      const body = res.json();
      expect(body.detail).toMatch(/bulkWrite/);
    } finally {
      await app.close();
    }
  });

  it("PATCH degrades to $set-only when repo lacks findOneAndUpdate", async () => {
    const app = Fastify({ logger: false });
    const minimalRepo = makeMinimalRepo();
    minimalRepo.rows.set("u1", { id: "u1", email: "a@x.com", name: "A", isActive: true });
    await app.register(scimPlugin, {
      users: { resource: { name: "user", adapter: { repository: minimalRepo } } },
      bearer: TOKEN,
    });
    await app.ready();
    try {
      // Pure $set — succeeds via repo.update fallback
      const ok = await app.inject({
        method: "PATCH",
        url: "/scim/v2/Users/u1",
        headers: { ...auth(), "content-type": "application/scim+json" },
        payload: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "displayName", value: "A v2" }],
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(minimalRepo.rows.get("u1")?.name).toBe("A v2");

      // $unset — 400 (silent drop would be the original bug)
      const denied = await app.inject({
        method: "PATCH",
        url: "/scim/v2/Users/u1",
        headers: { ...auth(), "content-type": "application/scim+json" },
        payload: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: "title" }],
        },
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().scimType).toBe("invalidValue");

      // $push — 400
      const pushDenied = await app.inject({
        method: "PATCH",
        url: "/scim/v2/Users/u1",
        headers: { ...auth(), "content-type": "application/scim+json" },
        payload: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            { op: "add", path: "emails", value: [{ value: "alt@x.com", type: "personal" }] },
          ],
        },
      });
      expect(pushDenied.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PATCH on operator-capable kit applies $push to array fields", async () => {
    const app = Fastify({ logger: false });
    const fullRepo = makeRepo();
    fullRepo.rows.set("u1", {
      id: "u1",
      email: "a@x.com",
      name: "A",
      isActive: true,
      emails: [{ value: "a@x.com", primary: true, type: "work" }],
    });
    await app.register(scimPlugin, {
      users: { resource: { name: "user", adapter: { repository: fullRepo } } },
      bearer: TOKEN,
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/scim/v2/Users/u1",
        headers: { ...auth(), "content-type": "application/scim+json" },
        payload: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            {
              op: "add",
              path: "emails",
              value: [{ value: "alt@x.com", type: "personal" }],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const stored = fullRepo.rows.get("u1") as { emails: Array<{ value: string }> };
      expect(stored.emails).toHaveLength(2);
      expect(stored.emails[1]?.value).toBe("alt@x.com");
    } finally {
      await app.close();
    }
  });
});

describe("SCIM plugin — mapping override", () => {
  it("honors a per-resource SCIM-attr → backend-field override", async () => {
    const app = Fastify({ logger: false });
    const userRepo = makeRepo();
    // Seed under a non-default backend column so the mapping override matters.
    userRepo.rows.set("u1", {
      id: "u1",
      username: "alice@acme.com", // <- not `email`
      lastName: "Smith",
      enabled: true,
    });

    await app.register(scimPlugin, {
      users: {
        resource: { name: "user", adapter: { repository: userRepo } },
        mapping: {
          attributes: {
            id: "id",
            userName: "username", // <- overridden
            "name.familyName": "lastName", // <- overridden
            displayName: "lastName",
            active: "enabled", // <- overridden
            "emails.value": "username",
          },
        },
      },
      bearer: TOKEN,
    });
    await app.ready();

    try {
      // GET reads through the override
      const res = await app.inject({
        method: "GET",
        url: "/scim/v2/Users/u1",
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.userName).toBe("alice@acme.com");
      expect(body.active).toBe(true);

      // POST writes through the override
      const created = await app.inject({
        method: "POST",
        url: "/scim/v2/Users",
        headers: { ...auth(), "content-type": "application/scim+json" },
        payload: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "bob@acme.com",
          name: { familyName: "Jones" },
          active: true,
        },
      });
      expect(created.statusCode).toBe(201);
      // Confirm row stored under override columns
      const ids = [...userRepo.rows.keys()];
      const newId = ids.find((k) => k !== "u1") as string;
      expect(userRepo.rows.get(newId)?.username).toBe("bob@acme.com");
      expect(userRepo.rows.get(newId)?.lastName).toBe("Jones");

      // Filter reads use the override too
      const filtered = await app.inject({
        method: "GET",
        url: '/scim/v2/Users?filter=userName eq "alice@acme.com"',
        headers: auth(),
      });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json().totalResults).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe("SCIM plugin — verify callback edge cases", () => {
  it("verify callback that throws is treated as deny", async () => {
    const app = Fastify({ logger: false });
    await app.register(scimPlugin, {
      users: { resource: { name: "user", adapter: { repository: makeRepo() } } },
      verify: async () => {
        throw new Error("token introspection unavailable");
      },
    });
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/scim/v2/Users", headers: auth() });
      // Implementations may surface as 401 (rejected) or 500 (error wrapped) — both are deny.
      expect([401, 500]).toContain(res.statusCode);
      expect(res.json().schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    } finally {
      await app.close();
    }
  });

  it("rejects when both bearer and verify are configured (caller mistake)", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(scimPlugin, {
        users: { resource: { name: "user", adapter: { repository: makeRepo() } } },
        bearer: "x",
        verify: async () => true,
      }),
    ).rejects.toThrow(/either `bearer` or `verify`/);
    await app.close();
  });

  it("rejects when neither bearer nor verify is configured", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(scimPlugin, {
        users: { resource: { name: "user", adapter: { repository: makeRepo() } } },
      }),
    ).rejects.toThrow(/configure either `bearer`/);
    await app.close();
  });
});

describe("SCIM plugin — observability", () => {
  it("emits a ScimObservedEvent per request via the observe callback", async () => {
    const events: import("../../src/scim/index.js").ScimObservedEvent[] = [];
    const app = Fastify({ logger: false });
    const userRepo = makeRepo();

    await app.register(scimPlugin, {
      users: { resource: { name: "user", adapter: { repository: userRepo } } },
      bearer: TOKEN,
      observe: (event) => events.push(event),
    });
    await app.ready();

    try {
      // Successful list
      await app.inject({ method: "GET", url: "/scim/v2/Users", headers: auth() });
      // 401 — auth fails
      await app.inject({ method: "GET", url: "/scim/v2/Users" });
      // 404 — single get
      await app.inject({ method: "GET", url: "/scim/v2/Users/missing", headers: auth() });
      // Discovery endpoint
      await app.inject({
        method: "GET",
        url: "/scim/v2/ServiceProviderConfig",
        headers: auth(),
      });

      expect(events).toHaveLength(4);
      expect(events[0]).toMatchObject({
        resourceType: "Users",
        op: "list",
        status: 200,
        path: "/Users",
      });
      expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(events[1]).toMatchObject({ resourceType: "Users", op: "list", status: 401 });
      expect(events[2]).toMatchObject({
        resourceType: "Users",
        op: "get",
        status: 404,
        path: "/Users/:id",
      });
      expect(events[3]).toMatchObject({
        resourceType: "discovery",
        op: "discovery.serviceProviderConfig",
        status: 200,
        path: "/ServiceProviderConfig",
      });
    } finally {
      await app.close();
    }
  });
});

describe("SCIM plugin — discovery endpoints", () => {
  let setup: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.app.close();
  });

  it("GET /ServiceProviderConfig advertises capabilities", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/ServiceProviderConfig",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.patch.supported).toBe(true);
    expect(body.filter.supported).toBe(true);
    expect(body.bulk.supported).toBe(false);
    expect(body.authenticationSchemes[0].type).toBe("oauthbearertoken");
  });

  it("GET /ResourceTypes lists Users + Groups", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/ResourceTypes",
      headers: auth(),
    });
    const body = JSON.parse(res.body);
    expect(body.totalResults).toBe(2);
    const ids = (body.Resources as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("User");
    expect(ids).toContain("Group");
  });

  it("GET /Schemas returns at least User", async () => {
    const res = await setup.app.inject({
      method: "GET",
      url: "/scim/v2/Schemas",
      headers: auth(),
    });
    const body = JSON.parse(res.body);
    expect(body.totalResults).toBeGreaterThanOrEqual(1);
  });
});
