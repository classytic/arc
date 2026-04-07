/**
 * Nested query parsing — end-to-end
 *
 * Tests that deeply nested bracket query strings (qs-style) reach handlers
 * correctly through Fastify's custom querystringParser. This is the contract
 * for advanced filters, populate options, and operator-suffixed queries.
 *
 * Patterns covered:
 *   ?price[gte]=100&price[lte]=500
 *   ?name[contains]=widget
 *   ?user[post][title]=hello                     (2-level nesting)
 *   ?user[post][tags][]=foo&user[post][tags][]=bar  (nested + array)
 *   ?populate[author][select]=name,email         (MongoKit-style populate)
 *   ?ids[]=1&ids[]=2                              (top-level array)
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

describe("nested query parsing — Fastify qs integration", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function setup(): Promise<FastifyInstance> {
    app = await createApp({ preset: "testing", auth: false });
    app.get("/echo", async (req) => ({ query: req.query }));
    await app.ready();
    return app;
  }

  it("operator suffix: price[gte]=100&price[lte]=500", async () => {
    await setup();
    const res = await app?.inject({ method: "GET", url: "/echo?price[gte]=100&price[lte]=500" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({ price: { gte: "100", lte: "500" } });
  });

  it("string operator: name[contains]=widget", async () => {
    await setup();
    const res = await app?.inject({ method: "GET", url: "/echo?name[contains]=widget" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({ name: { contains: "widget" } });
  });

  it("two-level nesting: user[post][title]=hello", async () => {
    await setup();
    const res = await app?.inject({ method: "GET", url: "/echo?user[post][title]=hello" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({ user: { post: { title: "hello" } } });
  });

  it("three-level nesting: a[b][c][d]=deep", async () => {
    await setup();
    const res = await app?.inject({ method: "GET", url: "/echo?a[b][c][d]=deep" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({ a: { b: { c: { d: "deep" } } } });
  });

  it("nested + array: user[post][tags][]=foo&user[post][tags][]=bar", async () => {
    await setup();
    const res = await app?.inject({
      method: "GET",
      url: "/echo?user[post][tags][]=foo&user[post][tags][]=bar",
    });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({
      user: { post: { tags: ["foo", "bar"] } },
    });
  });

  it("top-level array: ids[]=1&ids[]=2&ids[]=3", async () => {
    await setup();
    const res = await app?.inject({ method: "GET", url: "/echo?ids[]=1&ids[]=2&ids[]=3" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({ ids: ["1", "2", "3"] });
  });

  it("MongoKit populate style: populate[author][select]=name,email", async () => {
    await setup();
    const res = await app?.inject({
      method: "GET",
      url: "/echo?populate[author][select]=name,email",
    });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({
      populate: { author: { select: "name,email" } },
    });
  });

  it("mixed: filter + populate + pagination", async () => {
    await setup();
    const res = await app?.inject({
      method: "GET",
      url: "/echo?price[gte]=10&populate[author][select]=name&page=2&limit=20&sort=-createdAt",
    });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({
      price: { gte: "10" },
      populate: { author: { select: "name" } },
      page: "2",
      limit: "20",
      sort: "-createdAt",
    });
  });

  it("URL-encoded brackets work too: %5Bgte%5D", async () => {
    await setup();
    const res = await app?.inject({ method: "GET", url: "/echo?price%5Bgte%5D=100" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({ price: { gte: "100" } });
  });

  it("multiple operators on the same field: price[gte]=10&price[lte]=100&price[ne]=50", async () => {
    await setup();
    const res = await app?.inject({
      method: "GET",
      url: "/echo?price[gte]=10&price[lte]=100&price[ne]=50",
    });
    expect(res?.statusCode).toBe(200);
    expect(res?.json().query).toEqual({
      price: { gte: "10", lte: "100", ne: "50" },
    });
  });
});
