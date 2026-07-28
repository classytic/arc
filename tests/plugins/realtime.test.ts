/**
 * Realtime Plugin — permission-aware resource change feed (2.22)
 *
 * End-to-end through createApp + real HTTP (SSE bypasses inject()).
 * Contracts pinned:
 *
 *   1. The feed is gated by the resource's OWN list permission — public
 *      resources stream to anonymous callers, protected ones 401 without
 *      a token, and the caller's row filters apply PER EVENT in process
 *      (the anti-Puter property: no unfiltered fan-out, no client N+1).
 *   2. Field-level read permissions mask every payload.
 *   3. Tenant guard: org-carrying events never reach an org-less or
 *      different-org subscriber.
 *   4. Fail-closed: operator-shaped filters without an adapter
 *      `matchesFilter` REJECT the subscription (501 + fix hint); with the
 *      matcher supplied they stream correctly.
 *   5. Unknown resources 404; changes are triggered by real REST writes
 *      (the arcCore CRUD event bridge), not synthetic publishes.
 */

import http from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, fields, requireOwnership } from "../../src/permissions/index.js";
import {
  buildChangeFrame,
  connectionDeadlineMs,
  type DeliveryPolicy,
  resolveDelivery,
  resolveRowMatcher,
} from "../../src/plugins/realtime.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

// ── SSE client helper (same technique as sse.test.ts) ─────────────────────

