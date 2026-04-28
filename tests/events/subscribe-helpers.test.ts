/**
 * Tests for the subscribe-side symmetry helpers added in 2.11.3.
 *
 * Three exports:
 *   - `wrapWithSchema` / `subscribeWithSchema` — validate `event.payload`
 *     against the definition's schema before invoking the handler. Closes
 *     the gap where 19 be-prod handlers carried parallel Zod schemas just
 *     to narrow the payload type.
 *   - `wrapWithBoundary` / `subscribeWithBoundary` — catch + log + swallow
 *     for projection / cache-invalidation handlers where retry would just
 *     delay the next-event resync.
 *   - `PayloadOf<D>` — compile-time payload extractor.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineEvent } from "../../src/events/defineEvent.js";
import { createEvent, type DomainEvent, type EventLogger } from "../../src/events/EventTransport.js";
import {
  type PayloadOf,
  subscribeWithBoundary,
  subscribeWithSchema,
  wrapWithBoundary,
  wrapWithSchema,
} from "../../src/events/subscribe-helpers.js";
import { withRetry } from "../../src/events/retry.js";

// ---------- Test fixtures ----------

const OrderPaid = defineEvent<{ orderId: string; total: number }>({
  name: "order.paid",
  schema: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      total: { type: "number" },
    },
    required: ["orderId", "total"],
  },
});

/**
 * Captures logger calls so the test can assert structured-error semantics
 * without the noise of `console` reaching stdout. Matches the `EventLogger`
 * contract: `(message, ...args)`.
 */
function spyLogger(): EventLogger & { warns: unknown[][]; errors: unknown[][] } {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    warns,
    errors,
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
    error: (...args: unknown[]) => {
      errors.push(args);
    },
  };
}

/** Bare in-memory event bus matching the structural type the helpers need. */
function fakeBus() {
  const subs: Array<{ pattern: string; handler: (e: DomainEvent) => void | Promise<void> }> = [];
  return {
    subs,
    events: {
      subscribe: async (pattern: string, handler: (e: DomainEvent) => void | Promise<void>) => {
        subs.push({ pattern, handler });
        return () => {
          const i = subs.findIndex((s) => s.handler === handler);
          if (i >= 0) subs.splice(i, 1);
        };
      },
    },
  };
}

// ============================================================================
// PayloadOf<D> — compile-time inference
// ============================================================================

describe("PayloadOf<D>", () => {
  it("extracts the payload type from an EventDefinitionOutput", () => {
    type Inferred = PayloadOf<typeof OrderPaid>;
    expectTypeOf<Inferred>().toEqualTypeOf<{ orderId: string; total: number }>();
  });

  it("resolves to never for non-definition types", () => {
    type NotAnEventDef = { foo: 'bar' };
    type Inferred = PayloadOf<NotAnEventDef>;
    expectTypeOf<Inferred>().toEqualTypeOf<never>();
  });
});

describe("withRetry<T> + wrapWithSchema<T> — cast-free compose (2.11.3 generic fix)", () => {
  it("threads payload type through retry into wrapWithSchema without explicit casts", () => {
    type OrderPaidPayload = PayloadOf<typeof OrderPaid>;

    // Inner handler typed against the payload — what every host wants to write.
    const inner = async (event: DomainEvent<OrderPaidPayload>): Promise<void> => {
      // Compile-time: event.payload.orderId / event.payload.total are typed.
      void event.payload.orderId;
      void event.payload.total;
    };

    // Pre-2.11.3 this would have erased to `EventHandler<unknown>`, forcing
    // `wrapWithSchema(OrderPaid, retried as EventHandler<OrderPaidPayload>)`.
    // After the generic widen, T flows through both wrappers.
    const retried = withRetry(inner, { maxRetries: 1, backoffMs: 1, jitter: 0 });
    expectTypeOf(retried).parameter(0).toEqualTypeOf<DomainEvent<OrderPaidPayload>>();

    // Compose into the schema wrapper — still no cast.
    const wrapped = wrapWithSchema(OrderPaid, retried);
    expectTypeOf(wrapped).parameter(0).toEqualTypeOf<DomainEvent<unknown>>();
  });
});

