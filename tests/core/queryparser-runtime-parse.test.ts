/**
 * QueryParser — runtime-parse verification.
 *
 * A downstream review surfaced ambiguity: "Arc detects getQuerySchema() for
 * OpenAPI; host must manually call parser.parse(req.query)." This test
 * locks in the opposite: a custom `queryParser` passed to
 * `defineResource({ queryParser })` IS actually called on every list
 * request by the built-in `BaseCrudController`. OpenAPI generation is
 * separate and orthogonal.
 *
 * The chain being verified:
 *   list request → BaseCrudController.list()
 *                → QueryResolver.resolve()
 *                → queryParser.parse(req.query)     ← proof point
 *                → repo.getAll(resolvedOptions)
 *
 * If any link breaks (e.g. arc's default parser takes over silently),
 * `parserCalls` stays empty and this test fails loudly.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { ParsedQueryOptions, QueryParserInterface } from "../../src/types/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

describe("queryParser — runtime parse", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });

  /**
   * Build a spy parser that records every .parse() call and returns a
   * minimal valid ParsedQueryOptions. The shape matches what arc's
   * QueryResolver expects — enough to complete the list pipeline.
   */
  function makeSpyParser(): {
    parser: QueryParserInterface;
    calls: Array<Record<string, unknown>>;
  } {
    const calls: Array<Record<string, unknown>> = [];
    const parser: QueryParserInterface = {
      parse: vi.fn((query: Record<string, unknown>) => {
        calls.push(query);
        return {
          page: 1,
          limit: 20,
          filters: {},
          select: undefined,
          sort: undefined,
          search: undefined,
          populate: undefined,
          after: undefined,
        } satisfies ParsedQueryOptions;
      }),
    };
    return { parser, calls };
  }

  function makeResource(name: string, prefix: string, parser: QueryParserInterface) {
    const Model = createMockModel(`QpRt${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    const repo = createMockRepository(Model);
    return {
      resource: defineResource({
        name,
        prefix,
        adapter: createMongooseAdapter({ model: Model, repository: repo }),
        controller: new BaseController(repo, { resourceName: name, tenantField: false }),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
        queryParser: parser,
      }),
      model: Model,
    };
  }

  const apps: FastifyInstance[] = [];
  async function newApp(resource: ReturnType<typeof defineResource>): Promise<FastifyInstance> {
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resources: [resource],
    });
    apps.push(app);
    await app.ready();
    return app;
  }

  afterAll(async () => {
    while (apps.length > 0) {
      const a = apps.pop();
      if (a) await a.close();
    }
  });

  // ── 1. Single call — GET /list invokes parser.parse() exactly once ─────────

  it("GET list invokes the custom queryParser.parse() exactly once per request", async () => {
    const { parser, calls } = makeSpyParser();
    const { resource } = makeResource("qpOnce", "/qp-once", parser);
    const app = await newApp(resource);

    const res = await app.inject({ method: "GET", url: "/qp-once?limit=5&sort=-name" });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // The parser received the raw query object. Fastify's default
    // querystring parser coerces numeric-looking strings, so we match
    // against both coerced and raw forms to keep the test robust to
    // parser upgrades.
    const got = calls[0]!;
    expect(String(got.limit)).toBe("5");
    expect(got.sort).toBe("-name");
  });

  // ── 2. Parser output reaches the repository (instrumented directly) ──────

  it("parser.parse() output (limit + filters) flows through to repository.getAll()", async () => {
    // Stronger than "parser was called": the parser's OUTPUT must shape
    // the options object the repository receives. Instrument the repo's
    // getAll directly — that's the single chokepoint where we can observe
    // the resolved query options without depending on response-shape
    // assumptions that can drift across adapters.
    const Model = createMockModel("QpRtToRepo");
    const repo = createMockRepository(Model);
    const getAllCalls: Array<Record<string, unknown>> = [];
    const originalGetAll = repo.getAll.bind(repo);
    // biome-ignore lint/suspicious/noExplicitAny: repo method signatures
    // are adapter-specific at this layer; we only care about the options arg.
    (repo as any).getAll = async (options: Record<string, unknown>) => {
      getAllCalls.push(options);
      return originalGetAll(options);
    };

    const parser: QueryParserInterface = {
      parse: vi.fn(() => ({
        page: 1,
        limit: 3, // parser's clamped limit
        filters: { _customParserMarker: "flagged" },
        select: undefined,
        sort: undefined,
        search: undefined,
        populate: undefined,
        after: undefined,
      })),
    };

    const resource = defineResource({
      name: "qpClamp",
      prefix: "/qp-clamp",
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller: new BaseController(repo, { resourceName: "qpClamp", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      queryParser: parser,
    });
    const app = await newApp(resource);

    // Arc's default query schema may validate `limit` against `maxLimit`
    // BEFORE the parser runs (Fastify preValidation). Use a permissive
    // URL — the parser's return value is what we care about, and it's
    // constant regardless of URL. Alternatively, a resource that sets an
    // explicit `maxLimit` via its own query schema would accept 9999, but
    // that's orthogonal to the invariant being tested.
    const res = await app.inject({ method: "GET", url: "/qp-clamp" });
    if (res.statusCode !== 200) {
      // Log the rejection for debuggability — body carries Fastify's
      // validation error message.
      throw new Error(`Expected 200 from /qp-clamp; got ${res.statusCode}: ${res.body}`);
    }
    expect(res.statusCode).toBe(200);

    // The repo saw the parser's clamped limit (3) — NOT arc's default (20).
    // And the parser's injected filter key made it through to the
    // repository layer.
    expect(getAllCalls).toHaveLength(1);
    const resolved = getAllCalls[0]!;
    expect(resolved.limit).toBe(3);
    expect(resolved.filters).toMatchObject({ _customParserMarker: "flagged" });
  });

  // ── 4. Query-string operators reach parser.parse() verbatim ───────────────

  it("parser.parse() receives the raw query object including bracket-operator suffixes", async () => {
    const { parser, calls } = makeSpyParser();
    const { resource } = makeResource("qpOps", "/qp-ops", parser);
    const app = await newApp(resource);

    const res = await app.inject({
      method: "GET",
      url: "/qp-ops?name[eq]=widget&price[gt]=50&tags[in]=a,b",
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // The raw query is forwarded to the parser untouched — the parser is
    // responsible for interpreting operator suffixes. Arc's QueryResolver
    // does NOT pre-process them before handing them over.
    //
    // Fastify's default querystring parser returns strings; different
    // parsers encode bracket-suffixes differently. Accept any encoding
    // that surfaces `name`, `price`, `tags` keys.
    const raw = calls[0];
    expect(raw).toBeDefined();
    const keys = Object.keys(raw!).join(",");
    // At minimum the base field names reach the parser (exact bracket
    // encoding is parser-specific).
    expect(keys).toMatch(/name|name\[eq\]/);
    expect(keys).toMatch(/price|price\[gt\]/);
    expect(keys).toMatch(/tags|tags\[in\]/);
  });

  // ── 5. defineResource({ controller, queryParser }) threads the parser ─────

  it("defineResource({ controller, queryParser }) threads parser via setQueryParser — and the threaded parser runs at request time", async () => {
    // Regression: the v2.10.9 gap where a user-supplied controller kept its
    // default parser even when defineResource got a different parser. This
    // test covers BOTH ends — the forwarding happens AND the forwarded
    // parser is the one that runs per-request.
    const { parser, calls } = makeSpyParser();
    const Model = createMockModel("QpRtSetParser");
    const repo = createMockRepository(Model);
    // User-supplied controller with default parser — defineResource should
    // swap it out via setQueryParser.
    const controller = new BaseController(repo, { resourceName: "qpSet", tenantField: false });

    const resource = defineResource({
      name: "qpSet",
      prefix: "/qp-set",
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      queryParser: parser,
    });

    const app = await newApp(resource);
    const res = await app.inject({ method: "GET", url: "/qp-set" });
    expect(res.statusCode).toBe(200);
    // Proof the threaded parser (not arc's default) ran.
    expect(calls).toHaveLength(1);
  });
});
