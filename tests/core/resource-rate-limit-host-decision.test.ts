/**
 * A resource's declared rateLimit follows the HOST's decision: `createApp({ rateLimit: false })`
 * boots and says once which resources' limits it is not enforcing; a host that never decided
 * (no limiter, not disabled) still refuses to boot, because a declared limit nothing enforces is
 * decoration.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

function limited(name: string) {
  return defineResource({
    name,
    disableDefaultRoutes: true,
    routes: [
      {
        method: "POST",
        path: "/hook",
        permissions: allowPublic(),
        rateLimit: { max: 2, timeWindow: "1 minute" },
        handler: async () => ({ data: { ok: true } }),
      },
    ],
  });
}

describe("declared resource rateLimit vs the host's switch", () => {
  it("rateLimit: false boots, serves, and logs one line naming the unenforced resources", async () => {
    const lines: string[] = [];
    const app = await createApp({
      preset: "testing",
      auth: false,
      rateLimit: false,
      logger: { level: "info", stream: { write: (s: string) => void lines.push(s) } },
      plugins: async (f) => {
        await f.register(limited("webhook").toPlugin());
        await f.register(limited("stream").toPlugin());
      },
    });
    await app.ready();
    for (let i = 0; i < 4; i++) {
      expect(
        (await app.inject({ method: "POST", url: "/webhooks/hook", payload: {} })).statusCode,
      ).toBe(200);
    }
    const notice = lines.filter((l) => l.includes("not enforced"));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain("webhook");
    expect(notice[0]).toContain("stream");
    await app.close();
  });

  it("a host that never decided (no limiter, not disabled) still refuses to boot", async () => {
    const app = Fastify({ logger: false });
    await expect(
      (async () => {
        await app.register(limited("bare").toPlugin());
        await app.ready();
      })(),
    ).rejects.toThrow(/register @fastify\/rate-limit/);
    await app.close();
  });
});
