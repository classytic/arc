/**
 * Audit Retention Tests
 *
 * Drives the 2.9.3 retention contract:
 *   1. AuditStore gains `purgeOlderThan(cutoff)` — DB-agnostic purge verb.
 *   2. `fastify.audit.purge(cutoff)` fans out across all stores.
 *   3. `auditPlugin({ retention: { maxAgeMs, purgeIntervalMs } })` runs
 *      periodic purges and cleans up the timer on close.
 *
 * Why this exists: before 2.9.3 `auditPlugin` had no retention story, so
 * downstream apps re-invented the same TTL index migration. This test
 * pins the contract so the plugin owns it.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import type { AuditEntry } from "../../src/audit/stores/interface.js";
import { MemoryAuditStore } from "../../src/audit/stores/memory.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

async function buildApp(
  pluginOpts: Parameters<typeof auditPlugin>[1] = { enabled: true },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(arcCorePlugin, {
    hookSystem: new HookSystem({ logger: { error: () => {} } }),
  });
  await app.register(auditPlugin, pluginOpts);
  await app.ready();
  return app;
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `aud_${Math.random().toString(36).slice(2)}`,
    resource: "order",
    documentId: "doc1",
    action: "create",
    timestamp: new Date(),
    ...overrides,
  };
}

describe("Audit retention (2.9.3)", () => {
  describe("MemoryAuditStore.purgeOlderThan", () => {
    it("removes entries older than cutoff, returns count purged", async () => {
      const store = new MemoryAuditStore();
      const now = Date.now();
      await store.log(makeEntry({ id: "old1", timestamp: new Date(now - 10_000) }));
      await store.log(makeEntry({ id: "old2", timestamp: new Date(now - 8_000) }));
      await store.log(makeEntry({ id: "fresh", timestamp: new Date(now - 1_000) }));

      const cutoff = new Date(now - 5_000);
      const purged = await store.purgeOlderThan(cutoff);

      expect(purged).toBe(2);
      const remaining = await store.query({});
      expect(remaining.map((e) => e.id)).toEqual(["fresh"]);
    });

    it("returns 0 when no entries are older than cutoff", async () => {
      const store = new MemoryAuditStore();
      await store.log(makeEntry({ timestamp: new Date() }));

      const purged = await store.purgeOlderThan(new Date(0));

      expect(purged).toBe(0);
    });
  });

  describe("fastify.audit.purge decorator", () => {
    let app: FastifyInstance | null = null;

    afterEach(async () => {
      if (app) await app.close();
      app = null;
    });

    it("fans out to every store that supports purgeOlderThan", async () => {
      const storeA = new MemoryAuditStore();
      const storeB = new MemoryAuditStore();
      const now = Date.now();
      await storeA.log(makeEntry({ id: "a-old", timestamp: new Date(now - 10_000) }));
      await storeB.log(makeEntry({ id: "b-old", timestamp: new Date(now - 10_000) }));
      await storeA.log(makeEntry({ id: "a-new", timestamp: new Date() }));

      app = await buildApp({
        enabled: true,
        customStores: [storeA, storeB],
        autoAudit: false,
      });

      const totalPurged = await app.audit.purge(new Date(now - 5_000));

      expect(totalPurged).toBe(2); // a-old + b-old
      expect((await storeA.query({})).map((e) => e.id)).toEqual(["a-new"]);
      expect(await storeB.query({})).toEqual([]);
    });

    it("is a no-op when audit is disabled", async () => {
      app = await buildApp({ enabled: false });
      const purged = await app.audit.purge(new Date());
      expect(purged).toBe(0);
    });
  });

  describe("retention option — periodic auto-purge", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("runs purge on the configured interval and clears timer on close", async () => {
      const store = new MemoryAuditStore();
      const purgeSpy = vi.spyOn(store, "purgeOlderThan");

      const app = await buildApp({
        enabled: true,
        customStores: [store],
        autoAudit: false,
        retention: {
          maxAgeMs: 60_000,
          purgeIntervalMs: 10_000,
        },
      });

      // No purge yet — interval hasn't fired
      expect(purgeSpy).not.toHaveBeenCalled();

      // Advance time past one interval
      await vi.advanceTimersByTimeAsync(10_000);
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      // Cutoff passed should be (approximately) now - maxAgeMs
      const cutoff = purgeSpy.mock.calls[0]?.[0] as Date;
      expect(cutoff).toBeInstanceOf(Date);
      // 60s before now — allow small fuzz
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(60_000);

      // Second tick
      await vi.advanceTimersByTimeAsync(10_000);
      expect(purgeSpy).toHaveBeenCalledTimes(2);

      // Close cleans up the interval — no more calls after close
      await app.close();
      purgeSpy.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(purgeSpy).not.toHaveBeenCalled();
    });

    it("does not start a timer when purgeIntervalMs is 0", async () => {
      const store = new MemoryAuditStore();
      const purgeSpy = vi.spyOn(store, "purgeOlderThan");

      const app = await buildApp({
        enabled: true,
        customStores: [store],
        autoAudit: false,
        retention: {
          maxAgeMs: 60_000,
          purgeIntervalMs: 0, // disabled
        },
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(purgeSpy).not.toHaveBeenCalled();

      // Manual purge still works
      await app.audit.purge(new Date());
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      await app.close();
    });
  });
});
