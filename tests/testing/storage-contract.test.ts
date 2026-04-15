/**
 * Meta-test for `runStorageContract`
 *
 * Verifies the contract suite itself is correct by running it against a
 * minimal in-memory adapter. This is the same call adapter authors make —
 * if it passes here, third-party adapters pass too.
 */

import { randomUUID } from "node:crypto";
import { runStorageContract } from "../../src/testing/storageContract.js";
import type { Storage } from "../../src/types/storage.js";

interface Row {
  buffer: Buffer;
  contentType: string;
  scopeKey: string;
}

function memoryStorage(): Storage {
  // Scope-keyed storage so the "two scopes get distinct ids" contract passes
  // even though the underlying map would happily dedupe by id.
  const rows = new Map<string, Row>();
  const scopeKeyOf = (scope: Record<string, unknown> | undefined): string =>
    String(scope?.organizationId ?? "default");

  return {
    async upload(input, ctx) {
      const id = randomUUID();
      rows.set(id, {
        buffer: Buffer.from(input.buffer),
        contentType: input.mimeType,
        scopeKey: scopeKeyOf(ctx.scope),
      });
      return {
        id,
        url: `memory://${id}`,
        pathname: `${scopeKeyOf(ctx.scope)}/${id}`,
        contentType: input.mimeType,
        bytes: input.size,
      };
    },
    async read(id, ctx, range) {
      const row = rows.get(id);
      if (!row) throw new Error("Not found");
      if (row.scopeKey !== scopeKeyOf(ctx.scope)) throw new Error("Not found");
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
      return { kind: "buffer", buffer: row.buffer, contentType: row.contentType };
    },
    async delete(id, ctx) {
      const row = rows.get(id);
      if (!row) return false;
      if (row.scopeKey !== scopeKeyOf(ctx.scope)) return false;
      return rows.delete(id);
    },
    async exists(id, ctx) {
      const row = rows.get(id);
      return !!row && row.scopeKey === scopeKeyOf(ctx.scope);
    },
    async resolveUrl(id) {
      return rows.has(id) ? `memory://${id}` : "";
    },
  };
}

runStorageContract("memoryStorage (meta-test)", async () => {
  const storage = memoryStorage();
  return { storage, teardown: async () => {} };
});
