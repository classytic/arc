/**
 * Storage Contract Suite
 *
 * Any implementation of `@classytic/arc/types/storage`'s `Storage` interface
 * can import this and run it against a live instance to guarantee preset
 * compatibility. Passing this suite is the contract.
 *
 * @example
 * ```typescript
 * import { runStorageContract } from '@classytic/arc/testing/storage';
 * import { s3Storage } from '../src/storage/s3-storage.js';
 *
 * runStorageContract('s3Storage', async () => {
 *   const storage = s3Storage({ bucket: 'test-bucket' });
 *   return { storage, teardown: async () => {} };
 * });
 * ```
 *
 * This module statically imports `vitest`. Only load it from test code — arc's
 * production bundle never references this subpath, so the import tree stays
 * clean under tree-shaking.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Storage, StorageContext, StorageReadResult } from "../types/storage.js";

// ============================================================================
// Types
// ============================================================================

export interface StorageContractSetupResult {
  storage: Storage;
  teardown: () => Promise<void>;
}

export type StorageContractSetup = () => Promise<StorageContractSetupResult>;

// ============================================================================
// Helpers (pure)
// ============================================================================

function makeBytes(size: number, seed = 0): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i + seed) & 0xff;
  }
  return buf;
}

async function readAll(result: StorageReadResult): Promise<Buffer> {
  if (result.kind === "buffer") return result.buffer;
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const EMPTY_CTX: StorageContext = { scope: {} };

function ctxFor(scope: Record<string, unknown>): StorageContext {
  return { scope };
}

// ============================================================================
// Contract runner
// ============================================================================

/**
 * Register the storage contract suite under the caller's name.
 *
 * Assertions covered:
 *  1. upload() returns a StorageFile with every required field populated
 *  2. read(upload.id) round-trips the exact bytes
 *  3. delete() returns true on first call
 *  4. delete() returns false (or throws) on a missing id
 *  5. exists() (if implemented) agrees with upload/delete state
 *  6. resolveUrl() (if implemented) returns a non-empty URL for an existing id
 *  7. Two isolated scopes don't collide (scope threading)
 *  8. Full lifecycle: upload → read → delete → read rejects
 *  9. Both `kind: "stream"` and `kind: "buffer"` read results deliver correct bytes
 * 10. Ranged reads (if adapter supports them) slice correctly
 */
export function runStorageContract(name: string, setup: StorageContractSetup): void {
  describe(`Storage contract — ${name}`, () => {
    let storage: Storage;
    let teardown: () => Promise<void>;

    beforeAll(async () => {
      const result = await setup();
      storage = result.storage;
      teardown = result.teardown;
    });

    afterAll(async () => {
      if (teardown) await teardown();
    });

    it("upload() returns a populated StorageFile", async () => {
      const bytes = makeBytes(64);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "contract-1.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      expect(file.id).toBeTruthy();
      expect(file.url).toBeTruthy();
      expect(file.pathname).toBeTruthy();
      expect(file.contentType).toBe("application/octet-stream");
      expect(file.bytes).toBe(bytes.length);

      await storage.delete(file.id, EMPTY_CTX);
    });

    it("read() round-trips the exact bytes uploaded", async () => {
      const bytes = makeBytes(1024, 7);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "contract-2.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      const read = await storage.read(file.id, EMPTY_CTX);
      const actual = await readAll(read);
      expect(actual.equals(bytes)).toBe(true);
      expect(read.contentType).toBe("application/octet-stream");

      await storage.delete(file.id, EMPTY_CTX);
    });

    it("delete() returns true the first time, false (or throws) the second time", async () => {
      const bytes = makeBytes(32);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "contract-3.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      const first = await storage.delete(file.id, EMPTY_CTX);
      expect(first).toBe(true);

      // Second delete: either returns false OR throws NotFound — both are contract-compliant.
      let second: boolean | "threw" = "threw";
      try {
        second = await storage.delete(file.id, EMPTY_CTX);
      } catch {
        second = "threw";
      }
      expect(second === false || second === "threw").toBe(true);
    });

    it("exists() agrees with upload/delete state (if implemented)", async () => {
      if (!storage.exists) return;

      const bytes = makeBytes(16);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "contract-4.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      expect(await storage.exists(file.id, EMPTY_CTX)).toBe(true);
      await storage.delete(file.id, EMPTY_CTX);
      expect(await storage.exists(file.id, EMPTY_CTX)).toBe(false);
    });

    it("resolveUrl() returns a non-empty URL for an existing id (if implemented)", async () => {
      if (!storage.resolveUrl) return;

      const bytes = makeBytes(8);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "contract-5.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      const url = await storage.resolveUrl(file.id, EMPTY_CTX);
      expect(typeof url).toBe("string");
      expect(url.length).toBeGreaterThan(0);

      await storage.delete(file.id, EMPTY_CTX);
    });

    it("two different scopes get distinct ids (scope threading)", async () => {
      const bytes = makeBytes(24, 42);
      const scopeA = ctxFor({ organizationId: "org-a" });
      const scopeB = ctxFor({ organizationId: "org-b" });

      const a = await storage.upload(
        {
          buffer: bytes,
          filename: "scoped.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        scopeA,
      );
      const b = await storage.upload(
        {
          buffer: bytes,
          filename: "scoped.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        scopeB,
      );

      // Two independent uploads must get distinct ids even when payload matches.
      expect(a.id).not.toBe(b.id);

      const readA = await readAll(await storage.read(a.id, scopeA));
      const readB = await readAll(await storage.read(b.id, scopeB));
      expect(readA.equals(bytes)).toBe(true);
      expect(readB.equals(bytes)).toBe(true);

      await storage.delete(a.id, scopeA);
      await storage.delete(b.id, scopeB);
    });

    it("full lifecycle: upload → read → delete → read rejects", async () => {
      const bytes = makeBytes(128);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "lifecycle.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      const before = await readAll(await storage.read(file.id, EMPTY_CTX));
      expect(before.equals(bytes)).toBe(true);

      const removed = await storage.delete(file.id, EMPTY_CTX);
      expect(removed).toBe(true);

      let rejected = false;
      try {
        const after = await storage.read(file.id, EMPTY_CTX);
        const bytesAfter = await readAll(after);
        if (!bytesAfter.equals(bytes)) rejected = true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });

    it("read() handles both stream and buffer kinds", async () => {
      const bytes = makeBytes(256, 9);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "kind.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      const result = await storage.read(file.id, EMPTY_CTX);
      expect(result.kind === "stream" || result.kind === "buffer").toBe(true);
      const actual = await readAll(result);
      expect(actual.equals(bytes)).toBe(true);

      await storage.delete(file.id, EMPTY_CTX);
    });

    it("read() with a mid-object range slices correctly (when adapter supports ranges)", async () => {
      const bytes = makeBytes(1024, 13);
      const file = await storage.upload(
        {
          buffer: bytes,
          filename: "range.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
        },
        EMPTY_CTX,
      );

      const result = await storage.read(file.id, EMPTY_CTX, { start: 100, end: 199 });
      const actual = await readAll(result);

      // Adapter either honored the range (100 bytes) or returned the full object.
      // Both are allowed — the preset slices the full object client-side when needed.
      if (result.range) {
        expect(actual.length).toBe(100);
        expect(actual.equals(bytes.subarray(100, 200))).toBe(true);
      } else {
        expect(actual.length).toBe(bytes.length);
      }

      await storage.delete(file.id, EMPTY_CTX);
    });
  });
}
