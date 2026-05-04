/**
 * Compensating Transaction Tests
 *
 * Verifies withCompensation: forward execution, reverse rollback,
 * context passing, error collection, and real-world usage in a
 * Fastify route handler (additionalRoute pattern).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("withCompensation", () => {
  // ==========================================================================
  // Forward execution
  // ==========================================================================

  describe("forward execution", () => {
    it("runs all steps in order and returns success", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const order: string[] = [];

      const result = await withCompensation("order-flow", [
        {
          name: "step-1",
          execute: async () => {
            order.push("1");
            return { reserved: true };
          },
        },
        {
          name: "step-2",
          execute: async () => {
            order.push("2");
            return { charged: true };
          },
        },
        {
          name: "step-3",
          execute: async () => {
            order.push("3");
            return { sent: true };
          },
        },
      ]);

      expect(result.completedSteps).toEqual(["step-1", "step-2", "step-3"]);
      expect(result.results).toEqual({
        "step-1": { reserved: true },
        "step-2": { charged: true },
        "step-3": { sent: true },
      });
      expect(order).toEqual(["1", "2", "3"]);
    });

    it("passes mutable context between steps", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      const result = await withCompensation("ctx-test", [
        {
          name: "create-order",
          execute: async (ctx) => {
            ctx.orderId = "ord-123";
            return { orderId: "ord-123" };
          },
        },
        {
          name: "charge",
          execute: async (ctx) => ({ charged: ctx.orderId }),
        },
      ]);

      expect(result.results.charge).toEqual({ charged: "ord-123" });
    });

    it("accepts initial context", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      const result = await withCompensation(
        "init-ctx",
        [{ name: "use-it", execute: async (ctx) => ({ userId: ctx.userId }) }],
        { userId: "u-1" },
      );

      expect(result.results["use-it"]).toEqual({ userId: "u-1" });
    });

    it("empty steps returns success", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      const result = await withCompensation("empty", []);
      expect(result.completedSteps).toEqual([]);
    });
  });

  // ==========================================================================
  // Compensation on failure
  // ==========================================================================

  describe("compensation on failure", () => {
    it("runs compensate in reverse for completed steps", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const compensated: string[] = [];

      const result = await withCompensation("failing", [
        {
          name: "reserve",
          execute: async () => ({ reserved: true }),
          compensate: async () => {
            compensated.push("unreserve");
          },
        },
        {
          name: "charge",
          execute: async () => ({ charged: true }),
          compensate: async () => {
            compensated.push("refund");
          },
        },
        {
          name: "ship",
          execute: async () => {
            throw new Error("Warehouse offline");
          },
        },
      ]);

      expect(result.failedStep).toBe("ship");
      expect(result.error).toBe("Warehouse offline");
      expect(compensated).toEqual(["refund", "unreserve"]);
    });

    it("first step failure means no compensation", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const spy = vi.fn();

      const result = await withCompensation("first-fail", [
        {
          name: "boom",
          execute: async () => {
            throw new Error("boom");
          },
          compensate: spy,
        },
        { name: "never", execute: async () => ({}) },
      ]);

      expect(result.completedSteps).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it("steps without compensate are skipped in rollback", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const compensated: string[] = [];

      await withCompensation("partial", [
        {
          name: "s1",
          execute: async () => ({}),
          compensate: async () => {
            compensated.push("c1");
          },
        },
        { name: "s2-no-comp", execute: async () => ({}) },
        {
          name: "s3-fails",
          execute: async () => {
            throw new Error("fail");
          },
        },
      ]);

      expect(compensated).toEqual(["c1"]);
    });

    it("passes step result to compensate function", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      let compensateData: unknown;

      await withCompensation("comp-data", [
        {
          name: "reserve",
          execute: async () => ({ reservationId: "res-42" }),
          compensate: async (_ctx, result) => {
            compensateData = result;
          },
        },
        {
          name: "fail",
          execute: async () => {
            throw new Error("fail");
          },
        },
      ]);

      expect(compensateData).toEqual({ reservationId: "res-42" });
    });

    it("collects compensation errors without stopping rollback", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const compensated: string[] = [];

      const result = await withCompensation("comp-errors", [
        {
          name: "s1",
          execute: async () => ({}),
          compensate: async () => {
            compensated.push("c1");
          },
        },
        {
          name: "s2",
          execute: async () => ({}),
          compensate: async () => {
            throw new Error("comp-2 failed");
          },
        },
        {
          name: "s3",
          execute: async () => {
            throw new Error("original");
          },
        },
      ]);

      expect(compensated).toEqual(["c1"]);
      expect(result.compensationErrors).toHaveLength(1);
      expect(result.compensationErrors?.[0]).toEqual({ step: "s2", error: "comp-2 failed" });
    });

    it("captures non-Error throws", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      const result = await withCompensation("string-throw", [
        {
          name: "bad",
          execute: async () => {
            throw "string error";
          },
        },
      ]);

      expect(result.error).toBe("string error");
    });
  });

  // ==========================================================================
  // defineCompensation (reusable)
  // ==========================================================================

  describe("defineCompensation", () => {
    it("creates reusable definition callable multiple times", async () => {
      const { defineCompensation } = await import("../../src/utils/compensation.js");

      const checkout = defineCompensation("checkout", [
        { name: "validate", execute: async (ctx) => ({ valid: !!ctx.items }) },
        { name: "save", execute: async () => ({ saved: true }) },
      ]);

      expect(checkout.name).toBe("checkout");

      const r1 = await checkout.execute({ items: ["a"] });

      const r2 = await checkout.execute({ items: ["b"] });
    });
  });

  // ==========================================================================
  // Real-world: used inside a Fastify route handler
  // ==========================================================================

  describe("usage in Fastify additionalRoute", () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close().catch(() => {});
    });

    it("handles successful multi-step checkout in a route", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      app = Fastify({ logger: false });

      app.post("/checkout", async (request, reply) => {
        const body = request.body as { items: string[]; total: number };

        const result = await withCompensation(
          "checkout",
          [
            {
              name: "reserve",
              execute: async (ctx) => {
                ctx.reservationId = "res-001";
                return { reservationId: "res-001" };
              },
              compensate: async () => {
                /* release inventory */
              },
            },
            {
              name: "charge",
              execute: async () => ({ chargeId: "ch-001", amount: body.total }),
              compensate: async () => {
                /* refund */
              },
            },
            {
              name: "confirm",
              execute: async (ctx) => ({ orderId: `ord-${ctx.reservationId}` }),
            },
          ],
          { items: body.items, total: body.total },
        );

        if (!result.success) {
          return reply.code(500).send({
            code: "arc.internal_error",
            message: `Checkout failed at ${result.failedStep}: ${result.error}`,
            status: 500,
          });
        }

        return reply.code(201).send(result.results);
      });

      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/checkout",
        payload: { items: ["widget-1", "gadget-2"], total: 99 },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.reserve).toEqual({ reservationId: "res-001" });
      expect(body.charge).toEqual({ chargeId: "ch-001", amount: 99 });
      expect(body.confirm).toEqual({ orderId: "ord-res-001" });
    });

    it("returns 500 with compensation details when step fails", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const compensated: string[] = [];

      app = Fastify({ logger: false });

      app.post("/checkout", async (_request, reply) => {
        const result = await withCompensation("checkout", [
          {
            name: "reserve",
            execute: async () => ({ reserved: true }),
            compensate: async () => {
              compensated.push("unreserved");
            },
          },
          {
            name: "charge",
            execute: async () => {
              throw new Error("Card declined");
            },
            compensate: async () => {
              compensated.push("refunded");
            },
          },
        ]);

        if (!result.success) {
          return reply.code(500).send({
            code: "arc.internal_error",
            message: `${result.failedStep}: ${result.error}`,
            status: 500,
            compensated: result.completedSteps,
          });
        }

        return result.results;
      });

      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/checkout",
        payload: {},
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("charge: Card declined");
      expect(body.compensated).toEqual(["reserve"]);

      // Compensation actually ran
      expect(compensated).toEqual(["unreserved"]);
    });

    it("works with async external service calls (mocked)", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      // Mock external services
      const inventoryService = {
        reserve: vi.fn().mockResolvedValue({ id: "inv-1", units: 5 }),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const paymentService = {
        charge: vi.fn().mockResolvedValue({ chargeId: "ch-1" }),
        refund: vi.fn().mockResolvedValue(undefined),
      };

      app = Fastify({ logger: false });

      app.post("/order", async (request) => {
        const { items, total } = request.body as { items: string[]; total: number };

        const result = await withCompensation(
          "order",
          [
            {
              name: "inventory",
              execute: async (ctx) => {
                const res = await inventoryService.reserve(items);
                ctx.inventoryId = res.id;
                return res;
              },
              compensate: async (_ctx, res) => {
                await inventoryService.release((res as { id: string }).id);
              },
            },
            {
              name: "payment",
              execute: async () => await paymentService.charge(total),
              compensate: async (_ctx, res) => {
                await paymentService.refund((res as { chargeId: string }).chargeId);
              },
            },
          ],
          { items, total },
        );

        return { success: result.success, data: result.results };
      });

      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/order",
        payload: { items: ["a"], total: 50 },
      });

      const body = JSON.parse(res.body);
      expect(inventoryService.reserve).toHaveBeenCalledWith(["a"]);
      expect(paymentService.charge).toHaveBeenCalledWith(50);
      expect(inventoryService.release).not.toHaveBeenCalled();
      expect(paymentService.refund).not.toHaveBeenCalled();
    });
  });
});
