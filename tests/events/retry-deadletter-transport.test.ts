/**
 * `withRetry({ transport })` — auto-route exhausted events to the transport's
 * native deadLetter() hook, no custom $deadLetter plumbing needed.
 *
 * Before: users wired `onDead` + `createDeadLetterPublisher` separately.
 * Now: Kafka / SQS / Streams transports that implement `deadLetter()` get
 * exhausted events wrapped in a `DeadLetteredEvent` envelope automatically.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createEvent,
  type DeadLetteredEvent,
  type EventTransport,
  MemoryEventTransport,
} from "../../src/events/EventTransport.js";
import { withRetry } from "../../src/events/retry.js";

const silentLogger = { warn: () => {}, error: () => {} };

function transportWithDlq() {
  const dlq = vi.fn<(e: DeadLetteredEvent) => Promise<void>>(async () => {});
  const transport = new MemoryEventTransport({ logger: silentLogger }) as EventTransport & {
    deadLetter: typeof dlq;
  };
  transport.deadLetter = dlq;
  return { transport, dlq };
}

describe("withRetry + transport.deadLetter auto-routing", () => {
  it("routes exhausted events to transport.deadLetter()", async () => {
    const { transport, dlq } = transportWithDlq();

    const handler = vi.fn(async () => {
      throw new Error("downstream-503");
    });
    const wrapped = withRetry(handler, {
      maxRetries: 2,
      backoffMs: 1,
      jitter: 0,
      transport,
      logger: silentLogger,
      name: "stripeRefund",
    });

    const event = createEvent(
      "order.refund",
      { orderId: "o1" },
      { idempotencyKey: "refund:o1:1" },
    );
    await wrapped(event);

    expect(handler).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(dlq).toHaveBeenCalledTimes(1);

    const dl = dlq.mock.calls[0]![0];
    expect(dl.event).toBe(event);
    expect(dl.attempts).toBe(3);
    expect(dl.error.message).toBe("downstream-503");
    expect(dl.handlerName).toBe("stripeRefund");
    expect(dl.firstFailedAt).toBeInstanceOf(Date);
    expect(dl.lastFailedAt).toBeInstanceOf(Date);
    expect(dl.lastFailedAt.getTime()).toBeGreaterThanOrEqual(dl.firstFailedAt.getTime());
  });

  it("preserves idempotencyKey on the DLQ envelope so consumers can dedupe replays", async () => {
    const { transport, dlq } = transportWithDlq();

    const wrapped = withRetry(async () => {
      throw new Error("boom");
    }, { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger });

    await wrapped(createEvent("x", {}, { idempotencyKey: "ik-42" }));

    expect(dlq.mock.calls[0]![0].event.meta.idempotencyKey).toBe("ik-42");
  });

  it("transport.deadLetter() is called in addition to onDead when both are set", async () => {
    const { transport, dlq } = transportWithDlq();
    const onDead = vi.fn(async () => {});

    const wrapped = withRetry(async () => {
      throw new Error("boom");
    }, { maxRetries: 0, backoffMs: 1, transport, onDead, logger: silentLogger });

    await wrapped(createEvent("x", {}));

    expect(dlq).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("no transport, no onDead: silently exhausts (existing behaviour)", async () => {
    const wrapped = withRetry(async () => {
      throw new Error("boom");
    }, { maxRetries: 0, backoffMs: 1, logger: silentLogger });

    // Must not throw — the retry wrapper swallows after logging.
    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("transport without a deadLetter() method is ignored (no crash)", async () => {
    const transport = new MemoryEventTransport({ logger: silentLogger }); // no deadLetter
    const wrapped = withRetry(async () => {
      throw new Error("boom");
    }, { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger });

    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("transport.deadLetter() throwing does not break the handler loop", async () => {
    const transport = new MemoryEventTransport({ logger: silentLogger }) as EventTransport & {
      deadLetter: (e: DeadLetteredEvent) => Promise<void>;
    };
    transport.deadLetter = async () => {
      throw new Error("dlq-down");
    };

    const wrapped = withRetry(async () => {
      throw new Error("boom");
    }, { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger });

    // Must not propagate the DLQ failure
    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("success on first attempt: deadLetter() never called", async () => {
    const { transport, dlq } = transportWithDlq();

    const wrapped = withRetry(async () => {
      /* ok */
    }, { maxRetries: 3, backoffMs: 1, transport, logger: silentLogger });

    await wrapped(createEvent("x", {}));
    expect(dlq).not.toHaveBeenCalled();
  });

  it("success after one retry: deadLetter() not called", async () => {
    const { transport, dlq } = transportWithDlq();
    let calls = 0;

    const wrapped = withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("flaky");
    }, { maxRetries: 3, backoffMs: 1, transport, logger: silentLogger });

    await wrapped(createEvent("x", {}));
    expect(calls).toBe(2);
    expect(dlq).not.toHaveBeenCalled();
  });
});
