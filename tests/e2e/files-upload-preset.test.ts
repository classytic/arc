/**
 * filesUploadPreset — end-to-end test
 *
 * Registers a real Fastify app with `createApp()` + `defineResource()` wired
 * to an in-memory `Storage` adapter, then exercises every route:
 *   POST /files/upload
 *   GET  /files/:id (with + without Range header)
 *   DELETE /files/:id
 *
 * Proves the preset is wired correctly without touching MongoDB, S3, or any
 * real backend.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { filesUploadPreset } from "../../src/presets/filesUpload.js";
import type { Storage } from "../../src/types/storage.js";

interface MemoryRow {
  buffer: Buffer;
  contentType: string;
  filename: string;
  scope: Record<string, unknown> | undefined;
}

function memoryStorage(): { storage: Storage; rows: Map<string, MemoryRow> } {
  const rows = new Map<string, MemoryRow>();

  const storage: Storage = {
    async upload(input, ctx) {
      const id = randomUUID();
      rows.set(id, {
        buffer: Buffer.from(input.buffer),
        contentType: input.mimeType,
        filename: input.filename,
        scope: ctx.scope,
      });
      return {
        id,
        url: `memory://${id}`,
        pathname: id,
        contentType: input.mimeType,
        bytes: input.size,
      };
    },
    async read(id, _ctx, range) {
      const row = rows.get(id);
      if (!row) throw new Error("Not found");
      if (range) {
        const slice = row.buffer.subarray(range.start, range.end + 1);
        return {
          kind: "buffer",
          buffer: slice,
          contentType: row.contentType,
          totalBytes: row.buffer.length,
          range,
        };
      }
      return {
        kind: "buffer",
        buffer: row.buffer,
        contentType: row.contentType,
        totalBytes: row.buffer.length,
      };
    },
    async delete(id) {
      return rows.delete(id);
    },
    async exists(id) {
      return rows.has(id);
    },
  };

  return { storage, rows };
}

async function buildMultipartPayload(
  fieldName: string,
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  form.set(fieldName, new Blob([buffer], { type: contentType }), filename);
  const request = new Request("http://localhost", { method: "POST", body: form });
  const raw = await request.arrayBuffer();
  return {
    payload: Buffer.from(raw),
    headers: {
      "content-type": request.headers.get("content-type") ?? "multipart/form-data",
    },
  };
}

describe("filesUploadPreset — e2e", () => {
  let app: FastifyInstance;
  let rows: Map<string, MemoryRow>;

  beforeAll(async () => {
    const backing = memoryStorage();
    rows = backing.rows;

    const fileResource = defineResource({
      name: "file",
      prefix: "/files",
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      presets: [
        filesUploadPreset({
          storage: backing.storage,
          permissions: {
            upload: allowPublic(),
            read: allowPublic(),
            delete: allowPublic(),
          },
        }),
      ],
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(fileResource.toPlugin());
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("uploads a file and returns the arc envelope", async () => {
    const bytes = Buffer.from("hello arc preset");
    const { payload, headers } = await buildMultipartPayload(
      "file",
      bytes,
      "hello.txt",
      "text/plain",
    );

    const res = await app.inject({ method: "POST", url: "/files/upload", payload, headers });
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: expect.any(String),
      url: expect.stringMatching(/^memory:\/\//),
      pathname: expect.any(String),
      contentType: "text/plain",
      bytes: bytes.length,
    });
  });

  it("round-trips bytes through GET /files/:id", async () => {
    const bytes = Buffer.from("round-trip-payload-xyz");
    const { payload, headers } = await buildMultipartPayload(
      "file",
      bytes,
      "roundtrip.bin",
      "application/octet-stream",
    );

    const uploadRes = await app.inject({
      method: "POST",
      url: "/files/upload",
      payload,
      headers,
    });
    const { data } = JSON.parse(uploadRes.body);

    const readRes = await app.inject({ method: "GET", url: `/files/${data.id}` });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.headers["content-type"]).toBe("application/octet-stream");
    expect(readRes.headers["accept-ranges"]).toBe("bytes");
    expect(readRes.rawPayload.equals(bytes)).toBe(true);
  });

  it("honors HTTP Range: bytes=start-end for partial reads", async () => {
    const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuv"); // 32 bytes
    const { payload, headers } = await buildMultipartPayload(
      "file",
      bytes,
      "ranged.bin",
      "application/octet-stream",
    );
    const uploadRes = await app.inject({
      method: "POST",
      url: "/files/upload",
      payload,
      headers,
    });
    const { data } = JSON.parse(uploadRes.body);

    // Request bytes 5-14 (10 bytes).
    const rangeRes = await app.inject({
      method: "GET",
      url: `/files/${data.id}`,
      headers: { range: "bytes=5-14" },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers["content-range"]).toBe(`bytes 5-14/${bytes.length}`);
    expect(rangeRes.headers["content-length"]).toBe("10");
    expect(rangeRes.rawPayload.equals(bytes.subarray(5, 15))).toBe(true);
  });

  it("handles suffix ranges (`Range: bytes=-N`)", async () => {
    const bytes = Buffer.from("abcdefghij"); // 10 bytes
    const { payload, headers } = await buildMultipartPayload(
      "file",
      bytes,
      "suffix.bin",
      "application/octet-stream",
    );
    const uploadRes = await app.inject({
      method: "POST",
      url: "/files/upload",
      payload,
      headers,
    });
    const { data } = JSON.parse(uploadRes.body);

    // The adapter returns the full buffer when `range` is undefined, so for suffix
    // ranges the preset slices server-side using totalBytes.
    const rangeRes = await app.inject({
      method: "GET",
      url: `/files/${data.id}`,
      headers: { range: "bytes=-4" },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers["content-range"]).toBe("bytes 6-9/10");
    expect(rangeRes.rawPayload.equals(bytes.subarray(6, 10))).toBe(true);
  });

  it("DELETE /files/:id returns 204 on success, 404 on already-absent", async () => {
    const bytes = Buffer.from("delete-me");
    const { payload, headers } = await buildMultipartPayload(
      "file",
      bytes,
      "delete.bin",
      "application/octet-stream",
    );
    const uploadRes = await app.inject({
      method: "POST",
      url: "/files/upload",
      payload,
      headers,
    });
    const { data } = JSON.parse(uploadRes.body);

    const first = await app.inject({ method: "DELETE", url: `/files/${data.id}` });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: "DELETE", url: `/files/${data.id}` });
    expect(second.statusCode).toBe(404);
    expect(rows.has(data.id)).toBe(false);
  });

  it("GET /files/:id returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/files/unknown-id-xyz" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /files/upload returns 400 when the file field is missing", async () => {
    const form = new FormData();
    form.set("other", "not-a-file");
    const request = new Request("http://localhost", { method: "POST", body: form });
    const raw = await request.arrayBuffer();

    const res = await app.inject({
      method: "POST",
      url: "/files/upload",
      payload: Buffer.from(raw),
      headers: {
        "content-type": request.headers.get("content-type") ?? "multipart/form-data",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================================
// Coexistence with user-authored routes
// ============================================================================
// Proves `routes: [...]` on the resource still works when the files-upload
// preset is active — users can add their own endpoints (stats, presign, etc.)
// alongside /upload, /:id and /:id DELETE. This is the "can user add their
// own route fixes?" path.

describe("filesUploadPreset — user route coexistence", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const backing = memoryStorage();

    const fileResource = defineResource({
      name: "file",
      prefix: "/files",
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      presets: [
        filesUploadPreset({
          storage: backing.storage,
          permissions: {
            upload: allowPublic(),
            read: allowPublic(),
            delete: allowPublic(),
          },
        }),
      ],
      // User-authored route — lives side-by-side with the preset's three routes.
      routes: [
        {
          method: "GET",
          path: "/stats",
          summary: "Storage stats",
          permissions: allowPublic(),
          raw: true,
          handler: async (_req: unknown, reply: { send: (body: unknown) => unknown }) =>
            reply.send({ success: true, data: { rows: backing.rows.size } }),
        },
      ],
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(fileResource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("user-added GET /files/stats works alongside preset routes", async () => {
    const statsRes = await app.inject({ method: "GET", url: "/files/stats" });
    expect(statsRes.statusCode).toBe(200);
    expect(JSON.parse(statsRes.body)).toEqual({ success: true, data: { rows: 0 } });
  });

  it("preset routes still register when user routes are present", async () => {
    const bytes = Buffer.from("coexistence");
    const { payload, headers } = await buildMultipartPayload(
      "file",
      bytes,
      "coexist.bin",
      "application/octet-stream",
    );
    const uploadRes = await app.inject({
      method: "POST",
      url: "/files/upload",
      payload,
      headers,
    });
    expect(uploadRes.statusCode).toBe(201);

    // User route reflects the new row count.
    const statsRes = await app.inject({ method: "GET", url: "/files/stats" });
    expect(JSON.parse(statsRes.body).data.rows).toBe(1);
  });
});
