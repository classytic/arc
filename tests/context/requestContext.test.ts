import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../../src/context/requestContext.js";
import { resetDeprecationWarnings } from "../../src/logger/deprecation.js";

describe("requestContext", () => {
  it("returns undefined outside a run() scope", () => {
    expect(requestContext.get()).toBeUndefined();
  });

  it("getStore() is a deprecated alias of get(): same value, warns once", () => {
    resetDeprecationWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = { startTime: Date.now(), requestId: "req-alias" };
    requestContext.run(store, () => {
      expect(requestContext.getStore()).toBe(store);
      expect(requestContext.getStore()).toBe(store);
    });
    const lines = warn.mock.calls.map((c) => c.join(" "));
    const deprecations = lines.filter((l) =>
      l.includes("`requestContext.getStore()` is deprecated"),
    );
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0]).toContain("requestContext.get()");
    warn.mockRestore();
  });

  it("provides store inside run() scope", () => {
    const store = { startTime: Date.now(), requestId: "req-1" };
    requestContext.run(store, () => {
      expect(requestContext.get()).toBe(store);
    });
  });

  it("isolates stores between concurrent runs", async () => {
    const results: (string | undefined)[] = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        requestContext.run({ startTime: Date.now(), requestId: "a" }, () => {
          setTimeout(() => {
            results.push(requestContext.get()?.requestId);
            resolve();
          }, 10);
        });
      }),
      new Promise<void>((resolve) => {
        requestContext.run({ startTime: Date.now(), requestId: "b" }, () => {
          setTimeout(() => {
            results.push(requestContext.get()?.requestId);
            resolve();
          }, 5);
        });
      }),
    ]);

    expect(results).toContain("a");
    expect(results).toContain("b");
  });

  it("supports nested runs (inner overrides outer)", () => {
    const outer = { startTime: Date.now(), requestId: "outer" };
    const inner = { startTime: Date.now(), requestId: "inner" };

    requestContext.run(outer, () => {
      expect(requestContext.get()?.requestId).toBe("outer");
      requestContext.run(inner, () => {
        expect(requestContext.get()?.requestId).toBe("inner");
      });
      expect(requestContext.get()?.requestId).toBe("outer");
    });
  });

  it("supports additional properties on store", () => {
    const store = { startTime: Date.now(), customField: "hello" };
    requestContext.run(store, () => {
      expect(requestContext.get()?.customField).toBe("hello");
    });
  });

  it("exposes the underlying AsyncLocalStorage instance", () => {
    expect(requestContext.storage).toBeDefined();
    expect(typeof requestContext.storage.run).toBe("function");
  });
});
