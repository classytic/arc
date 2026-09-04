/**
 * `handlerDispatch: 'parallel'` changes WHEN subscribers run, and nothing else.
 *
 * The sequential loop makes one publish cost the sum of its subscribers, which
 * on a fan-out bus is the length of the queue rather than of the work. Opting
 * into parallel must not weaken any of the guarantees the sequential path
 * makes, so every failure-semantics test below is asserted for BOTH modes.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import type { DomainEvent } from "../../src/events/eventTypes.js";

const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function evt(type = "order:created"): DomainEvent {
  return {
    type,
    payload: { orderNumber: "ORD-1" },
    meta: { id: "e1", occurredAt: new Date().toISOString() },
  } as unknown as DomainEvent;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(["sequential", "parallel"] as const)("MemoryEventTransport (%s)", (handlerDispatch) => {
  it("delivers to every matching handler", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    const seen: string[] = [];
    t.subscribe("order:*", async () => void seen.push("a"));
    t.subscribe("order:created", async () => void seen.push("b"));

    await t.publish(evt());

    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("one throwing handler does not deprive the others of the event", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    const seen: string[] = [];
    t.subscribe("order:*", async () => {
      throw new Error("boom");
    });
    t.subscribe("order:*", async () => void seen.push("ran"));

    await t.publish(evt());

    expect(seen).toEqual(["ran"]);
  });

  it("under 'throw', rejects with an AggregateError carrying EVERY failure", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch, onHandlerError: "throw" });
    t.subscribe("order:*", async () => {
      throw new Error("one");
    });
    t.subscribe("order:*", async () => {
      throw new Error("two");
    });

    await expect(t.publish(evt())).rejects.toThrow(AggregateError);
  });

  it("under 'throw', the rejection happens AFTER every handler has run", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch, onHandlerError: "throw" });
    let lateRan = false;
    t.subscribe("order:*", async () => {
      throw new Error("early failure");
    });
    t.subscribe("order:*", async () => {
      await sleep(20);
      lateRan = true;
    });

    await expect(t.publish(evt())).rejects.toThrow();
    expect(lateRan).toBe(true);
  });

  it("under 'log' (default), publish resolves despite a throwing handler", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    t.subscribe("order:*", async () => {
      throw new Error("boom");
    });

    await expect(t.publish(evt())).resolves.toBeUndefined();
  });

  it("a non-matching pattern receives nothing", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    const seen: string[] = [];
    t.subscribe("invoice:*", async () => void seen.push("wrong"));

    await t.publish(evt());

    expect(seen).toEqual([]);
  });
});

describe("dispatch timing — the whole reason the option exists", () => {
  /** Three 60ms handlers: ~180ms queued, ~60ms overlapped. */
  const slowTransport = (handlerDispatch: "sequential" | "parallel") => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    for (let i = 0; i < 3; i++) t.subscribe("order:*", async () => void (await sleep(60)));
    return t;
  };

  it("sequential costs the SUM of its handlers", async () => {
    const started = Date.now();
    await slowTransport("sequential").publish(evt());
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("parallel costs the SLOWEST handler", async () => {
    const started = Date.now();
    await slowTransport("parallel").publish(evt());
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("parallel starts every handler before awaiting any", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch: "parallel" });
    const startedAt: number[] = [];
    for (let i = 0; i < 3; i++) {
      t.subscribe("order:*", async () => {
        startedAt.push(Date.now());
        await sleep(40);
      });
    }

    await t.publish(evt());

    // All three entered within the same tick, not 40ms apart.
    expect(Math.max(...startedAt) - Math.min(...startedAt)).toBeLessThan(20);
  });

  it("defaults to sequential — an existing app's timing does not change on upgrade", async () => {
    const started = Date.now();
    await new MemoryEventTransport({ logger: silent }).publish(evt());
    // No handlers here; the assertion that matters is the default itself.
    const t = new MemoryEventTransport({ logger: silent });
    for (let i = 0; i < 3; i++) t.subscribe("order:*", async () => void (await sleep(60)));
    const s2 = Date.now();
    await t.publish(evt());
    expect(Date.now() - s2).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

/** The dial between "queued" and "all at once". */
describe('handlerConcurrency', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('never runs more than the cap at once', async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch: 'parallel', handlerConcurrency: 2 });
    let live = 0;
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      t.subscribe('order:*', async () => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep(20);
        live -= 1;
      });
    }

    await t.publish(evt());

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('still delivers to EVERY handler when capped', async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch: 'parallel', handlerConcurrency: 2 });
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) t.subscribe('order:*', async () => void seen.push(i));

    await t.publish(evt());

    expect(seen).toHaveLength(5);
  });

  it('still collects failures when capped', async () => {
    const t = new MemoryEventTransport({
      logger: silent,
      handlerDispatch: 'parallel',
      handlerConcurrency: 1,
      onHandlerError: 'throw',
    });
    t.subscribe('order:*', async () => {
      throw new Error('a');
    });
    t.subscribe('order:*', async () => {
      throw new Error('b');
    });

    await expect(t.publish(evt())).rejects.toThrow(AggregateError);
  });

  it.each([0, -1, 2.5, Number.NaN])('REFUSES a %p cap at construction rather than stalling', (bad) => {
    expect(
      () => new MemoryEventTransport({ logger: silent, handlerDispatch: 'parallel', handlerConcurrency: bad }),
    ).toThrow(/positive integer/);
  });
});
