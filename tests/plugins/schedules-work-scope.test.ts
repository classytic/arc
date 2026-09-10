/**
 * A scheduled job run is a unit of work: it gets its own scope, keyed on the
 * job name, and two runs never share one — the same isolation a request has.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { requestContext } from "../../src/context/requestContext.js";
import { requestScopedCache } from "../../src/context/requestScopedCache.js";
import schedulesPlugin from "../../src/plugins/schedules.js";
import { waitFor } from "../../src/testing/mocks.js";

describe("schedulesPlugin — work scope per run", () => {
  it("the handler sees a 'job' scope named after the schedule, with its own cache", async () => {
    const kinds: Array<string | undefined> = [];
    const ids: Array<string | undefined> = [];
    const stores: unknown[] = [];
    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      schedules: [
        {
          name: "sweep",
          every: 20,
          runOnStart: true,
          handler: () => {
            kinds.push(requestContext.get()?.kind);
            ids.push(requestContext.get()?.requestId);
            stores.push(requestScopedCache());
          },
        },
      ],
    });
    await app.ready();
    await waitFor(() => stores.length >= 2, { label: "2 ticks" });
    await app.close();

    expect(kinds[0]).toBe("job");
    expect(ids[0]).toBe("sweep");
    expect(stores[0]).toBeDefined();
    expect(stores[0]).not.toBe(stores[1]);
  });
});
