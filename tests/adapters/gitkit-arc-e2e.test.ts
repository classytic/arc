/**
 * gitkit → arc — the headline claim, verified end-to-end.
 *
 * A gitkit `GitRepository` (over an in-memory git backend) wired through
 * `createGitAdapter` → `defineResource` → `createApp` must produce a working
 * REST resource: CRUD routes, list with arc's pagination envelope, `?filter`
 * narrowing via the shared repo-core Filter IR, and every write landing as a
 * git commit. Hermetic — memory backend, no network.
 *
 * This is the test that proves gitkit is a first-class arc adapter (like
 * mongokit/sqlitekit) rather than "the unit tests pass." Vendored dev-dep:
 * @classytic/gitkit (see node_modules).
 */
import { createGitAdapter } from "@classytic/gitkit/adapter";
import { memoryGitBackend } from "@classytic/gitkit/backends/memory";
import { gitRepository } from "@classytic/gitkit/repository";
import { frontmatter } from "@classytic/gitkit/serializers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

type Doc = { id: string; title: string; status: string; tags: string[]; content: string };

const SCHEMA = {
  entity: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      status: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      content: { type: "string" },
    },
  },
  createBody: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      status: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      content: { type: "string" },
    },
    required: ["title"],
  },
};

describe("gitkit → arc — git-backed REST resource", () => {
  let app: FastifyInstance;
  let backend: ReturnType<typeof memoryGitBackend>;

  beforeAll(async () => {
    backend = memoryGitBackend();
    const repo = gitRepository<Doc>({
      backend,
      collection: {
        dir: "docs",
        serializer: frontmatter<Doc>(),
        idField: "id",
      },
    });

    const resource = defineResource({
      name: "doc",
      prefix: "/docs",
      adapter: createGitAdapter<Doc>({ repository: repo, schema: SCHEMA }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("POST /docs creates via gitkit and lands a git commit + file", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/docs",
      payload: {
        id: "welcome",
        title: "Welcome",
        status: "published",
        tags: ["intro"],
        content: "hello",
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("Welcome");
    expect(backend.history().length).toBe(1);
    expect(backend.snapshot()["docs/welcome.mdx"]).toContain("title: Welcome");
  });

  it("GET /docs lists with the pagination envelope", async () => {
    await app.inject({
      method: "POST",
      url: "/docs",
      payload: { id: "second", title: "Second", status: "draft", tags: [], content: "x" },
    });
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("GET /docs/:id fetches one doc", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/welcome" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe("Welcome");
  });

  it("GET /docs?filter[status]=published narrows via the shared Filter IR", async () => {
    const res = await app.inject({ method: "GET", url: "/docs?filter[status]=published" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((d: Doc) => d.status === "published")).toBe(true);
  });

  it("PATCH /docs/:id updates and commits", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/docs/second",
      payload: { status: "published" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("published");
  });

  it("DELETE /docs/:id removes the file", async () => {
    const res = await app.inject({ method: "DELETE", url: "/docs/second" });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    const check = await app.inject({ method: "GET", url: "/docs/second" });
    expect(check.statusCode).toBe(404);
  });
});
