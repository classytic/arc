import { describe, expect, it, vi } from "vitest";
import { createCloudflarePurger } from "../../src/http-cache/purgers/cloudflare.js";
import { createFastlyPurger } from "../../src/http-cache/purgers/fastly.js";
import { CachePurgeError } from "../../src/http-cache/purgers/purger.types.js";

function fakeFetch(responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: { success: true } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("Cloudflare purger", () => {
  it("posts tags to the zone purge endpoint with a bearer token and declares its limits", async () => {
    const f = fakeFetch();
    const purger = createCloudflarePurger({ zoneId: "zone1", apiToken: "secret", fetch: f.fetch });
    expect(purger.capabilities).toEqual({ softPurge: false, maxTagsPerCall: 30 });
    await purger.purgeTags(["a", "b"], { mode: "hard" });
    expect(f.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/zones/zone1/purge_cache");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ tags: ["a", "b"] });
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
  });

  it("throws a closed-code error with Cloudflare's codes and never the token", async () => {
    const f = fakeFetch([{ status: 403, body: { success: false, errors: [{ code: 10000 }] } }]);
    const err = await createCloudflarePurger({
      zoneId: "z",
      apiToken: "secret-token",
      fetch: f.fetch,
    })
      .purgeTags(["a"], { mode: "hard" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CachePurgeError);
    expect(err).toMatchObject({
      code: "http_cache.purge_failed",
      purger: "cloudflare",
      status: 403,
      providerCodes: [10000],
    });
    expect(String((err as Error).message)).not.toContain("secret-token");
  });

  it("treats a 200 without success:true, and a network failure, as failures", async () => {
    await expect(
      createCloudflarePurger({
        zoneId: "z",
        apiToken: "t",
        fetch: fakeFetch([{ status: 200, body: { success: false } }]).fetch,
      }).purgeTags(["a"], { mode: "hard" }),
    ).rejects.toBeInstanceOf(CachePurgeError);
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      createCloudflarePurger({ zoneId: "z", apiToken: "t", fetch: offline }).purgeTags(["a"], {
        mode: "hard",
      }),
    ).rejects.toBeInstanceOf(CachePurgeError);
  });

  it("refuses to construct without a zone, token, or a sane chunk size", () => {
    expect(() => createCloudflarePurger({ zoneId: "", apiToken: "t" })).toThrow("zoneId");
    expect(() => createCloudflarePurger({ zoneId: "z", apiToken: " " })).toThrow("apiToken");
    expect(() => createCloudflarePurger({ zoneId: "z", apiToken: "t", maxTagsPerCall: 0 })).toThrow(
      "maxTagsPerCall",
    );
  });
});

describe("Fastly purger", () => {
  it("bulk-purges surrogate keys and supports soft purge", async () => {
    const f = fakeFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const purger = createFastlyPurger({ serviceId: "svc", apiKey: "k", fetch: f.fetch });
    expect(purger.capabilities).toEqual({ softPurge: true, maxTagsPerCall: 256 });
    await purger.purgeTags(["a", "b"], { mode: "hard" });
    await purger.purgeTags(["c"], { mode: "soft" });
    expect(f.calls[0]!.url).toBe("https://api.fastly.com/service/svc/purge");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ surrogate_keys: ["a", "b"] });
    const h0 = f.calls[0]!.init.headers as Record<string, string>;
    const h1 = f.calls[1]!.init.headers as Record<string, string>;
    expect(h0["fastly-key"]).toBe("k");
    expect(h0["fastly-soft-purge"]).toBeUndefined();
    expect(h1["fastly-soft-purge"]).toBe("1");
  });

  it("throws a closed-code error and never the key", async () => {
    const f = fakeFetch([
      { status: 401, body: { msg: "Provided credentials are missing or invalid" } },
    ]);
    const err = await createFastlyPurger({
      serviceId: "s",
      apiKey: "fastly-secret",
      fetch: f.fetch,
    })
      .purgeTags(["a"], { mode: "hard" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "http_cache.purge_failed", purger: "fastly", status: 401 });
    expect(JSON.stringify(err)).not.toContain("fastly-secret");
  });

  it("refuses to construct without a service or key", () => {
    expect(() => createFastlyPurger({ serviceId: "", apiKey: "k" })).toThrow("serviceId");
    expect(() => createFastlyPurger({ serviceId: "s", apiKey: "" })).toThrow("apiKey");
  });
});
