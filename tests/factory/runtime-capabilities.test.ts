/**
 * Runtime capability registry — the checklist becomes enforcement.
 *
 * The gap: `validateDistributedRuntime` sees only what `createApp` receives.
 * State a HOST wires inside `plugins()` was invisible — it lived on a wiki
 * checklist, and a checklist is not enforcement. Pinned:
 *
 *   1. A host-declared memory capability FAILS a distributed boot, by name.
 *   2. `accepted: true` (per-process by design) passes with an info line.
 *   3. Non-distributed runtimes enforce nothing.
 *   4. Arc's own webhooks plugin declares its default in-memory store.
 */

import { describe, expect, it } from "vitest";
import { declareRuntimeCapability } from "../../src/utils/index.js";
import { arcApp, arcAppRefuses } from "../_harness/index.js";

// A minimal shared events transport so runtime: 'distributed' passes the
// constructor-time guard — this suite is about what that guard CANNOT see.
const sharedTransport = {
  name: "test-shared",
  publish: async () => {},
  subscribe: async () => {},
  close: async () => {},
} as never;

describe("runtime capability registry", () => {
  it("a host-wired memory capability FAILS a distributed boot — named, not silent", async () => {
    await arcAppRefuses(
      {
        runtime: "distributed",
        rateLimit: false,
        stores: { events: sharedTransport },
        plugins: async (f) => {
          // The checklist case: host wires a replica-local store in plugins().
          declareRuntimeCapability(f, {
            subsystem: "billing.sequence-cache",
            durability: "memory",
            detail: "invoice numbering cached per process",
          });
        },
      },
      /billing\.sequence-cache/,
    );
  });

  it("accepted per-process state passes distributed — the topology decision is explicit", async () => {
    const app = await arcApp({
      runtime: "distributed",
      rateLimit: false,
      stores: { events: sharedTransport },
      plugins: async (f) => {
        declareRuntimeCapability(f, {
          subsystem: "http.micro-cache",
          durability: "memory",
          accepted: true,
          detail: "short-TTL hot-path cache; correctness from TTL, not shared state",
        });
      },
    });
    expect(app).toBeTruthy();
  });

  it("non-distributed runtimes enforce nothing — declarations are informational", async () => {
    const app = await arcApp({
      plugins: async (f) => {
        declareRuntimeCapability(f, {
          subsystem: "anything.memory",
          durability: "memory",
        });
      },
    });
    expect(app).toBeTruthy();
  });

  it("webhooks' DEFAULT in-memory store is a declared violation under distributed", async () => {
    const { default: webhookPlugin } = await import("../../src/integrations/webhooks.js");
    await arcAppRefuses(
      {
        runtime: "distributed",
        rateLimit: false,
        stores: { events: sharedTransport },
        plugins: async (f) => {
          await f.register(webhookPlugin, {});
        },
      },
      /webhooks\.store/,
    );
  });
});
