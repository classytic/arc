/**
 * WRITE VERBS OVER REAL HTTP — the seam proven end-to-end.
 *
 * The unit tests call controller methods directly; these go through Fastify
 * route dispatch (`app.inject()`, Fastify's canonical testing path), because
 * the defect class this feature closes lives exactly there: a route that
 * LOOKS bound to a domain command while something else answers it. Each case
 * asserts which side of the seam ran — the command, or the repository.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { ResourceWrites } from "../../src/types/resource/writes.js";
import { createError } from "../../src/utils/errors.js";

interface Invoice {
  _id: string;
  partnerName: string;
  status: string;
  [key: string]: unknown;
}

function makeRepo() {
  const store = new Map<string, Invoice>([
    ["inv-1", { _id: "inv-1", partnerName: "Acme", status: "draft" }],
    ["inv-2", { _id: "inv-2", partnerName: "Globex", status: "posted" }],
  ]);
  return {
    store,
    getAll: vi.fn(async () => ({
      method: "offset",
      data: [...store.values()],
      total: store.size,
      page: 1,
      limit: 20,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    })),
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    getOne: vi.fn(async () => null),
    create: vi.fn(async (data: Record<string, unknown>) => ({ _id: "repo-made", ...data })),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const doc = store.get(id);
      return doc ? { ...doc, ...data } : null;
    }),
    delete: vi.fn(async () => ({ success: true })),
  } as unknown as RepositoryLike<Invoice> & {
    store: Map<string, Invoice>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

const PERMISSIONS = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

async function bootApp(writes: ResourceWrites<Invoice>, repo = makeRepo()) {
  const app = Fastify({ logger: false });
  await app.register(arcCorePlugin);
  await app.register(
    defineResource<Invoice>({
      name: "invoice",
      adapter: { type: "custom", name: "mem", repository: repo },
      permissions: PERMISSIONS,
      schemaOptions: { fieldRules: { status: { systemManaged: true } } },
      writes,
    }).toPlugin(),
  );
  await app.ready();
  return { app, repo };
}

describe("write verbs over HTTP (Fastify inject)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("POST routes to the CREATE command with a sanitized body; repository.create never runs", async () => {
    const seen: Record<string, unknown>[] = [];
    const boot = await bootApp({
      create: async (data) => {
        seen.push(data as Record<string, unknown>);
        return { _id: "cmd-made", ...(data as object) } as Invoice;
      },
    });
    app = boot.app;

    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      payload: { partnerName: "Initech", status: "posted" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()._id).toBe("cmd-made");
    // The pipeline ran BEFORE the command: system-managed field stripped.
    expect(seen[0]?.partnerName).toBe("Initech");
    expect(seen[0]?.status).toBeUndefined();
    // The seam replaced persistence and only persistence.
    expect(boot.repo.create).not.toHaveBeenCalled();
  });

  it("PATCH routes to the UPDATE command; a void return still answers with the document", async () => {
    const boot = await bootApp({
      update: async () => undefined, // command persisted internally, returns void
    });
    app = boot.app;

    const res = await app.inject({
      method: "PATCH",
      url: "/invoices/inv-1",
      payload: { partnerName: "Edited" },
    });

    expect(res.statusCode).toBe(200);
    // Arc re-read through the repository to answer — not a 404.
    expect(res.json()._id).toBe("inv-1");
    expect(boot.repo.update).not.toHaveBeenCalled();
  });

  it("a GUARDED command's typed refusal surfaces as its own HTTP status", async () => {
    const boot = await bootApp({
      update: async (_id, _data, ctx) => {
        if (ctx.existing.status === "posted") {
          throw createError(409, "Only a draft may be edited", { code: "NOT_A_DRAFT" });
        }
        return ctx.existing;
      },
    });
    app = boot.app;

    const res = await app.inject({
      method: "PATCH",
      url: "/invoices/inv-2", // posted
      payload: { partnerName: "Tamper" },
    });

    expect(res.statusCode).toBe(409);
    // Draft path still works through the same command.
    const ok = await app.inject({
      method: "PATCH",
      url: "/invoices/inv-1",
      payload: { partnerName: "Fine" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("DELETE routes to the command; a void return is success, not 404", async () => {
    const deleted: string[] = [];
    const boot = await bootApp({
      delete: async (id) => {
        deleted.push(id);
      },
    });
    app = boot.app;

    const res = await app.inject({ method: "DELETE", url: "/invoices/inv-1" });

    expect(res.statusCode).toBe(200);
    expect(deleted).toEqual(["inv-1"]);
    expect(boot.repo.delete).not.toHaveBeenCalled();
  });

  it("a CREATE command returning nothing is a 500 contract violation, not a hollow 201", async () => {
    const boot = await bootApp({
      // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the contract
      create: (async () => undefined) as any,
    });
    app = boot.app;

    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      payload: { partnerName: "Hollow" },
    });

    expect(res.statusCode).toBe(500);
  });

  it("undeclared slots keep calling the repository — the seam is per-op", async () => {
    const boot = await bootApp({
      delete: async () => undefined, // only delete is command-owned
    });
    app = boot.app;

    const res = await app.inject({
      method: "PATCH",
      url: "/invoices/inv-1",
      payload: { partnerName: "RepoPath" },
    });

    expect(res.statusCode).toBe(200);
    expect(boot.repo.update).toHaveBeenCalledTimes(1);
  });
});
