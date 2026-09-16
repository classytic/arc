/**
 * `runWorkScope` — one ambient scope per UNIT OF WORK, whatever started it.
 *
 * `requestScopedCache` and every other per-request mechanism key on
 * `requestContext`, which only arc's HTTP hook ever entered. So they went inert
 * in exactly the places a fan-out moves to: an outbox relay tick, a scheduled
 * job, a broker delivery. This scope is the same store entered by whoever owns
 * the lifecycle, so the mechanisms above work everywhere without knowing why.
 *
 * Two properties carry the design and both are asserted negatively:
 *   - INHERIT-IF-PRESENT — a scope opened inside an active one must NOT
 *     shadow it, or a live in-request dispatch would lose the request's cache.
 *   - NO SHARING ACROSS SCOPES — two units of work never see each other's
 *     values, or a relay tick would serve one event's document to the next.
 */

import { describe, expect, it } from "vitest";
import { requestContext } from "../../src/context/requestContext.js";
import { requestScopedCache } from "../../src/context/requestScopedCache.js";
import { runWorkScope, scopedValue, workSeedFromEvent } from "../../src/context/workScope.js";
import type { DomainEvent } from "../../src/events/EventTransport.js";

const SLOT = Symbol.for("test.workScope.slot");

describe("runWorkScope — outside any scope", () => {
  it("enters a scope carrying the seed's kind, id and organization", () => {
    expect(requestContext.get()).toBeUndefined();
    runWorkScope({ kind: "event", id: "evt-1", organizationId: "org-1" }, () => {
      const store = requestContext.get();
      expect(store?.kind).toBe("event");
      expect(store?.requestId).toBe("evt-1");
      expect(store?.organizationId).toBe("org-1");
      expect(typeof store?.startTime).toBe("number");
    });
    expect(requestContext.get()).toBeUndefined();
  });

  it("does NOT invent a user — an event has an actor id, not a session", () => {
    runWorkScope({ kind: "event", id: "evt-1" }, () => {
      expect(requestContext.get()?.user).toBeUndefined();
    });
  });

  it("makes requestScopedCache() available — the reason this exists", () => {
    expect(requestScopedCache()).toBeUndefined();
    runWorkScope({ kind: "job", id: "sweep" }, () => {
      expect(requestScopedCache()).toBeDefined();
    });
  });

  it("returns fn's value, sync or async", async () => {
    expect(runWorkScope({ kind: "job", id: "j" }, () => 42)).toBe(42);
    await expect(runWorkScope({ kind: "job", id: "j" }, async () => "ok")).resolves.toBe("ok");
  });
});

describe("runWorkScope — INHERITS an active scope rather than shadowing it", () => {
  it("inside a request, keeps the request's store", () => {
    requestContext.run({ startTime: 1, requestId: "req-1", kind: "request" }, () => {
      const outer = requestContext.get();
      runWorkScope({ kind: "event", id: "evt-1" }, () => {
        expect(requestContext.get()).toBe(outer);
        expect(requestContext.get()?.requestId).toBe("req-1");
      });
    });
  });

  it("inside a request, a dispatch shares the request's cache", async () => {
    await requestContext.run({ startTime: 1, kind: "request" }, async () => {
      const outerCache = requestScopedCache();
      await runWorkScope({ kind: "event", id: "evt-1" }, async () => {
        expect(requestScopedCache()).toBe(outerCache);
      });
    });
  });
});

describe("runWorkScope — two units of work never share", () => {
  it("sequential scopes get distinct stores", () => {
    const a = runWorkScope({ kind: "event", id: "a" }, () => requestContext.get());
    const b = runWorkScope({ kind: "event", id: "b" }, () => requestContext.get());
    expect(a).not.toBe(b);
  });

  it("interleaved scopes keep their own values", async () => {
    const started: Array<() => void> = [];
    const gate = new Promise<void>((r) => started.push(r));
    const a = runWorkScope({ kind: "event", id: "a" }, async () => {
      scopedValue(SLOT, () => "A");
      await gate;
      return scopedValue(SLOT, () => "late");
    });
    const b = runWorkScope({ kind: "event", id: "b" }, async () => {
      const v = scopedValue(SLOT, () => "B");
      started[0]?.();
      return v;
    });
    expect(await a).toBe("A");
    expect(await b).toBe("B");
  });
});

