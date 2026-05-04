/**
 * Compensation — Hooks, Events, Fire-and-Forget Tests
 *
 * Verifies:
 * - onStepComplete / onStepFailed / onCompensate hooks
 * - Fire-and-forget steps (fireAndForget: true — don't block, don't compensate)
 * - Integration with Arc events via hooks
 */

import { describe, expect, it, vi } from "vitest";

describe("withCompensation — hooks & fire-and-forget", () => {
  // ==========================================================================
  // Lifecycle hooks
  // ==========================================================================

  describe("lifecycle hooks", () => {
    it("calls onStepComplete after each successful step", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const onStepComplete = vi.fn();

      await withCompensation(
        "test",
        [
          { name: "a", execute: async () => ({ id: 1 }) },
          { name: "b", execute: async () => ({ id: 2 }) },
        ],
        {},
        { onStepComplete },
      );

      expect(onStepComplete).toHaveBeenCalledTimes(2);
      expect(onStepComplete).toHaveBeenCalledWith("a", { id: 1 });
      expect(onStepComplete).toHaveBeenCalledWith("b", { id: 2 });
    });

    it("calls onStepFailed when a step throws", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const onStepFailed = vi.fn();

      await withCompensation(
        "test",
        [
          { name: "ok", execute: async () => ({}) },
          {
            name: "bad",
            execute: async () => {
              throw new Error("boom");
            },
          },
        ],
        {},
        { onStepFailed },
      );

      expect(onStepFailed).toHaveBeenCalledTimes(1);
      expect(onStepFailed).toHaveBeenCalledWith("bad", expect.any(Error));
    });

    it("calls onCompensate for each compensated step", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const onCompensate = vi.fn();

      await withCompensation(
        "test",
        [
          { name: "a", execute: async () => ({}), compensate: async () => {} },
          { name: "b", execute: async () => ({}), compensate: async () => {} },
          {
            name: "c",
            execute: async () => {
              throw new Error("fail");
            },
          },
        ],
        {},
        { onCompensate },
      );

      expect(onCompensate).toHaveBeenCalledTimes(2);
      // Reverse order
      expect(onCompensate).toHaveBeenNthCalledWith(1, "b");
      expect(onCompensate).toHaveBeenNthCalledWith(2, "a");
    });

    it("hooks are optional — works without them", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      const result = await withCompensation("no-hooks", [
        { name: "a", execute: async () => ({ ok: true }) },
      ]);
    });
  });

  // ==========================================================================
  // Fire-and-forget steps
  // ==========================================================================

  describe("fire-and-forget steps", () => {
    it("does not await fireAndForget step — continues immediately", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const order: string[] = [];

      let slowResolve: () => void;
      const slowPromise = new Promise<void>((r) => {
        slowResolve = r;
      });

      const result = await withCompensation("ff-test", [
        {
          name: "fast",
          execute: async () => {
            order.push("fast");
            return {};
          },
        },
        {
          name: "slow-bg",
          execute: async () => {
            await slowPromise;
            order.push("slow");
            return {};
          },
          fireAndForget: true,
        },
        {
          name: "next",
          execute: async () => {
            order.push("next");
            return {};
          },
        },
      ]);

      // 'next' ran before 'slow' because slow is fire-and-forget
      expect(result.completedSteps).toContain("fast");
      expect(result.completedSteps).toContain("slow-bg");
      expect(result.completedSteps).toContain("next");
      expect(order).toEqual(["fast", "next"]); // slow hasn't resolved yet

      // Clean up
      slowResolve?.();
      await slowPromise;
    });

    it("fireAndForget step failure does NOT trigger compensation", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const compensated: string[] = [];

      const result = await withCompensation("ff-fail", [
        {
          name: "important",
          execute: async () => ({ saved: true }),
          compensate: async () => {
            compensated.push("undone");
          },
        },
        {
          name: "email",
          execute: async () => {
            throw new Error("SMTP down");
          },
          fireAndForget: true,
        },
        { name: "done", execute: async () => ({ ok: true }) },
      ]);

      // Saga still succeeds — email failure is swallowed
      expect(compensated).toHaveLength(0);
    });

    it("fireAndForget step is excluded from compensation rollback", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const compensated: string[] = [];

      await withCompensation("ff-no-comp", [
        {
          name: "a",
          execute: async () => ({}),
          compensate: async () => {
            compensated.push("a");
          },
        },
        {
          name: "bg",
          execute: async () => ({}),
          fireAndForget: true,
          compensate: async () => {
            compensated.push("bg");
          },
        },
        {
          name: "c",
          execute: async () => {
            throw new Error("fail");
          },
        },
      ]);

      // 'bg' should NOT be compensated — it's fire-and-forget
      expect(compensated).toEqual(["a"]);
    });
  });

  // ==========================================================================
  // Arc events integration via hooks
  // ==========================================================================

  describe("Arc events integration", () => {
    it("hooks enable wiring to fastify.events without coupling", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");

      // Simulate Arc events
      const published: Array<{ type: string; payload: unknown }> = [];
      const mockEvents = {
        publish: async (type: string, payload: unknown) => {
          published.push({ type, payload });
        },
      };

      await withCompensation(
        "checkout",
        [
          { name: "reserve", execute: async () => ({ reservationId: "r1" }) },
          { name: "charge", execute: async () => ({ chargeId: "c1" }) },
        ],
        {},
        {
          onStepComplete: (stepName, result) => {
            mockEvents.publish(`checkout.${stepName}.completed`, result);
          },
          onStepFailed: (stepName, error) => {
            mockEvents.publish(`checkout.${stepName}.failed`, { error: error.message });
          },
        },
      );

      expect(published).toEqual([
        { type: "checkout.reserve.completed", payload: { reservationId: "r1" } },
        { type: "checkout.charge.completed", payload: { chargeId: "c1" } },
      ]);
    });
  });
});
