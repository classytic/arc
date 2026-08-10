/**
 * QueryCache Event-Driven Invalidation Tests
 *
 * Tests that the queryCachePlugin auto-invalidates on CRUD events
 * and wires cross-resource tag invalidation.
 */

import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { queryCachePlugin } from "../../src/cache/queryCachePlugin.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";

describe("QueryCache Event-Driven Invalidation", () => {
  let fastify: FastifyInstance;
  let store: MemoryCacheStore;

  beforeEach(async () => {
    store = new MemoryCacheStore({ defaultTtlSeconds: 300 });
    fastify = Fastify({ logger: false });

    // Register events plugin first (required for auto-invalidation)
    await fastify.register(eventPlugin);
    // Register queryCache plugin
    await fastify.register(queryCachePlugin, { store });

    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    await store.close();
  });

  it("should decorate fastify with queryCache", () => {
    expect(fastify.queryCache).toBeDefined();
    expect(typeof fastify.queryCache.get).toBe("function");
    expect(typeof fastify.queryCache.set).toBe("function");
    expect(typeof fastify.queryCache.bumpResourceVersion).toBe("function");
  });

  it("should decorate fastify with queryCacheConfig defaults", () => {
    expect(fastify.queryCacheConfig).toEqual({
      staleTime: 0,
      gcTime: 60,
    });
  });

  it("should auto-invalidate on product.created event", async () => {
    const qc = fastify.queryCache;

    // Set initial version
    const v0 = await qc.getResourceVersion("product");
    expect(v0).toBe(0);

    // Publish a CRUD event
    await fastify.events.publish("product.created", { id: "123" });

    // Version should be bumped
    const v1 = await qc.getResourceVersion("product");
    expect(v1).toBeGreaterThan(0);
  });

  it("should auto-invalidate on product.updated event", async () => {
    const qc = fastify.queryCache;

    await fastify.events.publish("product.updated", { id: "123" });

    const version = await qc.getResourceVersion("product");
    expect(version).toBeGreaterThan(0);
  });

  it("should auto-invalidate on product.deleted event", async () => {
    const qc = fastify.queryCache;

    await fastify.events.publish("product.deleted", { id: "123" });

    const version = await qc.getResourceVersion("product");
    expect(version).toBeGreaterThan(0);
  });

  it("should not invalidate on non-CRUD events", async () => {
    const qc = fastify.queryCache;

    await fastify.events.publish("product.viewed", { id: "123" });

    const version = await qc.getResourceVersion("product");
    expect(version).toBe(0); // unchanged
  });

  it("should invalidate different resources independently", async () => {
    const qc = fastify.queryCache;

    await fastify.events.publish("product.created", { id: "1" });
    await fastify.events.publish("order.created", { id: "2" });

    const productV = await qc.getResourceVersion("product");
    const orderV = await qc.getResourceVersion("order");
    const categoryV = await qc.getResourceVersion("category");

    expect(productV).toBeGreaterThan(0);
    expect(orderV).toBeGreaterThan(0);
    expect(categoryV).toBe(0); // not affected
  });

  /**
   * NAMESPACED kernel events — the shape every `@classytic/*` kernel actually publishes
   * (`catalog:category.created`, `revenue:payment.verified`, `access:entitlement.granted`).
   *
   * The subscriber derived the resource by slicing before the LAST dot, so
   * `catalog:category.created` bumped `arc:ver:catalog:category` while every reader
   * calls `getResourceVersion("category")` — `buildQueryKey` takes the arc RESOURCE
   * NAME. Bump and read used different keys, so auto-invalidation never fired for ANY
   * kernel-backed resource. Nothing errored; caches simply served stale data for a full
   * `staleTime`.
   */
  it("bumps the RESOURCE version for a namespaced kernel event", async () => {
    const qc = fastify.queryCache;
    expect(await qc.getResourceVersion("category")).toBe(0);

    await fastify.events.publish("catalog:category.created", { id: "c1" });

    expect(await qc.getResourceVersion("category")).toBeGreaterThan(0);
  });

  /**
   * The namespaced form is ALSO bumped. Over-invalidation is safe (a cache miss);
   * under-invalidation is a correctness bug, so when a name is ambiguous the plugin
   * errs toward invalidating more.
   */
  /**
   * The split is UNCONDITIONAL — a prefix containing a dot still yields the bare
   * name. Pinned because the docblock previously claimed the opposite guard, and a
   * reader could "restore" it: narrowing the split removes invalidations, which is
   * the only direction that can serve wrong data.
   */
  it("splits a dotted namespace prefix too, erring toward invalidating more", async () => {
    const qc = fastify.queryCache;
    expect(await qc.getResourceVersion("entity")).toBe(0);

    await fastify.events.publish("some.thing:entity.created", { id: "e1" });

    expect(await qc.getResourceVersion("entity")).toBeGreaterThan(0);
    expect(await qc.getResourceVersion("some.thing:entity")).toBeGreaterThan(0);
  });

  it("also bumps the fully-qualified name, so either spelling invalidates", async () => {
    const qc = fastify.queryCache;
    await fastify.events.publish("catalog:category.updated", { id: "c1" });

    expect(await qc.getResourceVersion("catalog:category")).toBeGreaterThan(0);
  });

  /** A namespace with no dot after it is not a CRUD event and must not bump anything. */
  it("ignores a namespaced event whose suffix is not a CRUD verb", async () => {
    const qc = fastify.queryCache;
    await fastify.events.publish("catalog:category.viewed", { id: "c1" });

    expect(await qc.getResourceVersion("category")).toBe(0);
  });
});

