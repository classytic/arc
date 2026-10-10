import Fastify from "fastify";
import { expect, it } from "vitest";
import {
  initShutdownRegistry,
  registerShutdownParticipant,
  runShutdown,
} from "../../src/utils/shutdown.js";

it("stops every runtime before draining any, across children, once despite failures", async () => {
  const app = Fastify({ logger: false });
  initShutdownRegistry(app);
  const order: string[] = [];
  registerShutdownParticipant(app, {
    name: "events",
    kind: "consumer",
    stop: () => {
      order.push("stop-events");
    },
    drain: () => {
      order.push("drain-events");
    },
  });
  registerShutdownParticipant(app, {
    name: "a",
    stop: () => {
      order.push("stop-a");
      throw new Error("stop failed");
    },
    drain: () => {
      order.push("drain-a");
    },
  });
  await app.register(async (child) => {
    registerShutdownParticipant(child, {
      name: "b",
      stop: () => {
        order.push("stop-b");
      },
      drain: () => {
        order.push("drain-b");
      },
    });
  });
  const [first, second] = await Promise.all([runShutdown(app), runShutdown(app)]);
  expect(order).toEqual(["stop-events", "stop-a", "stop-b", "drain-a", "drain-b", "drain-events"]);
  expect(first).toBe(second);
  expect(first).toHaveLength(1);
  expect((first[0] as Error).message).toContain("a shutdown stop failed");
  await app.close();
  expect(order).toHaveLength(6);
});
