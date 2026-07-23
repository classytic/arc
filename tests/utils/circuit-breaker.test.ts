/**
 * Circuit Breaker Tests
 *
 * Tests circuit breaker states, fallbacks, and error handling
 */

import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitState,
} from "../../src/utils/circuitBreaker.js";
import { wait } from "../setup.js";

describe("CircuitBreaker", () => {
  describe("Basic Functionality", () => {
    it("should execute function successfully in CLOSED state", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      const result = await breaker.call("arg1", "arg2");

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledWith("arg1", "arg2");
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("should open circuit after failure threshold", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Service error"));
      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        await expect(breaker.call()).rejects.toThrow("Service error");
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Next call should fail fast
      await expect(breaker.call()).rejects.toThrow(CircuitBreakerError);
    });

    it("should transition from OPEN to HALF_OPEN after reset timeout", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Service error"));
      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 100, // Short timeout for testing
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Wait for reset timeout
      await wait(150);

      // Next call should trigger HALF_OPEN
      fn.mockResolvedValue("success");
      const result = await breaker.call();

      expect(result).toBe("success");
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("should close circuit after successful calls in HALF_OPEN", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail"))
        .mockResolvedValue("success");

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 100,
        successThreshold: 2,
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Wait and succeed twice
      await wait(150);
      await breaker.call();
      await breaker.call();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("should re-open if call fails in HALF_OPEN state", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail again"));

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 100,
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Wait and fail again
      await wait(150);
      await expect(breaker.call()).rejects.toThrow("Fail again");

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe("Fallback", () => {
    it("should call fallback when circuit is OPEN", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Service error"));
      const fallback = vi.fn().mockResolvedValue("fallback value");

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 1000,
        fallback,
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();

      // Call with fallback
      const result = await breaker.call("arg1");

      expect(result).toBe("fallback value");
      expect(fallback).toHaveBeenCalledWith("arg1");
    });

    it("should not call fallback when circuit is CLOSED", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const fallback = vi.fn().mockResolvedValue("fallback");

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        fallback,
      });

      const result = await breaker.call();

      expect(result).toBe("success");
      expect(fallback).not.toHaveBeenCalled();
    });
  });

  describe("Timeout", () => {
    it("should timeout long-running operations", async () => {
      const fn = vi.fn().mockImplementation(() => wait(200));

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        timeout: 50,
      });

      await expect(breaker.call()).rejects.toThrow("timeout");
    });

    it("should not timeout fast operations", async () => {
      const fn = vi.fn().mockImplementation(async () => {
        await wait(10);
        return "success";
      });

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        timeout: 100,
      });

      const result = await breaker.call();
      expect(result).toBe("success");
    });
  });

  describe("State Change Callback", () => {
    it("should call onStateChange callback", async () => {
      const onStateChange = vi.fn();
      const fn = vi.fn().mockRejectedValue(new Error("Fail"));

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 1000,
        onStateChange,
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();

      expect(onStateChange).toHaveBeenCalledWith(CircuitState.CLOSED, CircuitState.OPEN);
    });
  });

  describe("Error Callback", () => {
    it("should call onError callback on failures", async () => {
      const onError = vi.fn();
      const fn = vi.fn().mockRejectedValue(new Error("Service error"));

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 3,
        onError,
      });

      await expect(breaker.call()).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("Statistics", () => {
    it("should track failure and success counts", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce("success")
        .mockRejectedValueOnce(new Error("Fail"))
        .mockResolvedValueOnce("success");

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 5,
      });

      await breaker.call();
      await expect(breaker.call()).rejects.toThrow();
      await breaker.call();

      const stats = breaker.getStats();
      // After success, failure resets successes to 0
      // After failure, success resets failures to 0
      expect(stats.successes).toBe(1);
      expect(stats.failures).toBe(0);
      expect(stats.state).toBe(CircuitState.CLOSED);
    });

    it("should reset stats when circuit closes", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail"))
        .mockResolvedValue("success");

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 100,
        successThreshold: 2, // Need 2 successes to close
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();

      const openStats = breaker.getStats();
      expect(openStats.failures).toBe(2);

      // Wait and call successfully twice to close
      await wait(150);
      await breaker.call(); // First success

      const halfOpenStats = breaker.getStats();
      expect(halfOpenStats.state).toBe(CircuitState.HALF_OPEN);
      expect(halfOpenStats.successes).toBe(1);

      await breaker.call(); // Second success, should close

      const closedStats = breaker.getStats();
      expect(closedStats.state).toBe(CircuitState.CLOSED);
      expect(closedStats.failures).toBe(0);
      // After closing, successes are reset to 0
      expect(closedStats.successes).toBe(0);
    });
  });

  describe("Manual Control", () => {
    it("should allow manual reset", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Fail"));

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 10000, // Long timeout
      });

      // Open circuit
      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Manual reset
      breaker.reset();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getStats().failures).toBe(0);
    });
  });

  describe("Named Circuit Breakers", () => {
    it("should track name in stats", () => {
      const fn = vi.fn().mockResolvedValue("success");

      const breaker = new CircuitBreaker(fn, {
        name: "stripe-api",
        failureThreshold: 3,
      });

      const stats = breaker.getStats();
      expect(stats.name).toBe("stripe-api");
    });
  });

  describe("Edge Cases", () => {
    it("should handle synchronous errors", async () => {
      const fn = vi.fn().mockImplementation(() => {
        throw new Error("Sync error");
      });

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
      });

      await expect(breaker.call()).rejects.toThrow("Sync error");
    });

    it("should handle zero failure threshold", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Fail"));

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 1,
        resetTimeout: 1000,
      });

      await expect(breaker.call()).rejects.toThrow();

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("should work without optional callbacks", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail"))
        .mockResolvedValue("success");

      const breaker = new CircuitBreaker(fn, {
        failureThreshold: 2,
        resetTimeout: 100,
        // No callbacks
      });

      await expect(breaker.call()).rejects.toThrow();
      await expect(breaker.call()).rejects.toThrow();
      await wait(150);
      const result = await breaker.call();

      expect(result).toBe("success");
    });
  });
});

