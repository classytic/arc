/**
 * What a 500 puts on the wire, per declaration state.
 *
 * Two switches decide it — `includeStack` (adds `meta.stack`) and
 * `exposeInternalMessages` (skips the "Internal Server Error" mask). Both had
 * defaults derived three different ways, and each derivation leaked in a
 * different state:
 *
 *   - a host passing ANY `errorHandler` key lost the preset-derived
 *     `includeStack` entirely (the options object REPLACED the derived one);
 *   - `exposeInternalMessages` was never derived at all, so it always fell to a
 *     raw `NODE_ENV === "production"` read;
 *   - and deriving from `config.preset !== "production"` reads an UNSET preset
 *     as development — the widest reading of silence, on the two switches where
 *     wrong means leaking driver text and absolute paths.
 *
 * These assert the wire, not the config, because that is what an attacker sees.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import type { CreateAppOptions } from "../../src/factory/types/index.js";

const SECRET = "mongodb://user:pw@internal-host/db";
const prevNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = prevNodeEnv;
});

async function fiveHundred(extra: Partial<CreateAppOptions> = {}) {
  const app = await createApp({
    auth: false,
    logger: false,
    ...extra,
    plugins: async (f) => {
      f.get("/boom", async () => {
        throw new Error(SECRET);
      });
    },
  } as CreateAppOptions);
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/boom" });
  await app.close();
  return res.body;
}

describe("error disclosure defaults", () => {
  it("preset: production — masks the message AND omits the stack", async () => {
    const body = await fiveHundred({ preset: "production" });
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("stack");
  });

  it("NO preset + NODE_ENV=production — silence is not a licence to disclose", async () => {
    // The state a host lands in by setting only NODE_ENV. `preset` is optional,
    // so its absence must fall back to the environment, never to "development".
    process.env.NODE_ENV = "production";
    const body = await fiveHundred({});
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("stack");
  });

  it("NO preset + NODE_ENV=prod — the SHORT spelling must mask too", async () => {
    /**
     * The environment fallback has to go through the shared classifier, not a raw
     * `=== "production"`. `prod` is an accepted spelling throughout this ecosystem, and a raw
     * comparison misses it — which flips `isProduction` to false and re-opens BOTH switches, in
     * production, for exactly the hosts that set no preset. Same defect class as the one the
     * fallback was added to fix, one layer in.
     */
    process.env.NODE_ENV = "prod";
    const body = await fiveHundred({});
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("stack");
  });

  it("preset: development — still shows both, because that is the point", async () => {
    const body = await fiveHundred({ preset: "development" });
    expect(body).toContain(SECRET);
    expect(body).toContain("stack");
  });

  it("a host passing an UNRELATED key keeps the derived masking", async () => {
    // The trap: `errorHandler: { errorMappers: [...] }` used to replace the
    // derived options wholesale, silently re-enabling disclosure in production.
    const body = await fiveHundred({
      preset: "production",
      errorHandler: { errorMappers: [] },
    } as Partial<CreateAppOptions>);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("stack");
  });

  it("an EXPLICIT host opt-in still wins — deliberate widening stays possible", async () => {
    const body = await fiveHundred({
      preset: "production",
      errorHandler: { exposeInternalMessages: true },
    } as Partial<CreateAppOptions>);
    expect(body).toContain(SECRET);
  });
});
