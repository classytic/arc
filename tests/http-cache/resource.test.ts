/**
 * `defineResource({ httpCache })` end to end: real Mongo, real arc CRUD, the CDN simulator in front.
 * No purge code is written: tags come from the resource name and id, purges from its CRUD events.
 */
import { methodRegistryPlugin, mongoOperationsPlugin, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { httpCachePlugin } from "../../src/http-cache/index.js";
import {
  createFakeCdn,
  expectHit,
  expectPurged,
  type FakeCdn,
} from "../../src/http-cache/testing/index.js";
import { allowPublic } from "../../src/permissions/index.js";

interface ICourse {
  _id?: string;
  title: string;
  org: string;
}
const CourseSchema = new Schema<ICourse>(
  { title: { type: String, required: true }, org: { type: String, required: true } },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let CourseModel: Model<ICourse>;
let app: FastifyInstance;
let cdn: FakeCdn;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  CourseModel =
    mongoose.models.HttpCacheCourse || mongoose.model<ICourse>("HttpCacheCourse", CourseSchema);
  const repo = new Repository<ICourse>(CourseModel, [
    methodRegistryPlugin(),
    mongoOperationsPlugin(),
  ]);
  const course = defineResource({
    name: "course",
    prefix: "/courses",
    adapter: createMongooseAdapter(CourseModel, repo),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    httpCache: {
      list: { cdn: 600, browser: 30 },
      get: { cdn: 3600, browser: 60, staleIfError: 86_400 },
      tags: { extra: (doc) => [`org:${(doc as ICourse).org}`] },
    },
  });
  cdn = createFakeCdn(() => app);
  app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    plugins: async (f) => {
      await f.register(httpCachePlugin, { purger: cdn.purger, batchWindowMs: 60_000 });
      await f.register(course.toPlugin());
    },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const create = async (title: string) => {
  const res = await cdn.request({ method: "POST", url: "/courses", payload: { title, org: "o1" } });
  const body = res.json<{ data?: { _id: string }; _id?: string }>();
  return String(body.data?._id ?? body._id);
};

describe("defineResource({ httpCache })", () => {
  it("tags a get with <resource>, <resource>:<id> and the document's extra tags, and a list with <resource>", async () => {
    const id = await create("Algebra");
    const item = await app.inject({ method: "GET", url: `/courses/${id}` });
    expect(item.statusCode, item.body).toBe(200);
    expect(item.headers["cache-tag"]).toBe(`course,course:${id},org:o1`);
    expect(item.headers["cdn-cache-control"]).toBe("max-age=3600, stale-if-error=86400");
    const list = await app.inject({ method: "GET", url: "/courses" });
    expect(list.headers["cache-tag"]).toBe("course");
    expect(list.headers["cache-control"]).toBe("public, max-age=30, s-maxage=600");
  });

  it("purges the item and its lists when it is updated, with no purge code written", async () => {
    const id = await create("Physics");
    await cdn.request({ url: `/courses/${id}` });
    await cdn.request({ url: "/courses" });
    expectHit(await cdn.request({ url: `/courses/${id}` }));

    const patch = await cdn.request({
      method: "PATCH",
      url: `/courses/${id}`,
      payload: { title: "Mechanics" },
    });
    expect(patch.status, patch.body).toBe(200);
    await app.httpCache.flush();
    expectPurged(cdn, ["course", `course:${id}`, "org:o1"]);

    await cdn.request({ url: `/courses/${id}` }); // stale-while-refreshing after a soft purge
    const fresh = await cdn.request({ url: `/courses/${id}` });
    expect(
      fresh.json<{ data?: ICourse } & ICourse>().data?.title ?? fresh.json<ICourse>().title,
    ).toBe("Mechanics");
  });

  it("purges hard on delete, so the deleted item is never served from the edge again", async () => {
    const id = await create("Chemistry");
    await cdn.request({ url: `/courses/${id}` });
    await cdn.request({ method: "DELETE", url: `/courses/${id}` });
    await app.httpCache.flush();
    const deletePurge = cdn.stats.purges.find(
      (p) => p.tags.includes(`course:${id}`) && p.mode === "hard",
    );
    expect(deletePurge).toBeDefined();
    const after = await cdn.request({ url: `/courses/${id}` });
    expect(after.status).toBe(404);
    expect(after.cacheStatus).not.toBe("HIT");
  });

  it("refuses an invalid resource policy at boot", async () => {
    const bad = defineResource({
      name: "badcourse",
      prefix: "/bad",
      adapter: createMongooseAdapter(CourseModel, new Repository<ICourse>(CourseModel)),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      httpCache: { list: { cdn: 0 } },
    });
    await expect(
      createApp({
        preset: "testing",
        auth: false,
        logger: false,
        plugins: async (f) => {
          await f.register(httpCachePlugin);
          await f.register(bad.toPlugin());
        },
      }).then((a) => a.ready()),
    ).rejects.toThrow("cdn must be a positive");
  });
});
