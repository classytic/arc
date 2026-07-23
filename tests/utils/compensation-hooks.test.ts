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
      expect(result.completedSteps).toContain("next");
      // 2.24 (wave-6 audit): fireAndForget steps are NOT in completedSteps —
      // the step hasn't completed when the result is returned, and pre-fix
      // a step that later FAILED had already been reported as completed.
      expect(result.completedSteps).not.toContain("slow-bg");
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

    it("fireAndForget rejection surfaces via onStepFailed (2.24 — was silently swallowed)", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const onStepFailed = vi.fn();

      let rejectBg: (err: Error) => void = () => {};
      const bgPromise = new Promise<never>((_, reject) => {
        rejectBg = reject;
      });

      const result = await withCompensation(
        "ff-observe",
        [
          { name: "main", execute: async () => ({}) },
          { name: "bg", execute: () => bgPromise, fireAndForget: true },
        ],
        undefined,
        { onStepFailed },
      );

      // Transaction outcome unaffected by the pending bg step.
      expect(result.success).toBe(true);
      expect(onStepFailed).not.toHaveBeenCalled();

      rejectBg(new Error("SMTP down"));
      await new Promise((r) => setImmediate(r));

      expect(onStepFailed).toHaveBeenCalledTimes(1);
      expect(onStepFailed).toHaveBeenCalledWith("bg", expect.any(Error));
    });

    it("a THROWING observability hook cannot become an unhandled rejection (wave-7 fix)", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const unhandled: unknown[] = [];
      const capture = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", capture);

      try {
        const result = await withCompensation(
          "ff-hook-throws",
          [
            { name: "main", execute: async () => ({}) },
            {
              name: "bg-ok",
              execute: async () => ({}),
              fireAndForget: true,
            },
            {
              name: "bg-fail",
              execute: async () => {
                throw new Error("bg down");
              },
              fireAndForget: true,
            },
          ],
          undefined,
          {
            // BOTH hooks throw — the detached chains must contain it.
            onStepComplete: () => {
              throw new Error("metrics sink down");
            },
            onStepFailed: () => {
              throw new Error("alerting down");
            },
          },
        );
        expect(result.success).toBe(true);

        // Let the detached fire-and-forget chains fully settle.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", capture);
      }
    });

    it("contained hook failures are REPORTED via onHookError (not silent)", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const reported: Array<[string, string]> = [];

      const result = await withCompensation(
        "hook-error-report",
        [{ name: "main", execute: async () => ({}) }],
        undefined,
        {
          onStepComplete: () => {
            throw new Error("metrics sink down");
          },
          onHookError: (hook, error) => {
            reported.push([hook, error.message]);
          },
        },
      );

      expect(result.success).toBe(true); // containment unchanged
      expect(reported).toEqual([["onStepComplete", "metrics sink down"]]);
    });

    it("a throwing onHookError is itself contained", async () => {
      const { withCompensation } = await import("../../src/utils/compensation.js");
      const result = await withCompensation(
        "hook-error-throws",
        [{ name: "main", execute: async () => ({}) }],
        undefined,
        {
          onStepComplete: () => {
            throw new Error("sink down");
          },
          onHookError: () => {
            throw new Error("reporter down too");
          },
        },
      );
      expect(result.success).toBe(true);
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