describe("scopedValue — the memo slot", () => {
  it("returns undefined outside a scope, never a process-wide fallback", () => {
    expect(scopedValue(SLOT, () => "leak")).toBeUndefined();
  });

  it("creates once per scope and returns the same instance after", () => {
    runWorkScope({ kind: "job", id: "j" }, () => {
      let created = 0;
      const first = scopedValue(SLOT, () => ({ n: ++created }));
      const second = scopedValue(SLOT, () => ({ n: ++created }));
      expect(first).toBe(second);
      expect(created).toBe(1);
    });
  });

  it("distinct slots are distinct values", () => {
    runWorkScope({ kind: "job", id: "j" }, () => {
      const a = scopedValue(Symbol.for("test.a"), () => "a");
      const b = scopedValue(Symbol.for("test.b"), () => "b");
      expect(a).toBe("a");
      expect(b).toBe("b");
    });
  });

  it("survives await boundaries", async () => {
    await runWorkScope({ kind: "job", id: "j" }, async () => {
      const before = scopedValue(SLOT, () => ({}));
      await new Promise((r) => setTimeout(r, 1));
      expect(scopedValue(SLOT, () => ({}))).toBe(before);
    });
  });

  // "Created once per scope" is the ONLY guarantee this has, so it cannot hold
  // for some return values and not others. A truthiness check on the stored
  // value breaks exactly the falsy ones — and silently: every call still
  // returns a correct-looking result, it just pays for a fresh `create()` each
  // time. A memoized `null` from a lookup that found nothing, or a `0`
  // counter, is the caller least likely to notice and most likely to care.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["0", 0],
    ["empty string", ""],
    ["false", false],
  ])("memoizes a falsy value (%s) — created once, not once per call", (_label, value) => {
    runWorkScope({ kind: "job", id: "j" }, () => {
      const slot = Symbol(`test.falsy.${String(value)}`);
      let created = 0;
      const create = () => {
        created++;
        return value;
      };
      expect(scopedValue(slot, create)).toBe(value);
      expect(scopedValue(slot, create)).toBe(value);
      expect(scopedValue(slot, create)).toBe(value);
      expect(created).toBe(1);
    });
  });

  it("a memoized falsy value is still not shared ACROSS scopes", () => {
    const slot = Symbol("test.falsy.cross-scope");
    let created = 0;
    const create = () => {
      created++;
      return null;
    };
    runWorkScope({ kind: "job", id: "a" }, () => void scopedValue(slot, create));
    runWorkScope({ kind: "job", id: "b" }, () => void scopedValue(slot, create));
    expect(created).toBe(2);
  });
});

describe("workSeedFromEvent", () => {
  const evt = (meta: Partial<DomainEvent["meta"]>): DomainEvent =>
    ({
      type: "order:created",
      payload: {},
      meta: { id: "e1", timestamp: new Date(), ...meta },
    }) as DomainEvent;

  it("uses the correlation id as the scope id so child events chain", () => {
    expect(workSeedFromEvent(evt({ correlationId: "corr-1" }))).toMatchObject({
      kind: "event",
      id: "corr-1",
    });
  });

  it("falls back to the event id when no correlation id was stamped", () => {
    expect(workSeedFromEvent(evt({})).id).toBe("e1");
  });

  it("carries the tenant off meta, never off the payload", () => {
    const seed = workSeedFromEvent(evt({ organizationId: "org-9" }));
    expect(seed.organizationId).toBe("org-9");
  });
});
