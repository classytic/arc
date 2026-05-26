/**
 * In-memory `ioredis` stand-in for tests. Implements just enough of
 * get/set/del/scan/eval to drive `RedisPushRefStore` — and reproduces
 * the Lua CLAIM_SCRIPT + RELEASE_IF_GEN_SCRIPT + PERSIST_IF_GEN_SCRIPT
 * semantics in JS so we can verify the wire contract without booting a
 * real Redis. Real-Redis verification lives in the dual-mode smoke
 * (set `ARC_WS_SMOKE_REDIS_URL`).
 */

import type { SerializedEntry } from "../../../src/integrations/websocket/pushref-registry.js";
import type { RedisLike } from "../../../src/integrations/websocket-pushref-redis.js";

export class FakeRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, _mode?: string, duration?: number): Promise<unknown> {
    this.store.set(key, {
      value,
      expiresAt: duration ? Date.now() + duration : 0,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    const e = this.store.get(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + ttlMs;
    return 1;
  }

  async scan(
    cursor: string | number,
    _matchKw: "MATCH",
    pattern: string,
    _countKw: "COUNT",
    _count: number,
  ): Promise<[string, string[]]> {
    if (cursor !== "0" && cursor !== 0) return ["0", []];
    const prefix = pattern.replace(/\*$/, "");
    const out: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return ["0", out];
  }

  /**
   * Dispatches by script content. Each branch mirrors the Lua semantics
   * declared in `websocket-pushref-redis.ts`. If those scripts diverge,
   * keep this in sync — that's why both live in the same package.
   */
  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (script.includes("'rejected', '', '0'")) {
      return this.claim(args as [string, string, string, string, string, string]);
    }
    if (script.includes("'missing'") && script.includes("entry.active = false")) {
      return this.releaseIfGen(args as [string, string, string, string, string]);
    }
    if (script.includes("'missing'") && script.includes("entry.nextSeq = snap.nextSeq")) {
      return this.persistIfGen(args as [string, string, string, string, string]);
    }
    if (script.includes("'active'") && script.includes("entry.nextSeq = seq + 1")) {
      return this.stageIfInactive(args as [string, string, string, string, string]);
    }
    throw new Error("FakeRedis.eval: unknown script");
  }

  private async stageIfInactive(args: [string, string, string, string, string]): Promise<string> {
    const [key, payloadJson, timestampArg, expiresAtArg, pexpireArg] = args;
    const existing = await this.get(key);
    if (!existing) return "missing";
    const entry = JSON.parse(existing) as SerializedEntry;
    if (entry.active) return "active";
    if (entry.envelopeMode !== "seq") return "raw";
    const seq = entry.nextSeq;
    entry.nextSeq = seq + 1;
    const payload = JSON.parse(payloadJson);
    const serialized = JSON.stringify({ seq, t: Number(timestampArg), msg: payload });
    entry.deadQueue.push({ seq, payload: serialized });
    while (entry.deadQueue.length > entry.deadQueueSize) {
      entry.deadQueue.shift();
    }
    entry.expiresAt = Number(expiresAtArg);
    await this.set(key, JSON.stringify(entry), "PX", Number(pexpireArg));
    return "ok";
  }

  private async claim(
    args: [string, string, string, string, string, string],
  ): Promise<[string, string, string]> {
    const [key, principal, nowArg, ttlArg, mintedJson, graceMs] = args;
    const now = Number(nowArg);
    const ttl = Number(ttlArg);
    const grace = Number(graceMs);
    const pexpire = ttl + grace;
    const existing = await this.get(key);
    if (existing) {
      const entry = JSON.parse(existing) as SerializedEntry;
      if (!(entry.active === false && entry.expiresAt <= now)) {
        if (entry.principal !== principal) return ["rejected", "", "0"];
        const superseded = entry.active === true ? "1" : "0";
        entry.active = true;
        entry.expiresAt = now + ttl;
        entry.generation = (entry.generation ?? 0) + 1;
        const payload = JSON.stringify(entry);
        await this.set(key, payload, "PX", pexpire);
        return ["resumed", payload, superseded];
      }
    }
    await this.set(key, mintedJson, "PX", pexpire);
    return ["new", mintedJson, "0"];
  }

  private async releaseIfGen(args: [string, string, string, string, string]): Promise<string> {
    const [key, expectedGen, expiresAtArg, pexpireArg, snapJson] = args;
    const existing = await this.get(key);
    if (!existing) return "missing";
    const entry = JSON.parse(existing) as SerializedEntry;
    if (entry.generation !== Number(expectedGen)) return "stale";
    entry.active = false;
    entry.expiresAt = Number(expiresAtArg);
    if (snapJson !== "") {
      const snap = JSON.parse(snapJson) as {
        nextSeq: number;
        deadQueue: SerializedEntry["deadQueue"];
      };
      entry.nextSeq = snap.nextSeq;
      entry.deadQueue = snap.deadQueue;
    }
    await this.set(key, JSON.stringify(entry), "PX", Number(pexpireArg));
    return "ok";
  }

  private async persistIfGen(args: [string, string, string, string, string]): Promise<string> {
    const [key, expectedGen, expiresAtArg, pexpireArg, snapJson] = args;
    const existing = await this.get(key);
    if (!existing) return "missing";
    const entry = JSON.parse(existing) as SerializedEntry;
    if (entry.generation !== Number(expectedGen)) return "stale";
    const snap = JSON.parse(snapJson) as {
      nextSeq: number;
      deadQueue: SerializedEntry["deadQueue"];
    };
    entry.nextSeq = snap.nextSeq;
    entry.deadQueue = snap.deadQueue;
    entry.expiresAt = Number(expiresAtArg);
    await this.set(key, JSON.stringify(entry), "PX", Number(pexpireArg));
    return "ok";
  }
}
