/**
 * Unknown routes answer the canonical ErrorContract, not Fastify's `{ message, error, statusCode }`.
 * On by default under createApp; overridable; direct plugin registration stays opt-in.
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";

type App = Awaited<ReturnType<typeof createApp>>;
let app: App | ReturnType<typeof Fastify>;
afterEach(async () => {
  await app?.close().catch(() => {});
});

const base = { logger: false, preset: "testing", auth: false } as const;

describe("createApp not-found handler", () => {
  it("returns the ErrorContract shape for an unknown route", async () => {
    app = await createApp({ ...base });
    const res = await app.inject({ method: "GET", url: "/nope/here?x=1" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toMatchObject({
      code: "arc.not_found",
      message: "Route GET /nope/here not found",
      status: 404,
    });
    expect(body).not.toHaveProperty("statusCode");
    expect(body).not.toHaveProperty("error");
    expect(typeof body.correlationId).toBe("string");
  });

  it("covers every method", async () => {
    app = await createApp({ ...base });
    const res = await app.inject({ method: "POST", url: "/nope", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("arc.not_found");
  });

  it("errorHandler: { notFound: false } leaves Fastify's default (host owns it)", async () => {
    app = await createApp({ ...base, errorHandler: { notFound: false } });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
  });

  it("a host handler replaces arc's via errorHandler.notFound", async () => {
    app = await createApp({
      ...base,
      errorHandler: { notFound: async (_req, reply) => reply.status(404).send({ custom: true }) },
    });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.json()).toEqual({ custom: true });
  });

  it("errorHandler: false installs no arc handler at all", async () => {
    app = await createApp({ ...base, errorHandler: false });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.json()).toMatchObject({ statusCode: 404 });
  });
});

describe("errorHandlerPlugin registered directly", () => {
  it("does not touch the 404 unless asked", async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/x" })).json()).toMatchObject({
      statusCode: 404,
    });
  });

  it("notFound: true opts in", async () => {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin, { notFound: true });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/x" })).json().code).toBe("arc.not_found");
  });
});