describe("QueryCache Cross-Resource Invalidation", () => {
  let fastify: FastifyInstance;
  let store: MemoryCacheStore;

  beforeEach(async () => {
    store = new MemoryCacheStore({ defaultTtlSeconds: 300 });
    fastify = Fastify({ logger: false });

    await fastify.register(eventPlugin);
    await fastify.register(queryCachePlugin, { store });
  });

  afterEach(async () => {
    await fastify.close();
    await store.close();
  });

  it("should register and execute cross-resource invalidation rules", async () => {
    // Register a rule: when category.* fires, bump 'catalog' tag
    fastify.registerCacheInvalidationRule?.({
      pattern: "category.*",
      tags: ["catalog"],
    });

    await fastify.ready();

    const qc = fastify.queryCache;

    // Verify catalog tag starts at 0
    const tagV0 = await qc.getTagVersion("catalog");
    expect(tagV0).toBe(0);

    // Fire a category event
    await fastify.events.publish("category.updated", { id: "cat1" });

    // Catalog tag should be bumped
    const tagV1 = await qc.getTagVersion("catalog");
    expect(tagV1).toBeGreaterThan(0);
  });

  it("should not fire cross-resource rules for non-matching events", async () => {
    fastify.registerCacheInvalidationRule?.({
      pattern: "category.*",
      tags: ["catalog"],
    });

    await fastify.ready();

    const qc = fastify.queryCache;

    // Fire a non-matching event
    await fastify.events.publish("order.created", { id: "1" });

    // Catalog tag should be unchanged
    const tagV = await qc.getTagVersion("catalog");
    expect(tagV).toBe(0);
  });
});

describe("QueryCache Plugin Options", () => {
  it("should accept custom defaults", async () => {
    const fastify = Fastify({ logger: false });
    const store = new MemoryCacheStore();

    await fastify.register(queryCachePlugin, {
      store,
      defaults: { staleTime: 30, gcTime: 300 },
    });

    await fastify.ready();

    expect(fastify.queryCacheConfig).toEqual({
      staleTime: 30,
      gcTime: 300,
    });

    await fastify.close();
    await store.close();
  });

  it("should use MemoryCacheStore by default when no store provided", async () => {
    const fastify = Fastify({ logger: false });

    await fastify.register(queryCachePlugin);
    await fastify.ready();

    expect(fastify.queryCache).toBeDefined();

    await fastify.close();
  });
});