// ============================================================================
// wrapWithSchema — handler-wrapper form
// ============================================================================

describe("wrapWithSchema", () => {
  it("invokes the handler when the payload matches the schema (typed)", async () => {
    const handler = vi.fn(async (event: DomainEvent<PayloadOf<typeof OrderPaid>>) => {
      // Compile-time: payload is { orderId: string; total: number }. No cast.
      expect(event.payload.orderId).toBe("ord-1");
      expect(event.payload.total).toBe(100);
    });

    const wrapped = wrapWithSchema(OrderPaid, handler);
    await wrapped(createEvent("order.paid", { orderId: "ord-1", total: 100 }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips the handler and logs when the payload fails validation (default behaviour)", async () => {
    const logger = spyLogger();
    const handler = vi.fn();

    const wrapped = wrapWithSchema(OrderPaid, handler, { logger });
    // Missing `total` — required field.
    await wrapped(createEvent("order.paid", { orderId: "ord-1" } as unknown as PayloadOf<typeof OrderPaid>));

    expect(handler).not.toHaveBeenCalled();
    expect(logger.warns.length).toBe(1);
    expect(logger.warns[0]?.[0]).toMatch(/payload failed validation/);
    expect(logger.warns[0]?.[0]).toMatch(/total/);
  });

  it("calls onInvalid (with the raw event + errors) instead of logging when supplied", async () => {
    const onInvalid = vi.fn();
    const handler = vi.fn();

    const wrapped = wrapWithSchema(OrderPaid, handler, { onInvalid });
    const badEvent = createEvent("order.paid", { orderId: 1 } as unknown as PayloadOf<
      typeof OrderPaid
    >);
    await wrapped(badEvent);

    expect(handler).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    const [eventArg, errorsArg] = onInvalid.mock.calls[0]!;
    expect(eventArg).toBe(badEvent);
    expect(Array.isArray(errorsArg)).toBe(true);
    expect((errorsArg as string[]).join(" ")).toMatch(/total/);
  });

  it("uses the explicit `validate` option when provided (overrides built-in)", async () => {
    const customValidate = vi.fn(() => ({ valid: false, errors: ["custom rule failed"] }));
    const onInvalid = vi.fn();
    const handler = vi.fn();

    const wrapped = wrapWithSchema(OrderPaid, handler, {
      validate: customValidate,
      onInvalid,
    });
    await wrapped(createEvent("order.paid", { orderId: "ord-1", total: 100 }));

    expect(customValidate).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith(expect.anything(), ["custom rule failed"]);
  });

  it("passes through when the definition has no schema declared", async () => {
    const Schemaless = defineEvent<{ foo: string }>({ name: "schemaless" });
    const handler = vi.fn();

    const wrapped = wrapWithSchema(Schemaless, handler);
    await wrapped(createEvent("schemaless", { foo: "bar" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("composes with withRetry — schema check runs first, retry kicks in only on handler failure", async () => {
    let attempts = 0;
    const handler = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    });

    const wrapped = wrapWithSchema(
      OrderPaid,
      withRetry(handler, { maxRetries: 2, backoffMs: 1, jitter: 0, logger: spyLogger() }),
    );
    await wrapped(createEvent("order.paid", { orderId: "ord-1", total: 100 }));

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// subscribeWithSchema — convenience caller
// ============================================================================

describe("subscribeWithSchema", () => {
  it("subscribes against `definition.name` with the wrapped handler", async () => {
    const bus = fakeBus();
    const handler = vi.fn();

    await subscribeWithSchema(bus, OrderPaid, handler);

    expect(bus.subs).toHaveLength(1);
    expect(bus.subs[0]?.pattern).toBe("order.paid");

    // Invoke the registered handler — should reach the user's handler when
    // payload is valid, and skip when it isn't (single integration assertion).
    await bus.subs[0]?.handler(createEvent("order.paid", { orderId: "ord-1", total: 100 }));
    expect(handler).toHaveBeenCalledTimes(1);

    await bus.subs[0]?.handler(
      createEvent("order.paid", { orderId: "ord-1" } as unknown as PayloadOf<typeof OrderPaid>),
    );
    expect(handler).toHaveBeenCalledTimes(1); // unchanged — invalid payload skipped
  });

  it("returns the unsubscribe function from the underlying transport", async () => {
    const bus = fakeBus();
    const unsub = await subscribeWithSchema(bus, OrderPaid, vi.fn());

    expect(typeof unsub).toBe("function");
    expect(bus.subs).toHaveLength(1);
    unsub();
    expect(bus.subs).toHaveLength(0);
  });
});

// ============================================================================
// wrapWithBoundary / subscribeWithBoundary
// ============================================================================

describe("wrapWithBoundary", () => {
  it("invokes the handler normally when it doesn't throw", async () => {
    const handler = vi.fn();
    const wrapped = wrapWithBoundary(handler);
    await wrapped(createEvent("anything", {}));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("catches handler exceptions and logs them — does NOT rethrow", async () => {
    const logger = spyLogger();
    const wrapped = wrapWithBoundary(
      async () => {
        throw new Error("kaboom");
      },
      { logger },
    );

    // Critical: must not throw — that's the whole point of the boundary.
    await expect(wrapped(createEvent("projection.update", { id: "x" }))).resolves.toBeUndefined();
    expect(logger.errors.length).toBe(1);
    expect(logger.errors[0]?.[0]).toMatch(/projection\.update/);
    expect(logger.errors[0]?.[0]).toMatch(/kaboom/);
  });

  it("calls onError instead of the default log when supplied", async () => {
    const onError = vi.fn();
    const wrapped = wrapWithBoundary(
      async () => {
        throw new Error("kaboom");
      },
      { onError },
    );
    const event = createEvent("projection.update", { id: "x" });

    await wrapped(event);

    expect(onError).toHaveBeenCalledTimes(1);
    const [errArg, eventArg] = onError.mock.calls[0]!;
    expect((errArg as Error).message).toBe("kaboom");
    expect(eventArg).toBe(event);
  });

  it("does NOT swallow errors from onError (logs them — host's bug, not ours to silently eat)", async () => {
    const logger = spyLogger();
    const wrapped = wrapWithBoundary(
      async () => {
        throw new Error("handler-error");
      },
      {
        logger,
        onError: () => {
          throw new Error("metrics-down");
        },
      },
    );

    await expect(wrapped(createEvent("x", {}))).resolves.toBeUndefined();
    // The onError-callback failure is logged separately so the host can debug
    // a broken metrics pipeline without losing the original handler error.
    expect(logger.errors.length).toBe(1);
    expect(logger.errors[0]?.[0]).toMatch(/onError callback threw/);
  });

  // Note: composing wrapWithBoundary(withRetry(...)) is redundant because
  // withRetry already swallows terminal failures (logs + optional onDead /
  // transport.deadLetter, never rethrows). Boundary is the right tool when
  // you want NO retries — projection / cache-invalidation handlers where
  // the next event will resync anyway. See wrapWithSchema's compose test
  // for the realistic schema+retry pipeline.
});

describe("subscribeWithBoundary", () => {
  it("subscribes against the pattern with the boundary-wrapped handler", async () => {
    const bus = fakeBus();
    const handler = vi.fn(async () => {
      throw new Error("would normally poison the bus");
    });

    await subscribeWithBoundary(bus, "product.*", handler);

    expect(bus.subs).toHaveLength(1);
    expect(bus.subs[0]?.pattern).toBe("product.*");

    // Bus delivers — handler throws — boundary swallows.
    await expect(
      bus.subs[0]?.handler(createEvent("product.changed", {})),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
