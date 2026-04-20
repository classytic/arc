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
