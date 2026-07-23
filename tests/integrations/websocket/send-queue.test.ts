/**
 * Per-connection send queue + RoomManager addressed-send semantics (PR 2).
 *
 * Covers:
 *   - SendQueue ordered delivery (`send`)
 *   - SendQueue droppable coalesce-by-key (`sendRealtime`)
 *   - SendQueue overflow policies (terminate on critical / shed on droppable)
 *   - SendQueue backpressure pause (bufferedAmount ≥ drainThreshold)
 *   - RoomManager `sendToPushRef` / `sendToUser` routing
 *   - RoomManager queue-aware delivery + close-guard interaction
 */

import { describe, expect, it, vi } from "vitest";
import { RoomManager } from "../../../src/integrations/websocket/room-manager.js";
import {
  DEFAULT_QUEUE_CAPACITY,
  SendQueue,
} from "../../../src/integrations/websocket/send-queue.js";

function makeSocket(initial: { bufferedAmount?: number; readyState?: number } = {}) {
  const sent: string[] = [];
  let bufferedAmount = initial.bufferedAmount ?? 0;
  const sock = {
    sent,
    readyState: initial.readyState ?? 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    setBufferedAmount(n: number) {
      bufferedAmount = n;
    },
    send: vi.fn((msg: string) => {
      sent.push(msg);
    }),
    terminate: vi.fn(),
    close: vi.fn(),
  };
  return sock;
}

// ============================================================================
// SendQueue — core behavior
// ============================================================================

describe("SendQueue — ordered send()", () => {
  it("writes immediately to a healthy socket", () => {
    const s = makeSocket();
    const q = new SendQueue(s);
    q.send("a");
    q.send("b");
    expect(s.sent).toEqual(["a", "b"]);
  });

  it("queues entries while bufferedAmount is over drainThreshold", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 }); // 1 MB ≫ 256 KB threshold
    const q = new SendQueue(s);
    q.send("a");
    q.send("b");
    expect(s.sent).toEqual([]);
    expect(q.size()).toBe(2);

    // Drain: socket frees up → manual flush
    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["a", "b"]);
    expect(q.size()).toBe(0);
  });

  it("terminates the socket on overflow when only critical frames are queued", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { capacity: 3 });
    q.send("1");
    q.send("2");
    q.send("3");
    q.send("4"); // overflow — terminate
    expect(s.terminate).toHaveBeenCalled();
    expect(q.size()).toBe(0);
  });
});

describe("SendQueue — droppable sendRealtime()", () => {
  it("coalesces by key — same key replaces in-place, queue stays at length 1", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s);
    q.sendRealtime("v1", "gps");
    q.sendRealtime("v2", "gps");
    q.sendRealtime("v3", "gps");
    expect(q.size()).toBe(1);

    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["v3"]); // latest snapshot wins
  });

  it("sheds the oldest droppable on overflow, never the critical", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { capacity: 4 });
    q.send("crit-1");
    q.sendRealtime("loc-A");
    q.sendRealtime("loc-B");
    q.sendRealtime("loc-C");
    expect(q.size()).toBe(4);
    q.sendRealtime("loc-D"); // shed oldest droppable (loc-A), keep crit-1
    expect(q.size()).toBe(4);

    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["crit-1", "loc-B", "loc-C", "loc-D"]);
    expect(s.terminate).not.toHaveBeenCalled();
  });

  it("drops the new droppable when the queue is full of criticals (no terminate)", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { capacity: 2 });
    q.send("crit-1");
    q.send("crit-2");
    q.sendRealtime("dropme"); // nothing to shed — just drop
    expect(q.size()).toBe(2);
    expect(s.terminate).not.toHaveBeenCalled();
  });

  it("dispose() clears state and short-circuits further sends", () => {
    const s = makeSocket();
    const q = new SendQueue(s);
    q.send("a");
    q.dispose();
    q.send("ignored");
    q.sendRealtime("also-ignored");
    expect(s.sent).toEqual(["a"]);
    expect(q.size()).toBe(0);
  });
});

// ============================================================================
// SendQueue — head-pointer drain (wave-12: no O(n²) shift/reindex)
// ============================================================================