// ============================================================================
// Half-open probe fencing + abort propagation
// ============================================================================

describe("half-open probe fencing", () => {
  // After resetTimeout, every queued caller observes "eligible"; only
  // `halfOpenMaxProbes` (default 1) may actually test the downstream — the
  // rest fail fast (or hit the fallback) as if the circuit were still open.
  async function openBreaker(breaker: CircuitBreaker<() => Promise<unknown>>): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await breaker.call().catch(() => {});
    }
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  }

  it("only ONE concurrent caller probes after resetTimeout; the rest fail fast", async () => {
    let invocations = 0;
    let mode: "fail" | "slow-success" = "fail";
    const fn = async () => {
      invocations++;
      if (mode === "fail") throw new Error("down");
      await wait(50);
      return "ok";
    };
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      resetTimeout: 30,
      timeout: 1000,
    });

    await openBreaker(breaker as CircuitBreaker<() => Promise<unknown>>);
    invocations = 0;
    mode = "slow-success";
    await wait(40); // past resetTimeout — every caller now sees "eligible"

    const results = await Promise.allSettled([breaker.call(), breaker.call(), breaker.call()]);

    expect(invocations).toBe(1); // exactly one probe reached the downstream
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(CircuitBreakerError);
      expect((r.reason as CircuitBreakerError).state).toBe(CircuitState.HALF_OPEN);
    }
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it("halfOpenMaxProbes widens the probe window", async () => {
    let invocations = 0;
    let failing = true;
    const fn = async () => {
      invocations++;
      if (failing) throw new Error("down");
      await wait(30);
      return "ok";
    };
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      resetTimeout: 20,
      successThreshold: 2,
      halfOpenMaxProbes: 2,
      timeout: 1000,
    });

    await openBreaker(breaker as CircuitBreaker<() => Promise<unknown>>);
    invocations = 0;
    failing = false;
    await wait(30);

    const results = await Promise.allSettled([breaker.call(), breaker.call(), breaker.call()]);
    expect(invocations).toBe(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("excess half-open callers get the fallback when configured", async () => {
    let failing = true;
    const fn = async () => {
      if (failing) throw new Error("down");
      await wait(30);
      return "live";
    };
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      resetTimeout: 20,
      timeout: 1000,
      fallback: async () => "cached",
    });

    for (let i = 0; i < 2; i++) await breaker.call().catch(() => {});
    failing = false;
    await wait(30);

    const [probe, shed] = await Promise.all([breaker.call(), breaker.call()]);
    expect(probe).toBe("live");
    expect(shed).toBe("cached");
  });

  it("sequential half-open probes are unaffected (slot frees between calls)", async () => {
    let failing = true;
    const fn = async () => {
      if (failing) throw new Error("down");
      return "ok";
    };
    const breaker = new CircuitBreaker(fn, {
      failureThreshold: 2,
      resetTimeout: 20,
      successThreshold: 2,
      timeout: 1000,
    });

    for (let i = 0; i < 2; i++) await breaker.call().catch(() => {});
    failing = false;
    await wait(30);

    await breaker.call();
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    await breaker.call();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });
});

describe("abort propagation", () => {
  it("propagateAbort hands the fn a trailing AbortSignal fired on timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    const fn = async (label: string, signal?: AbortSignal) => {
      seenSignal = signal;
      await wait(200);
      return label;
    };
    const breaker = new CircuitBreaker(fn, { timeout: 30, propagateAbort: true });

    await expect(breaker.call("x")).rejects.toThrow(/timeout after 30ms/);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("without propagateAbort no signal is passed (back-compat)", async () => {
    const seenArgs: unknown[][] = [];
    const fn = async (...args: unknown[]) => {
      seenArgs.push(args);
      return "ok";
    };
    const breaker = new CircuitBreaker(fn as (a: string) => Promise<string>, { timeout: 100 });
    await breaker.call("only");
    expect(seenArgs[0]).toEqual(["only"]);
  });

  it("signal is NOT aborted on success", async () => {
    let seenSignal: AbortSignal | undefined;
    const fn = async (signal?: AbortSignal) => {
      seenSignal = signal;
      return "ok";
    };
    const breaker = new CircuitBreaker(fn as () => Promise<string>, {
      timeout: 100,
      propagateAbort: true,
    });
    await breaker.call();
    expect(seenSignal?.aborted).toBe(false);
  });
});
