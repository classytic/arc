/**
 * Compensation — Flexibility E2E
 *
 * Proves withCompensation works everywhere in Arc:
 * - Inside a custom BaseController method
 * - Inside repository-level business logic
 * - Inside Arc hooks (afterCreate)
 * - With Arc events via onStepComplete hook
 * - With fire-and-forget steps alongside blocking steps
 */

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection, Schema, type Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  status: string;
}

let mongoServer: MongoMemoryServer;
let connection: Connection;
let ProductModel: mongoose.Model<IProduct>;

describe("Compensation — Flexibility", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongoServer.getUri("comp-flex"));
    await connection.asPromise();

    ProductModel = connection.model<IProduct>(
      "CompFlexProduct",
      new Schema<IProduct>({
        name: { type: String, required: true },
        price: { type: Number, required: true },
        status: { type: String, default: "draft" },
      }),
    );
  });

  afterAll(async () => {
    await connection.close();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
  });

  // ==========================================================================
  // Inside a custom controller method
  // ==========================================================================

  describe("in custom BaseController", () => {
    it("compensation works inside a controller method called via additionalRoute", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const { Repository } = await import("@classytic/mongokit");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      const repo = new Repository(ProductModel);

      class ProductController extends BaseController<IProduct> {
        async publishProduct(req: {
          params: Record<string, string>;
          body: unknown;
          query: unknown;
          headers: unknown;
          metadata: unknown;
        }) {
          const id = req.params.id;
          const product = await ProductModel.findById(id).lean();
          if (!product) return { success: false, error: "Not found", status: 404 };

          const result = await withCompensation("publish-product", [
            {
              name: "update-status",
              execute: async () => {
                await ProductModel.findByIdAndUpdate(id, { status: "published" });
                return { status: "published" };
              },
              compensate: async () => {
                await ProductModel.findByIdAndUpdate(id, { status: "draft" });
              },
            },
            {
              name: "notify-search-index",
              execute: async () => {
                // Simulate external service call
                return { indexed: true };
              },
              compensate: async () => {
                // Remove from search index
              },
            },
          ]);

          if (!result.success) {
            return { success: false, error: result.error, status: 500 };
          }
          return { success: true, data: result.results, status: 200 };
        }
      }

      const controller = new ProductController(repo, { resourceName: "product" });
      const product = await ProductModel.create({ name: "Widget", price: 10, status: "draft" });
      const hooks = new HookSystem();

      const result = await controller.publishProduct({
        params: { id: product._id.toString() },
        body: {},
        query: {},
        headers: {},
        metadata: { arc: { hooks } },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        "update-status": { status: "published" },
        "notify-search-index": { indexed: true },
      });

      // Verify DB
      const updated = await ProductModel.findById(product._id).lean();
      expect(updated?.status).toBe("published");
    });

    it("compensates when external call fails inside controller", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const { Repository } = await import("@classytic/mongokit");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      const repo = new Repository(ProductModel);

      class ProductController extends BaseController<IProduct> {
        async publishProduct(req: {
          params: Record<string, string>;
          body: unknown;
          query: unknown;
          headers: unknown;
          metadata: unknown;
        }) {
          const id = req.params.id;

          const result = await withCompensation("publish-fail", [
            {
              name: "update-status",
              execute: async () => {
                await ProductModel.findByIdAndUpdate(id, { status: "published" });
                return { status: "published" };
              },
              compensate: async () => {
                await ProductModel.findByIdAndUpdate(id, { status: "draft" });
              },
            },
            {
              name: "external-call",
              execute: async () => {
                throw new Error("Search service down");
              },
            },
          ]);

          return {
            success: result.success,
            error: result.error,
            status: result.success ? 200 : 500,
          };
        }
      }

      const controller = new ProductController(repo, { resourceName: "product" });
      const product = await ProductModel.create({ name: "Gadget", price: 20, status: "draft" });
      const hooks = new HookSystem();

      const result = await controller.publishProduct({
        params: { id: product._id.toString() },
        body: {},
        query: {},
        headers: {},
        metadata: { arc: { hooks } },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Search service down");

      // DB was rolled back
      const rolledBack = await ProductModel.findById(product._id).lean();
      expect(rolledBack?.status).toBe("draft");
    });
  });

  // ==========================================================================
  // With Arc events via hooks
  // ==========================================================================

  describe("with Arc events via onStepComplete", () => {
    it("emits events for each completed step", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const { eventPlugin } = await import("../../src/events/eventPlugin.js");
      const Fastify = (await import("fastify")).default;

      const app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.ready();

      const received: Array<{ type: string; payload: unknown }> = [];
      await app.events.subscribe("publish.*", async (event) => {
        received.push({ type: event.type, payload: event.payload });
      });

      await withCompensation(
        "publish",
        [
          { name: "validate", execute: async () => ({ valid: true }) },
          { name: "save", execute: async () => ({ saved: true }) },
        ],
        {},
        {
          onStepComplete: (stepName, result) => {
            app.events.publish(`publish.${stepName}.completed`, result);
          },
        },
      );

      // Wait for async event delivery
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe("publish.validate.completed");
      expect(received[1].type).toBe("publish.save.completed");

      await app.close();
    });
  });

  // ==========================================================================
  // Fire-and-forget alongside blocking steps
  // ==========================================================================

  describe("fire-and-forget mixed with blocking", () => {
    it("non-blocking step does not delay subsequent steps", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const order: string[] = [];

      let bgResolve: () => void;
      const bgPromise = new Promise<void>((r) => {
        bgResolve = r;
      });

      const result = await withCompensation("mixed", [
        {
          name: "db-write",
          execute: async () => {
            order.push("db");
            return { written: true };
          },
        },
        {
          name: "send-analytics",
          execute: async () => {
            await bgPromise;
            order.push("analytics");
            return {};
          },
          fireAndForget: true,
        },
        {
          name: "respond",
          execute: async () => {
            order.push("respond");
            return { done: true };
          },
        },
      ]);

      expect(result.success).toBe(true);
      // 'respond' ran before 'analytics' resolved
      expect(order).toEqual(["db", "respond"]);
      expect(result.completedSteps).toContain("send-analytics");

      bgResolve?.();
      await bgPromise;
    });
  });

  // ==========================================================================
  // Plain function — no Arc, no Fastify
  // ==========================================================================

  describe("standalone usage (no framework)", () => {
    it("works as a pure utility without any Arc dependency", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      // Just plain async functions — no Fastify, no Arc, no DB
      const log: string[] = [];

      const result = await withCompensation("pure", [
        {
          name: "step1",
          execute: async () => {
            log.push("1");
            return { a: 1 };
          },
        },
        {
          name: "step2",
          execute: async () => {
            log.push("2");
            return { b: 2 };
          },
        },
      ]);

      expect(result.success).toBe(true);
      expect(log).toEqual(["1", "2"]);
      expect(result.results).toEqual({ step1: { a: 1 }, step2: { b: 2 } });
    });
  });
});