function openFeed(url: string, collectMs = 450) {
  let resolveHeaders: (v: { statusCode: number }) => void;
  const headersArrived = new Promise<{ statusCode: number }>((r) => {
    resolveHeaders = r;
  });
  const done = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.get(url, (res) => {
      resolveHeaders({ statusCode: res.statusCode ?? 0 });
      let body = "";
      const finish = () => resolve({ statusCode: res.statusCode ?? 0, body });
      const timer = setTimeout(() => {
        res.destroy();
        finish();
      }, collectMs);
      res.on("data", (c) => {
        body += c.toString();
      });
      res.on("end", () => {
        clearTimeout(timer);
        finish();
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNRESET" || err.message === "aborted") finish();
        else reject(err);
      });
    });
    req.on("error", reject);
  });
  return { headersArrived, done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Stub adapters ──────────────────────────────────────────────────────────

function stubAdapter(extra: Record<string, unknown> = {}) {
  let seq = 0;
  return {
    repository: {
      create: async (data: Record<string, unknown>) => ({ _id: `doc-${++seq}`, ...data }),
      getAll: async () => ({ data: [] }),
      getById: async () => null,
    },
    ...extra,
  };
}

// ── Pure policy units (no HTTP) ────────────────────────────────────────────

function makeEvent(payload: unknown, meta: Record<string, unknown> = {}): DomainEvent<unknown> {
  return { type: "doc.created", payload, meta } as DomainEvent<unknown>;
}

describe("resolveRowMatcher — enforcement decision", () => {
  it("no filters → enforceable with nothing to match", () => {
    expect(resolveRowMatcher(undefined, undefined)).toEqual({ enforceable: true });
    expect(resolveRowMatcher({}, undefined)).toEqual({ enforceable: true });
  });

  it("flat-equality filters → simpleEqualityMatcher", () => {
    const r = resolveRowMatcher({ ownerId: "u1" }, undefined);
    expect(r.enforceable).toBe(true);
    expect(r.enforceable && typeof r.matcher).toBe("function");
  });

  it("operator filters without adapter matcher → NOT enforceable (fail-closed)", () => {
    expect(resolveRowMatcher({ $or: [{ a: 1 }] }, undefined)).toEqual({ enforceable: false });
    expect(resolveRowMatcher({ _id: { $in: ["x"] } }, undefined)).toEqual({ enforceable: false });
  });

  it("adapter matcher wins for any filter shape", () => {
    const matchesFilter = () => true;
    const r = resolveRowMatcher({ $or: [] }, { matchesFilter });
    expect(r.enforceable).toBe(true);
  });

  it("probes the filter at CONNECT: an adapter matcher that throws on the shape → NOT enforceable (no per-event crash)", () => {
    // A custom permission returning an operator the kit matcher can't
    // enforce (e.g. $elemMatch) throws at conversion time. The connect
    // probe must turn that into a clean rejection (→ 501), never a
    // per-event throw that would crash the subscriber's stream.
    const matchesFilter = (_item: unknown, filters: Record<string, unknown>) => {
      if ("$elemMatch" in filters || Object.values(filters).some((v) => isUnsupported(v))) {
        throw new Error("unsupported operator");
      }
      return true;
    };
    const isUnsupported = (v: unknown) =>
      !!v && typeof v === "object" && "$elemMatch" in (v as object);
    expect(resolveRowMatcher({ tags: { $elemMatch: { x: 1 } } }, { matchesFilter })).toEqual({
      enforceable: false,
    });
    // A supported shape still probes clean → enforceable.
    expect(resolveRowMatcher({ ownerId: "u1" }, { matchesFilter }).enforceable).toBe(true);
  });
});

describe("resolveDelivery — the per-event authorization decision", () => {
  const openPolicy: DeliveryPolicy = {
    tenantScoped: true,
    subscriberOrgId: undefined,
    filters: undefined,
    matcher: undefined,
  };

  it("tenant guard: cross-org events DROP (never a leave — never was visible)", () => {
    const event = makeEvent({ data: { a: 1 } }, { organizationId: "org-1" });
    // Even for an update, a cross-org record was never visible → drop, not leave.
    expect(resolveDelivery(event, openPolicy, "updated")).toEqual({ kind: "drop" });
    expect(resolveDelivery(event, { ...openPolicy, subscriberOrgId: "org-2" }, "updated")).toEqual({
      kind: "drop",
    });
    expect(resolveDelivery(event, { ...openPolicy, subscriberOrgId: "org-1" }, "created")).toEqual({
      kind: "deliver",
      doc: { a: 1 },
    });
  });

  it("tenantScoped: false disables the org guard (tenantField: false resources)", () => {
    const event = makeEvent({ data: { a: 1 } }, { organizationId: "org-1" });
    expect(resolveDelivery(event, { ...openPolicy, tenantScoped: false }, "created").kind).toBe(
      "deliver",
    );
  });

  it("filters: matching events deliver; non-matching CREATE/DELETE drop (never entered the view)", () => {
    const policy: DeliveryPolicy = {
      ...openPolicy,
      filters: { ownerId: "u1" },
      matcher: (item, f) => (item as { ownerId?: string }).ownerId === f.ownerId,
    };
    expect(resolveDelivery(makeEvent({ data: { ownerId: "u1" } }), policy, "created").kind).toBe(
      "deliver",
    );
    expect(resolveDelivery(makeEvent({ data: { ownerId: "u2" } }), policy, "created").kind).toBe(
      "drop",
    );
    expect(resolveDelivery(makeEvent({ noData: true }), policy, "deleted").kind).toBe("drop");
  });

  it("LEAVE transition: an UPDATE that no longer matches → { kind: 'leave' } (the stale-row fix)", () => {
    const policy: DeliveryPolicy = {
      ...openPolicy,
      filters: { ownerId: "u1" },
      matcher: (item, f) => (item as { ownerId?: string }).ownerId === f.ownerId,
    };
    // ownerId reassigned away → the subscriber's UI must drop the row.
    expect(resolveDelivery(makeEvent({ data: { ownerId: "u2" } }), policy, "updated")).toEqual({
      kind: "leave",
    });
    // still matching → normal delivery, not a leave.
    expect(resolveDelivery(makeEvent({ data: { ownerId: "u1" } }), policy, "updated").kind).toBe(
      "deliver",
    );
  });

  it("without filters, document-less events still deliver (frame carries no data)", () => {
    expect(resolveDelivery(makeEvent({ noData: true }), openPolicy, "created")).toEqual({
      kind: "deliver",
      doc: undefined,
    });
  });
});

describe("connectionDeadlineMs — permission-staleness bound", () => {
  const now = 1_000_000_000_000; // fixed clock

  it("no exp + no cap → undefined (feed lives until disconnect)", () => {
    expect(connectionDeadlineMs({ id: "u1" }, undefined, now)).toBeUndefined();
    expect(connectionDeadlineMs(null, undefined, now)).toBeUndefined();
  });

  it("token exp → ms until expiry", () => {
    const exp = now / 1000 + 3600; // 1h out (exp is seconds)
    expect(connectionDeadlineMs({ exp }, undefined, now)).toBe(3_600_000);
  });

  it("already-expired token → 0 (close immediately)", () => {
    expect(connectionDeadlineMs({ exp: now / 1000 - 60 }, undefined, now)).toBe(0);
  });

  it("maxConnectionMs caps below the token exp", () => {
    const exp = now / 1000 + 3600;
    expect(connectionDeadlineMs({ exp }, 60_000, now)).toBe(60_000);
    // and applies with no exp at all (session/cookie auth)
    expect(connectionDeadlineMs({ id: "u1" }, 60_000, now)).toBe(60_000);
  });

  it("clamps to Node's setTimeout ceiling for far-future expiry", () => {
    const exp = now / 1000 + 60 * 24 * 3600; // 60 days
    expect(connectionDeadlineMs({ exp }, undefined, now)).toBe(2_147_483_647);
  });
});

describe("buildChangeFrame — wire envelope", () => {
  it("is document-change-shaped: type/resource/id/data/meta", () => {
    const frame = JSON.parse(
      buildChangeFrame(
        makeEvent({ data: { a: 1 } }, { resourceId: "d1", timestamp: "t", correlationId: "c" }),
        "doc",
        { a: 1 },
      ),
    );
    expect(frame).toEqual({
      type: "doc.created",
      resource: "doc",
      id: "d1",
      data: { a: 1 },
      meta: { timestamp: "t", correlationId: "c" },
    });
  });
});

describe("Realtime Plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function boot(resources: unknown[], realtime: Record<string, unknown> | true = true) {
    app = await createApp({
      logger: false,
      preset: "testing",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      arcPlugins: { realtime } as never,
      resources: resources as never,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  function token(id: string) {
    return (
      app as unknown as {
        auth: { issueTokens: (p: Record<string, unknown>) => { accessToken: string } };
      }
    ).auth.issueTokens({ id }).accessToken;
  }

  it("maxConnectionMs force-closes the feed server-side (bounds permission staleness)", async () => {
    const base = await boot(
      [
        defineResource({
          name: "note",
          adapter: stubAdapter() as never,
          permissions: { list: allowPublic() },
        }),
      ],
      { maxConnectionMs: 150 },
    );

    const start = Date.now();
    let endedAt = 0;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${base}/realtime/note`, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          endedAt = Date.now() - start;
          resolve();
        });
        res.on("error", () => resolve());
      });
      req.on("error", reject);
      // Safety: if the server never closes, fail via timeout.
      setTimeout(() => resolve(), 2000);
    });
    // Server closed the stream at ~150ms, well before the 2s safety timeout.
    expect(endedAt).toBeGreaterThan(0);
    expect(endedAt).toBeLessThan(1000);
  });

  it("streams created events on a public resource to anonymous subscribers", async () => {
    const base = await boot([
      defineResource({
        name: "note",
        adapter: stubAdapter() as never,
        permissions: { list: allowPublic(), create: allowPublic() },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/note`);
    await feed.headersArrived;
    await sleep(60); // subscription live after the ready frame

    const created = await app.inject({
      method: "POST",
      url: "/notes",
      payload: { title: "hello" },
    });
    expect(created.statusCode).toBe(201);

    const { statusCode, body } = await feed.done;
    expect(statusCode).toBe(200);
    expect(body).toContain("event: ready");
    expect(body).toContain("event: note.created");
    expect(body).toContain('"title":"hello"');
    // SSE-standard fields: reconnection hint at connect, per-frame id
    // (clients get lastEventId dedup even without server replay).
    expect(body).toMatch(/^retry: \d+/);
    expect(body).toMatch(/\nid: .+\nevent: note\.created\n/);
  });

  it("401s a protected feed without a token; streams with ?token=", async () => {
    const base = await boot([
      defineResource({
        name: "task",
        adapter: stubAdapter() as never,
        permissions: { list: requireOwnership("ownerId"), create: allowPublic() },
      }),
    ]);

    const anon = openFeed(`${base}/realtime/task`, 200);
    expect((await anon.headersArrived).statusCode).toBe(401);
    await anon.done;

    const authed = openFeed(`${base}/realtime/task?token=${token("u1")}`, 200);
    expect((await authed.headersArrived).statusCode).toBe(200);
    await authed.done;
  });

  it("applies the subscriber's row filters PER EVENT (owner sees own changes only)", async () => {
    const base = await boot([
      defineResource({
        name: "task",
        adapter: stubAdapter() as never,
        permissions: { list: requireOwnership("ownerId"), create: allowPublic() },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/task?token=${token("u1")}`);
    await feed.headersArrived;
    await sleep(60);

    await app.inject({ method: "POST", url: "/tasks", payload: { name: "mine", ownerId: "u1" } });
    await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { name: "theirs", ownerId: "u2" },
    });

    const { body } = await feed.done;
    expect(body).toContain('"name":"mine"');
    expect(body).not.toContain('"name":"theirs"');
  });

  it("emits a synthetic `.left` when an UPDATE moves a record out of the subscriber's filter (stale-row fix)", async () => {
    const base = await boot([
      defineResource({
        name: "task",
        adapter: stubAdapter() as never,
        permissions: { list: requireOwnership("ownerId"), create: allowPublic() },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/task?token=${token("u1")}`);
    await feed.headersArrived;
    await sleep(60);

    const events = (
      app as unknown as {
        events: { publish: (t: string, p: unknown, m?: Record<string, unknown>) => Promise<void> };
      }
    ).events;

    // u1's record is created + visible…
    await events.publish(
      "task.created",
      { data: { _id: "t1", name: "mine", ownerId: "u1" } },
      { resourceId: "t1" },
    );
    // …then reassigned to u2 — it leaves u1's filtered view.
    await events.publish(
      "task.updated",
      { data: { _id: "t1", name: "mine", ownerId: "u2" } },
      { resourceId: "t1" },
    );

    const { body } = await feed.done;
    expect(body).toContain("event: task.created"); // the enter
    expect(body).toContain("event: task.left"); // the leave (was: silently dropped)
    expect(body).toContain('"id":"t1"'); // leave frame carries the id to drop
  });

  it("masks field-level read permissions on every payload", async () => {
    // `visibleTo(['admin'])`: writable by anyone, READABLE only by admins —
    // the subscriber here is anonymous, so the field must never reach the
    // stream. (`hidden()` would also block the WRITE, so no event fires.)
    const base = await boot([
      defineResource({
        name: "employee",
        adapter: stubAdapter() as never,
        permissions: { list: allowPublic(), create: allowPublic() },
        fields: { salary: fields.visibleTo(["admin"]) },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/employee`);
    await feed.headersArrived;
    await sleep(60);

    const created = await app.inject({
      method: "POST",
      url: "/employees",
      payload: { name: "Ada", salary: 99177 },
    });
    expect(created.statusCode).toBe(201);

    const { body } = await feed.done;
    expect(body).toContain('"name":"Ada"');
    expect(body).not.toContain("99177");
  });

  it("tenant guard: org-carrying events never reach an org-less subscriber", async () => {
    const base = await boot([
      defineResource({
        name: "invoice",
        adapter: stubAdapter() as never,
        permissions: { list: allowPublic() },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/invoice`);
    await feed.headersArrived;
    await sleep(60);

    // Publish an org-scoped change directly (the meta shape the CRUD
    // bridge emits for member-scoped writes).
    await (
      app as unknown as {
        events: {
          publish: (t: string, p: unknown, m?: Record<string, unknown>) => Promise<void>;
        };
      }
    ).events.publish(
      "invoice.created",
      { data: { _id: "i1", amount: 5 } },
      { resourceId: "i1", organizationId: "org-1" },
    );

    const { body } = await feed.done;
    expect(body).toContain("event: ready");
    expect(body).not.toContain('"amount":5');
  });

  it("fail-closed: operator-shaped filters without adapter matchesFilter → 501 with fix hint", async () => {
    const base = await boot([
      defineResource({
        name: "grantdoc",
        adapter: stubAdapter() as never,
        permissions: {
          list: () => ({ effect: "allow", policy: { $or: [{ ownerId: "u1" }] } }),
        },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/grantdoc?token=${token("u1")}`, 200);
    expect((await feed.headersArrived).statusCode).toBe(501);
    const { body } = await feed.done;
    expect(body).toContain("arc.realtime.unfilterable");
    expect(body).toContain("matchesFilter");
  });

  it("operator filters WITH adapter matchesFilter stream correctly", async () => {
    const matchesFilter = (item: unknown, filters: Record<string, unknown>) => {
      const branches = (filters.$or ?? []) as Record<string, unknown>[];
      return branches.some((b) =>
        Object.entries(b).every(([k, v]) => (item as Record<string, unknown>)[k] === v),
      );
    };
    const base = await boot([
      defineResource({
        name: "grantdoc",
        adapter: stubAdapter({ matchesFilter }) as never,
        permissions: {
          list: () => ({ effect: "allow", policy: { $or: [{ ownerId: "u1" }] } }),
          create: allowPublic(),
        },
      }),
    ]);

    const feed = openFeed(`${base}/realtime/grantdoc?token=${token("u1")}`);
    expect((await feed.headersArrived).statusCode).toBe(200);
    await sleep(60);

    await app.inject({
      method: "POST",
      url: "/grantdocs",
      payload: { name: "visible", ownerId: "u1" },
    });
    await app.inject({
      method: "POST",
      url: "/grantdocs",
      payload: { name: "invisible", ownerId: "u9" },
    });

    const { body } = await feed.done;
    expect(body).toContain('"name":"visible"');
    expect(body).not.toContain('"name":"invisible"');
  });

  it("multiplex: ONE connection carries N feeds, each with ITS OWN filter snapshot", async () => {
    const base = await boot([
      defineResource({
        name: "note",
        adapter: stubAdapter() as never,
        permissions: { list: allowPublic(), create: allowPublic() },
      }),
      defineResource({
        name: "task",
        adapter: stubAdapter() as never,
        permissions: { list: requireOwnership("ownerId"), create: allowPublic() },
      }),
    ]);

    const feed = openFeed(`${base}/realtime?resources=note,task&token=${token("u1")}`, 600);
    expect((await feed.headersArrived).statusCode).toBe(200);
    await sleep(60);

    // note is UNfiltered (public); task is owner-filtered. If filter
    // snapshots leaked across resources on the shared connection, the
    // note event would be dropped by task's ownerId filter.
    await app.inject({ method: "POST", url: "/notes", payload: { title: "plain-note" } });
    await app.inject({ method: "POST", url: "/tasks", payload: { name: "mine", ownerId: "u1" } });
    await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { name: "theirs", ownerId: "u2" },
    });

    const { body } = await feed.done;
    expect(body).toContain('"resources":["note","task"]'); // ready frame
    expect(body).toContain('"title":"plain-note"'); // unfiltered resource delivered
    expect(body).toContain('"name":"mine"'); // own task delivered
    expect(body).not.toContain('"name":"theirs"'); // other's task filtered
  });

  it("multiplex: any denied resource rejects the whole subscription", async () => {
    const base = await boot([
      defineResource({
        name: "note",
        adapter: stubAdapter() as never,
        permissions: { list: allowPublic() },
      }),
      defineResource({
        name: "secret",
        adapter: stubAdapter() as never,
        permissions: { list: () => ({ effect: "deny", reason: "nope" }) },
      }),
    ]);

    const feed = openFeed(`${base}/realtime?resources=note,secret&token=${token("u1")}`, 150);
    const { statusCode } = await feed.headersArrived;
    expect([401, 403]).toContain(statusCode);
    await feed.done;
  });

  it("multiplex: caps the resource count and 404s unknown names", async () => {
    const base = await boot([
      defineResource({
        name: "note",
        adapter: stubAdapter() as never,
        permissions: { list: allowPublic() },
      }),
    ]);

    const tooMany = Array.from({ length: 21 }, (_, i) => `r${i}`).join(",");
    const capped = openFeed(`${base}/realtime?resources=${tooMany}`, 150);
    expect((await capped.headersArrived).statusCode).toBe(400);
    await capped.done;

    const unknown = openFeed(`${base}/realtime?resources=note,ghost`, 150);
    expect((await unknown.headersArrived).statusCode).toBe(404);
    await unknown.done;
  });

  it("404s unknown resources and resources outside the allowlist", async () => {
    const base = await boot(
      [
        defineResource({
          name: "note",
          adapter: stubAdapter() as never,
          permissions: { list: allowPublic() },
        }),
      ],
      { resources: ["somethingelse"] },
    );

    const unknown = openFeed(`${base}/realtime/nope`, 150);
    expect((await unknown.headersArrived).statusCode).toBe(404);
    await unknown.done;

    const excluded = openFeed(`${base}/realtime/note`, 150);
    expect((await excluded.headersArrived).statusCode).toBe(404);
    await excluded.done;
  });
});
