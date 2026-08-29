import { describe, expect, it, vi } from "vitest";
import { preflightPlugins } from "../../src/factory/security/pluginLoader.js";

/**
 * The preflight turns "one restart per missing package" into ONE error. These
 * assert THAT property — a test that only checked "it throws" would pass for
 * the old one-at-a-time loader too.
 *
 * The resolver is injected: vitest's mocker replaces a factory's thrown error,
 * so a real module-resolution failure (which carries `code`) cannot be faked
 * through it.
 */
const notFound = (pkg: string) => {
  const e = new Error(`Cannot find package '${pkg}'`);
  (e as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
  return e;
};

/** Resolve everything except the named plugins. */
const resolverMissing = (missing: string[]) => async (name: string) => {
  if (missing.includes(name)) throw notFound(`@fastify/${name}`);
  return { default: () => {} };
};

describe("preflightPlugins — one error, every miss", () => {
  it("reports ALL missing packages, not just the first", async () => {
    const err = await preflightPlugins(
      {},
      { load: resolverMissing(["helmet", "cors", "sensible"]) },
    ).catch((e: Error) => e);
    const msg = (err as Error).message;

    expect(msg).toContain("3 required plugin package(s)");
    for (const p of ["@fastify/helmet", "@fastify/cors", "@fastify/sensible"])
      expect(msg).toContain(p);

    // ONE install command that fixes all three.
    const install = msg.split("npm install ")[1]?.split("\n")[0] ?? "";
    for (const p of ["@fastify/helmet", "@fastify/cors", "@fastify/sensible"])
      expect(install).toContain(p);
  });

  it("passes when every required package resolves", async () => {
    await expect(preflightPlugins({}, { load: resolverMissing([]) })).resolves.toBeUndefined();
  });

  it("SKIPS a disabled plugin — a package for a plugin nobody wants must not block boot", async () => {
    await expect(
      preflightPlugins({ helmet: false }, { load: resolverMissing(["helmet"]) }),
    ).resolves.toBeUndefined();
  });

  it("never preflights OPTIONAL plugins — their absence is a supported configuration", async () => {
    const asked: string[] = [];
    await preflightPlugins(
      {},
      {
        load: async (name) => {
          asked.push(name);
          return { default: () => {} };
        },
      },
    );
    for (const optional of ["multipart", "rawBody", "static"])
      expect(asked).not.toContain(optional);
    // and it DID check the required ones — otherwise this passes vacuously.
    expect(asked).toEqual(expect.arrayContaining(["helmet", "cors", "sensible"]));
  });

  it('a package that EXISTS but throws on import is NOT reported as "not installed"', async () => {
    // Sending someone to reinstall a package that is already there is worse
    // than the original fault: the install succeeds and nothing changes.
    const err = await preflightPlugins(
      {},
      {
        load: async (name) => {
          if (name === "helmet") throw new Error("boom: bad config at module scope");
          return { default: () => {} };
        },
      },
    ).catch((e: Error) => e);

    expect((err as Error).message).toContain("boom");
    expect((err as Error).message).not.toContain("not installed");
  });
});

describe("preflight is WIRED into boot", () => {
  /**
   * The unit tests above call `preflightPlugins` directly, so deleting the call
   * from `registerSecurityPlugins` leaves every one of them green while the
   * feature does nothing. This asserts the WIRING.
   *
   * Order matters as much as presence: a preflight that ran after the first
   * `loadPlugin` would still throw, just not before the one-at-a-time failure
   * it exists to replace.
   */
  it("registerSecurityPlugins preflights BEFORE loading any plugin", async () => {
    const order: string[] = [];

    vi.doMock("../../src/factory/security/pluginLoader.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../src/factory/security/pluginLoader.js")
      >("../../src/factory/security/pluginLoader.js");
      return {
        ...actual,
        preflightPlugins: async (...a: Parameters<typeof actual.preflightPlugins>) => {
          order.push("preflight");
          return actual.preflightPlugins(...a);
        },
        loadPlugin: async (...a: Parameters<typeof actual.loadPlugin>) => {
          order.push(`load:${a[0]}`);
          return actual.loadPlugin(...a);
        },
      };
    });

    const { registerSecurityPlugins } = await import("../../src/factory/registerSecurity.js");
    const Fastify = (await import("fastify")).default;
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app as never, {} as never);
    await app.close();
    vi.doUnmock("../../src/factory/security/pluginLoader.js");

    expect(order[0]).toBe("preflight");
    expect(order.some((o) => o.startsWith("load:"))).toBe(true);
  });
});