describe("SendQueue — head-pointer drain", () => {
  it("repeated fill/drain cycles preserve order and leave the queue empty", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { capacity: 512 });
    const expected: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 100; i++) {
        const payload = `c${cycle}-m${i}`;
        expected.push(payload);
        q.send(payload);
      }
      s.setBufferedAmount(0);
      q.flush();
      s.setBufferedAmount(1024 * 1024);
    }
    expect(s.sent).toEqual(expected);
    expect(q.size()).toBe(0);
  });

  it("coalesce keys stay valid across a partial drain (absolute indices)", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s);
    q.send("crit-1");
    q.send("crit-2");
    q.sendRealtime("gps-v1", "gps");

    // Partial drain: socket frees for exactly two writes, then chokes again.
    let writes = 0;
    s.send.mockImplementation((msg: string) => {
      s.sent.push(msg);
      writes += 1;
      if (writes === 2) s.setBufferedAmount(1024 * 1024);
    });
    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["crit-1", "crit-2"]);

    // The gps entry is still queued behind the advanced head — its
    // coalesce index must still resolve so this replaces, not appends.
    q.sendRealtime("gps-v2", "gps");
    expect(q.size()).toBe(1);

    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["crit-1", "crit-2", "gps-v2"]);
  });

  it("shed-on-overflow accounts for the drained prefix (size uses head)", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { capacity: 2 });
    // Fill to capacity, drain fully, then verify capacity is AVAILABLE
    // again — a length-based size() would see the stale prefix and
    // terminate/shed incorrectly.
    q.send("a");
    q.send("b");
    s.setBufferedAmount(0);
    q.flush();
    expect(q.size()).toBe(0);

    s.setBufferedAmount(1024 * 1024);
    q.send("c");
    q.send("d");
    expect(s.terminate).not.toHaveBeenCalled();
    expect(q.size()).toBe(2);
  });

  it("compacts the drained prefix and reindexes coalesce keys correctly", () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { capacity: 512 });
    // Drain enough frames to cross the compaction threshold (head ≥ 64).
    for (let i = 0; i < 100; i++) q.send(`m${i}`);
    // Leave one keyed droppable queued behind the prefix.
    q.sendRealtime("gps-v1", "gps");

    let writes = 0;
    s.send.mockImplementation((msg: string) => {
      s.sent.push(msg);
      writes += 1;
      if (writes === 100) s.setBufferedAmount(1024 * 1024); // stop before gps
    });
    s.setBufferedAmount(0);
    q.flush();
    expect(q.size()).toBe(1);

    // Internal invariant: the drained prefix was garbage-collected.
    const internals = q as unknown as { head: number; entries: unknown[] };
    expect(internals.head).toBe(0);
    expect(internals.entries.length).toBe(1);

    // Post-compaction the rebuilt coalesce index must still replace.
    q.sendRealtime("gps-v2", "gps");
    expect(q.size()).toBe(1);
    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent[s.sent.length - 1]).toBe("gps-v2");
  });
});

// ============================================================================
// RoomManager — addressed-send routing
// ============================================================================

describe("RoomManager — sendToPushRef / sendToUser", () => {
  function makeClient(overrides: {
    id: string;
    pushRef: string;
    userId?: string;
    bufferedAmount?: number;
  }) {
    const s = makeSocket({ bufferedAmount: overrides.bufferedAmount });
    const c = {
      id: overrides.id,
      pushRef: overrides.pushRef,
      socket: s,
      subscriptions: new Set<string>(),
      userId: overrides.userId,
      queue: new SendQueue(s),
    };
    return c;
  }

  it("sendToPushRef delivers via the per-connection queue", () => {
    const rm = new RoomManager();
    const c = makeClient({ id: "c1", pushRef: "tab-A" });
    rm.addClient(c);
    expect(rm.sendToPushRef("tab-A", "hi")).toBe(true);
    expect(c.socket.sent).toEqual(["hi"]);
  });

  it("sendToUser fans out to every open tab/device for that user", () => {
    const rm = new RoomManager();
    const c1 = makeClient({ id: "c1", pushRef: "tab-A", userId: "u1" });
    const c2 = makeClient({ id: "c2", pushRef: "tab-B", userId: "u1" });
    const c3 = makeClient({ id: "c3", pushRef: "tab-C", userId: "u2" });
    rm.addClient(c1);
    rm.addClient(c2);
    rm.addClient(c3);
    expect(rm.sendToUser("u1", "hi")).toBe(2);
    expect(c1.socket.sent).toEqual(["hi"]);
    expect(c2.socket.sent).toEqual(["hi"]);
    expect(c3.socket.sent).toEqual([]);
  });

  it("sendRealtimeToUser coalesces independently per connection", () => {
    const rm = new RoomManager();
    const c1 = makeClient({ id: "c1", pushRef: "tab-A", userId: "u1", bufferedAmount: 1e6 });
    const c2 = makeClient({ id: "c2", pushRef: "tab-B", userId: "u1", bufferedAmount: 1e6 });
    rm.addClient(c1);
    rm.addClient(c2);
    rm.sendRealtimeToUser("u1", "v1", "gps");
    rm.sendRealtimeToUser("u1", "v2", "gps");
    expect(c1.queue.size()).toBe(1);
    expect(c2.queue.size()).toBe(1);

    c1.socket.setBufferedAmount(0);
    c1.queue.flush();
    expect(c1.socket.sent).toEqual(["v2"]);
  });

  it("returns false / 0 when the target is unknown", () => {
    const rm = new RoomManager();
    expect(rm.sendToPushRef("nope", "x")).toBe(false);
    expect(rm.sendToUser("nope", "x")).toBe(0);
  });

  it("does not allocate per-connection queues at default capacity beyond 256", () => {
    // Spec guard: default capacity must remain 256 so a stuck connection
    // can't grow unbounded memory before the overflow terminate fires.
    expect(DEFAULT_QUEUE_CAPACITY).toBe(256);
  });
});
