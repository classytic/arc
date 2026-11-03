/**
 * `concurrency` + `writes.update` — the verb seam must not switch optimistic
 * concurrency off.
 *
 * Before: declaring `writes.update` skipped the If-Match check entirely, so a
 * stale If-Match was IGNORED and two saves at version N both wrote N+1 (the
 * second silently won). Now arc checks If-Match before the verb (412), hands the
 * verb `ctx.expectedVersion` to CAS with, maps a `version_conflict` the verb
 * throws to 412 (If-Match) or 409 (loaded), and still answers with an ETag.
 */
import { VersionConflictError } from "@classytic/repo-core/errors";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/factory/index.js";
import { allowPublic, defineResource } from "../../src/index.js";
import type { MutationWriteContext, ResourceWrites } from "../../src/types/resource/writes.js";

interface Doc {
  _id: string;
  title: string;
  version: number;
}

function memoryRepo(seed: Doc) {
  const rows = new Map<string, Doc>([[seed._id, { ...seed }]]);
  return {
    rows,
    repository: {
      capabilities: { optimisticConcurrency: true },
      getAll: async () => ({ method: "offset", data: [...rows.values()], total: rows.size }),
      getById: async (id: string) => (rows.has(id) ? { ...(rows.get(id) as Doc) } : null),
      create: async (data: Doc) => {
        rows.set(data._id, data);
        return data;
      },
      update: async (id: string, data: Partial<Doc>) => {
        const row = rows.get(id);
        if (!row) return null;
        const next = { ...row, ...data, version: row.version + 1 };
        rows.set(id, next);
        return next;
      },
      delete: async (id: string) => ({ success: rows.delete(id), message: "Deleted" }),
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(writes: ResourceWrites, concurrency = true) {
  const { repository, rows } = memoryRepo({ _id: "d1", title: "first", version: 3 });
  const resource = defineResource<Doc>({
    name: "shift",
    adapter: { repository, type: "custom", name: "mem" } as never,
    ...(concurrency ? { concurrency: { versionField: "version" } } : {}),
    writes: writes as never,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
  app = await createApp({ auth: false, logger: false, resources: [resource] });
  await app.ready();
  const patch = (title: string, ifMatch?: string) =>
    (app as FastifyInstance).inject({
      method: "PATCH",
      url: "/shifts/d1",
      payload: { title },
      ...(ifMatch ? { headers: { "if-match": ifMatch } } : {}),
    });
  return { rows, patch };
}

/** A verb that CASes on `ctx.expectedVersion`, as a mongokit `claimVersion` caller would. */
function casVerb(rows: () => Map<string, Doc>) {
  const seen: MutationWriteContext[] = [];
  const update = vi.fn(async (id: string, data: Partial<Doc>, ctx: MutationWriteContext) => {
    seen.push(ctx);
    const row = rows().get(id) as Doc;
    if (ctx.expectedVersion !== undefined && row.version !== ctx.expectedVersion) {
      throw new VersionConflictError({
        expectedVersion: ctx.expectedVersion,
        actualVersion: row.version,
        id,
      });
    }
    const next = { ...row, ...data, version: row.version + 1 } as Doc;
    rows().set(id, next);
    return next;
  });
  return { seen, update };
}

describe("concurrency with writes.update", () => {
  it("a stale If-Match is 412 and the verb never runs", async () => {
    const update = vi.fn();
    const { patch } = await boot({ update });
    const res = await patch("stale", '"2"');
    expect(res.statusCode).toBe(412);
    expect(update).not.toHaveBeenCalled();
  });

  it("a matching If-Match reaches the verb as expectedVersion with source 'if-match'", async () => {
    let rowsRef = new Map<string, Doc>();
    const verb = casVerb(() => rowsRef);
    const { rows, patch } = await boot({ update: verb.update as never });
    rowsRef = rows;
    const res = await patch("second", '"3"');
    expect(res.statusCode).toBe(200);
    expect(verb.seen[0]?.expectedVersion).toBe(3);
    expect(verb.seen[0]?.expectedVersionSource).toBe("if-match");
    // ETag reflects the verb's result.
    expect(res.headers.etag).toBe('"4"');
  });

  it("without If-Match the verb gets the loaded version, source 'loaded'", async () => {
    let rowsRef = new Map<string, Doc>();
    const verb = casVerb(() => rowsRef);
    const { rows, patch } = await boot({ update: verb.update as never });
    rowsRef = rows;
    const res = await patch("second");
    expect(res.statusCode).toBe(200);
    expect(verb.seen[0]).toMatchObject({ expectedVersion: 3, expectedVersionSource: "loaded" });
  });

  it("a version_conflict from the verb is 412 under If-Match", async () => {
    const { patch } = await boot({
      update: async (id, _data, ctx) => {
        throw new VersionConflictError({
          expectedVersion: ctx.expectedVersion ?? 0,
          actualVersion: 9,
          id,
        });
      },
    });
    const res = await patch("x", '"3"');
    expect(res.statusCode).toBe(412);
  });

  it("a version_conflict on ANOTHER document stays 409 under If-Match (not blamed on the target)", async () => {
    const { patch } = await boot({
      update: async () => {
        throw new VersionConflictError({ expectedVersion: 7, actualVersion: 8, id: "ledger-1" });
      },
    });
    const res = await patch("x", '"3"');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("version_conflict");
  });

  it("a version_conflict from the verb is 409 without If-Match (concurrent write after load)", async () => {
    const { patch } = await boot({
      update: async (id, _data, ctx) => {
        throw new VersionConflictError({
          expectedVersion: ctx.expectedVersion ?? 0,
          actualVersion: 9,
          id,
        });
      },
    });
    const res = await patch("x");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("version_conflict");
  });

  it("two saves at one version: the second fails instead of silently winning", async () => {
    let rowsRef = new Map<string, Doc>();
    const verb = casVerb(() => rowsRef);
    const { rows, patch } = await boot({ update: verb.update as never });
    rowsRef = rows;
    expect((await patch("a", '"3"')).statusCode).toBe(200);
    expect((await patch("b", '"3"')).statusCode).toBe(412);
    expect(rows.get("d1")?.title).toBe("a");
  });

  it("a void-returning verb is re-read and still carries the ETag", async () => {
    let rowsRef = new Map<string, Doc>();
    const verb = casVerb(() => rowsRef);
    const { rows, patch } = await boot({
      update: async (id, data, ctx) => {
        await verb.update(id, data as Partial<Doc>, ctx);
      },
    });
    rowsRef = rows;
    const res = await patch("second", '"3"');
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"4"');
  });

  it("a resource without concurrency gets no expectedVersion fields and ignores If-Match", async () => {
    const seen: MutationWriteContext[] = [];
    const { patch } = await boot(
      {
        update: async (_id, data, ctx) => {
          seen.push(ctx);
          return { _id: "d1", version: 3, ...(data as object) } as never;
        },
      },
      false,
    );
    const res = await patch("second", '"999"');
    expect(res.statusCode).toBe(200);
    expect("expectedVersion" in (seen[0] as object)).toBe(false);
    expect("expectedVersionSource" in (seen[0] as object)).toBe(false);
  });
});
