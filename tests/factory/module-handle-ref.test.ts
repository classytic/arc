/**
 * `moduleHandleRef`: a sibling's export for a seam built at composition and called at request or event
 * time. The consumer's `plugins` arm records the booting app; a read before that throws by name.
 */
import { describe, expect, it } from "vitest";
import { defineModule, moduleHandleRef } from "../../src/factory/index.js";
import { arcApp } from "../_harness/index.js";

describe("moduleHandleRef", () => {
  it("throws by name when read before the consuming module's app booted", () => {
    const ref = moduleHandleRef("ledger");
    expect(ref.booted()).toBe(false);
    expect(() => ref.get()).toThrow(/"ledger".*before the consuming module's app booted/);
    expect(() => ref.find()).toThrow(/"ledger"/);
  });

  it("reads the sibling's export once the consumer's plugins arm ran; an absent sibling is undefined for find()", async () => {
    const ledger = moduleHandleRef("ledger");
    const absent = moduleHandleRef("nowhere");
    await arcApp({
      modules: [
        defineModule({ name: "ledger", bootstrap: async () => ({ post: "ok" }) }),
        defineModule({
          name: "consumer",
          dependsOn: ["ledger"],
          plugins: (fastify) => {
            ledger.plugins(fastify);
            return absent.plugins(fastify);
          },
        }),
      ],
    });
    expect(ledger.booted()).toBe(true);
    expect(ledger.get()).toEqual({ post: "ok" });
    expect(absent.find()).toBeUndefined();
    expect(() => absent.get()).toThrow(/nowhere/);
  });
});
