/**
 * `withRetry({ transport })` — auto-route exhausted events to the transport's
 * native deadLetter() hook, no custom $deadLetter plumbing needed.
 *
 * Before: users wired `onDead` + `createDeadLetterPublisher` separately.
 * Now: Kafka / SQS / Streams transports that implement `deadLetter()` get
 * exhausted events wrapped in a `DeadLetteredEvent` envelope automatically.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvent,
  type DeadLetteredEvent,
  type DomainEvent,
  type EventHandler,
  type EventTransport,
  MemoryEventTransport,
} from "../../src/events/EventTransport.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";
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

    const event = createEvent("order.refund", { orderId: "o1" }, { idempotencyKey: "refund:o1:1" });
    await wrapped(event);

    expect(handler).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(dlq).toHaveBeenCalledTimes(1);

    const dl = dlq.mock.calls[0]?.[0];
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

    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger },
    );

    await wrapped(createEvent("x", {}, { idempotencyKey: "ik-42" }));

    expect(dlq.mock.calls[0]?.[0].event.meta.idempotencyKey).toBe("ik-42");
  });

  it("transport.deadLetter() is called in addition to onDead when both are set", async () => {
    const { transport, dlq } = transportWithDlq();
    const onDead = vi.fn(async () => {});

    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 0, backoffMs: 1, transport, onDead, logger: silentLogger },
    );

    await wrapped(createEvent("x", {}));

    expect(dlq).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("no transport, no onDead: silently exhausts (existing behaviour)", async () => {
    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 0, backoffMs: 1, logger: silentLogger },
    );

    // Must not throw — the retry wrapper swallows after logging.
    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("transport without a deadLetter() method is ignored (no crash)", async () => {
    const transport = new MemoryEventTransport({ logger: silentLogger }); // no deadLetter
    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger },
    );

    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("transport.deadLetter() failing RETHROWS by default — the transport must redeliver, not ack a lost event", async () => {
    // Pre-2.24 this logged and returned: the transport saw a successful
    // handler and ACKNOWLEDGED the message even though neither processing
    // nor DLQ persistence succeeded — silent event loss (wave-6 audit).
    const transport = new MemoryEventTransport({ logger: silentLogger }) as EventTransport & {
      deadLetter: (e: DeadLetteredEvent) => Promise<void>;
    };
    transport.deadLetter = async () => {
      throw new Error("dlq-down");
    };

    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger },
    );

    await expect(wrapped(createEvent("x", {}))).rejects.toThrow(/dead-letter persistence failed/);
  });

  it("dlqFailureMode: 'log-and-drop' opts into the old swallow behavior", async () => {
    const transport = new MemoryEventTransport({ logger: silentLogger }) as EventTransport & {
      deadLetter: (e: DeadLetteredEvent) => Promise<void>;
    };
    transport.deadLetter = async () => {
      throw new Error("dlq-down");
    };

    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      {
        maxRetries: 0,
        backoffMs: 1,
        transport,
        dlqFailureMode: "log-and-drop",
        logger: silentLogger,
      },
    );

    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("successful DLQ persistence still resolves normally (event acked as dead-lettered)", async () => {
    const { transport } = transportWithDlq();
    const wrapped = withRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 0, backoffMs: 1, transport, logger: silentLogger },
    );
    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
  });

  it("success on first attempt: deadLetter() never called", async () => {
    const { transport, dlq } = transportWithDlq();

    const wrapped = withRetry(
      async () => {
        /* ok */
      },
      { maxRetries: 3, backoffMs: 1, transport, logger: silentLogger },
    );

    await wrapped(createEvent("x", {}));
    expect(dlq).not.toHaveBeenCalled();
  });

  it("success after one retry: deadLetter() not called", async () => {
    const { transport, dlq } = transportWithDlq();
    let calls = 0;

    const wrapped = withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("flaky");
      },
      { maxRetries: 3, backoffMs: 1, transport, logger: silentLogger },
    );

    await wrapped(createEvent("x", {}));
    expect(calls).toBe(2);
    expect(dlq).not.toHaveBeenCalled();
  });
});

// ============================================================================
// eventPlugin wiring — durable DLQ slot end-to-end
// ============================================================================

describe("eventPlugin — durable DLQ failure propagation", () => {
  // `deadLetterQueue.store` rides withRetry's durable `deadLetter` slot: a
  // failing store follows dlqFailureMode (rethrow default) so an
  // at-least-once transport redelivers instead of acking a lost event.
  // `onDead` stays observability-only. Tested through eventPlugin with a
  // transport that PROPAGATES handler failures to publish (models ack
  // semantics — MemoryEventTransport logs-and-swallows, which would hide
  // exactly the behavior under test).
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  function propagatingTransport() {
    const handlers: EventHandler[] = [];
    return {
      name: "test-propagating",
      publish: async (event: DomainEvent) => {
        for (const h of handlers) await h(event);
      },
      subscribe: async (_pattern: string, handler: EventHandler) => {
        handlers.push(handler);
        return () => {};
      },
    };
  }

  async function buildApp(opts: Record<string, unknown>) {
    app = Fastify({ logger: false });
    await app.register(eventPlugin, { transport: propagatingTransport(), ...opts });
    await app.ready();
    return app;
  }

  const failingHandler = async () => {
    throw new Error("handler-down");
  };

  it("a failing deadLetterQueue.store makes the wrapped handler THROW", async () => {
    await buildApp({
      failOpen: false,
      retry: { maxRetries: 0, backoffMs: 1 },
      deadLetterQueue: {
        store: async () => {
          throw new Error("dlq-store-down");
        },
      },
    });
    await app.events.subscribe("order.created", failingHandler);

    await expect(app.events.publish("order.created", {})).rejects.toThrow(
      /dead-letter persistence failed/,
    );
  });

  it("a working deadLetterQueue.store is called and the event acks normally", async () => {
    const store = vi.fn(async () => {});
    await buildApp({
      failOpen: false,
      retry: { maxRetries: 0, backoffMs: 1 },
      deadLetterQueue: { store },
    });
    await app.events.subscribe("order.created", failingHandler);

    await expect(app.events.publish("order.created", {})).resolves.toBeUndefined();
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("dlqFailureMode: 'log-and-drop' opts into acknowledging despite store failure", async () => {
    await buildApp({
      failOpen: false,
      retry: { maxRetries: 0, backoffMs: 1, dlqFailureMode: "log-and-drop" },
      deadLetterQueue: {
        store: async () => {
          throw new Error("dlq-store-down");
        },
      },
    });
    await app.events.subscribe("order.created", failingHandler);

    await expect(app.events.publish("order.created", {})).resolves.toBeUndefined();
  });

  it("user onDead observability still fires; its failure never affects acknowledgement", async () => {
    const onDead = vi.fn(() => {
      throw new Error("metrics-down");
    });
    const store = vi.fn(async () => {});
    await buildApp({
      failOpen: false,
      retry: { maxRetries: 0, backoffMs: 1, onDead },
      deadLetterQueue: { store },
    });
    await app.events.subscribe("order.created", failingHandler);

    await expect(app.events.publish("order.created", {})).resolves.toBeUndefined();
    expect(store).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });
});
