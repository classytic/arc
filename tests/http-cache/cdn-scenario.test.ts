/**
 * httpCachePlugin behind the shipped CDN simulator (`@classytic/arc/http-cache/testing`): the acceptance
 * list for purge-on-write edge caching. Writes publish domain events; `purgeOn` turns them into tags.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { httpCachePlugin } from "../../src/http-cache/index.js";
import {
  createFakeCdn,
  expectCacheable,
  expectHit,
  expectPrivate,
  expectPurged,
  type FakeCdn,
} from "../../src/http-cache/testing/index.js";

const SITE = "https://academy.example.com";
type Course = { id: string; title: string; lessons: string[] };

let app: FastifyInstance;
let cdn: FakeCdn;
let courses: Map<string, Course>;
let failing = false;

async function build(
  options: { bypass?: (h: Record<string, string>) => boolean; softPurge?: boolean } = {},
) {
  courses = new Map([
    ["c1", { id: "c1", title: "Algebra", lessons: ["Intro"] }],
    ["c2", { id: "c2", title: "Physics", lessons: ["Motion"] }],
  ]);
  failing = false;
  cdn = createFakeCdn(() => app, {
    ...(options.bypass ? { bypass: options.bypass } : {}),
    softPurge: options.softPurge !== false,
  });
  app = Fastify({ logger: false });
  await app.register(eventPlugin);
  await app.register(httpCachePlugin, {
    purger: cdn.purger,
    cors: { origin: SITE },
    batchWindowMs: 60_000,
    purgeOn: {
      "course.updated": (e) => ({
        tags: [`course:${(e.payload as { id: string }).id}`, "catalog"],
        mode: "soft",
      }),
    },
  });
  app.get(
    "/courses",
    { config: { httpCache: { cdn: 600, browser: 60, tags: ["catalog"] } } },
    async (request) => ({
      data: [...courses.values()].map((c) => c.title),
      shelf: request.headers["x-organization-id"]
        ? `org:${request.headers["x-organization-id"]}`
        : "public",
    }),
  );
  app.get(
    "/courses/:id/outline",
    {
      config: {
        httpCache: {
          cdn: 600,
          browser: 60,
          staleIfError: 3600,
          tags: (req) => [`course:${(req.params as { id: string }).id}`],
        },
      },
    },
    async (request, reply) => {
      if (failing) return reply.code(503).send({ error: "down" });
      const course = courses.get((request.params as { id: string }).id);
      if (!course) return reply.code(404).send({ error: "not found" });
      return course;
    },
  );
  app.patch("/courses/:id", async (request) => {
    const course = courses.get((request.params as { id: string }).id)!;
    Object.assign(course, request.body as Partial<Course>);
    await app.events.publish("course.updated", { id: course.id });
    return course;
  });
  app.get("/session", { config: { httpCache: { cdn: 600 } } }, async (_req, reply) => {
    reply.header("set-cookie", "sid=abc; HttpOnly");
    return { welcome: true };
  });
  await app.ready();
}

beforeEach(async () => build());
afterEach(async () => {
  await app?.close();
});

const edit = async (id: string, body: Partial<Course>) => {
  await cdn.request({ method: "PATCH", url: `/courses/${id}`, payload: body });
  await app.httpCache.flush();
};

describe("behind a CDN", () => {
  it("serves a repeat anonymous read from the edge without reaching the origin", async () => {
    const first = await cdn.request({ url: "/courses/c1/outline" });
    expect(first.cacheStatus).toBe("MISS");
    expectCacheable({ headers: first.headers });
    const before = cdn.stats.originRequests;
    const second = await cdn.request({ url: "/courses/c1/outline" });
    expectHit(second);
    expect(cdn.stats.originRequests).toBe(before);
    expect(second.headers["cache-tag"]).toBeUndefined();
  });

  it("uses CDN-Cache-Control for the edge TTL while the browser gets the short one", async () => {
    const res = await cdn.request({ url: "/courses/c1/outline" });
    expect(res.headers["cache-control"]).toContain("max-age=60");
    expect(res.headers["cdn-cache-control"]).toContain("max-age=600");
    cdn.advance(120_000);
    expectHit(await cdn.request({ url: "/courses/c1/outline" }));
  });

  it("after an edit, a soft-purged outline is served stale once while refreshing, then fresh", async () => {
    await cdn.request({ url: "/courses/c1/outline" });
    await cdn.request({ url: "/courses/c2/outline" });
    await edit("c1", { lessons: ["Intro", "Equations"] });
    expectPurged(cdn, ["course:c1", "catalog"]);
    const stale = await cdn.request({ url: "/courses/c1/outline" });
    expect(stale.cacheStatus).toBe("STALE");
    const fresh = await cdn.request({ url: "/courses/c1/outline" });
    expectHit(fresh);
    expect(fresh.json<Course>().lessons).toEqual(["Intro", "Equations"]);
    expectHit(await cdn.request({ url: "/courses/c2/outline" }));
  });

  it("with a CDN that cannot soft purge, the next read after an edit is a MISS with new content", async () => {
    await app.close();
    await build({ softPurge: false });
    await cdn.request({ url: "/courses/c1/outline" });
    await edit("c1", { title: "Algebra II" });
    const after = await cdn.request({ url: "/courses/c1/outline" });
    expect(after.cacheStatus).toBe("MISS");
    expect(after.json<Course>().title).toBe("Algebra II");
  });

  it("purges the catalog list through its shared tag", async () => {
    await cdn.request({ url: "/courses" });
    expectHit(await cdn.request({ url: "/courses" }));
    await edit("c2", { title: "Mechanics" });
    await cdn.request({ url: "/courses" });
    const list = await cdn.request({ url: "/courses" });
    expect(list.json<{ data: string[] }>().data).toContain("Mechanics");
  });

  it("never serves a signed-in request from the edge", async () => {
    await cdn.request({ url: "/courses/c1/outline" });
    const res = await cdn.request({
      url: "/courses/c1/outline",
      headers: { authorization: "Bearer t" },
    });
    expect(res.cacheStatus).toBe("BYPASS");
    expectPrivate({ headers: res.headers });
  });

  it("never lets a personalised reply fill the edge, even when the CDN rule forgets the org header", async () => {
    const personal = await cdn.request({
      url: "/courses",
      headers: { "x-organization-id": "org-9" },
    });
    expect(personal.json<{ shelf: string }>().shelf).toBe("org:org-9");
    expect(cdn.size()).toBe(0);
    const anon = await cdn.request({ url: "/courses" });
    expect(anon.json<{ shelf: string }>().shelf).toBe("public");
  });

  it("shows why the CDN rule must bypass every private signal: otherwise an org request gets the public copy", async () => {
    await cdn.request({ url: "/courses" });
    const leaky = await cdn.request({ url: "/courses", headers: { "x-organization-id": "org-9" } });
    expect(leaky.json<{ shelf: string }>().shelf).toBe("public");
    await app.close();
    await build({
      bypass: (h) =>
        h.authorization !== undefined ||
        h["x-organization-id"] !== undefined ||
        h.cookie !== undefined,
    });
    await cdn.request({ url: "/courses" });
    const safe = await cdn.request({ url: "/courses", headers: { "x-organization-id": "org-9" } });
    expect(safe.cacheStatus).toBe("BYPASS");
    expect(safe.json<{ shelf: string }>().shelf).toBe("org:org-9");
  });

  it("passes CORS for a browser after a server-side fill without an Origin", async () => {
    await cdn.request({ url: "/courses/c1/outline" });
    const browser = await cdn.request({ url: "/courses/c1/outline", headers: { origin: SITE } });
    expectHit(browser);
    expect(browser.headers["access-control-allow-origin"]).toBe(SITE);
  });

  it("keeps serving the last good copy while the origin errors (stale-if-error)", async () => {
    await cdn.request({ url: "/courses/c1/outline" });
    cdn.advance(601_000);
    failing = true;
    const res = await cdn.request({ url: "/courses/c1/outline" });
    expect(res.cacheStatus).toBe("STALE");
    expect(res.status).toBe(200);
    expect(res.json<Course>().title).toBe("Algebra");
  });

  it("stores neither a cookie-setting reply nor a 404", async () => {
    expect((await cdn.request({ url: "/session" })).cacheStatus).toBe("BYPASS");
    expect((await cdn.request({ url: "/courses/zz/outline" })).cacheStatus).toBe("DYNAMIC");
    expect(cdn.size()).toBe(0);
  });

  it("expires at the CDN TTL when no purge arrives", async () => {
    await cdn.request({ url: "/courses/c1/outline" });
    cdn.advance(599_000);
    expectHit(await cdn.request({ url: "/courses/c1/outline" }));
    cdn.advance(2_000);
    expect((await cdn.request({ url: "/courses/c1/outline" })).cacheStatus).toBe("EXPIRED");
  });

  it("turns a 50-edit bulk push into one purge", async () => {
    for (let i = 0; i < 50; i++)
      await app.events.publish("course.updated", { id: i % 2 ? "c1" : "c2" });
    expect(cdn.stats.purges).toEqual([]);
    await app.httpCache.flush();
    expect(cdn.stats.purges).toHaveLength(1);
    expect([...cdn.stats.purges[0]!.tags].sort()).toEqual(["catalog", "course:c1", "course:c2"]);
  });
});
