/**
 * Registry-latest overlay (2.22) — `arc init` scaffolds latest STABLE npm
 * versions, with guards. Deterministic via the test hook (no network):
 * upgrade-within-major applies; @classytic/* floats across majors/0.x
 * minors; third-party majors NEVER cross silently; prereleases and
 * downgrades rejected; empty cache = pre-2.22 behavior exactly.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __setLatestVersionsForTest,
  resolveScaffoldDependencies,
} from "../../src/cli/commands/init/dependency-plan.js";
import type { ProjectConfig } from "../../src/cli/commands/init/types.js";

const config: ProjectConfig = {
  name: "t",
  adapter: "mongokit",
  auth: "jwt",
  tenant: "single",
  typescript: true,
} as ProjectConfig;

afterEach(() => __setLatestVersionsForTest(null));

describe("arc init — registry-latest overlay", () => {
  it("empty cache → identical static/peer behavior (offline & test determinism)", () => {
    const a = resolveScaffoldDependencies(config);
    __setLatestVersionsForTest({});
    const b = resolveScaffoldDependencies(config);
    expect(b).toEqual(a);
  });

  it("upgrades within the same major (third-party)", () => {
    __setLatestVersionsForTest({ fastify: "5.99.0" });
    const { dependencies } = resolveScaffoldDependencies(config);
    expect(dependencies.fastify).toBe("^5.99.0");
  });

  it("NEVER crosses a major for third-party packages (tested major wins)", () => {
    __setLatestVersionsForTest({ zod: "5.0.0", mongoose: "10.0.0" });
    const { dependencies } = resolveScaffoldDependencies(config);
    expect(dependencies.zod).toMatch(/^\^4\./);
    expect(dependencies.mongoose).toMatch(/^\^9\./);
  });

  it("@classytic/* floats freely — majors and 0.x minors (we own the compat story)", () => {
    // repo-core fixture must sit ABOVE arc's declared peer floor — the
    // peer-floor overlay runs LAST by design, so a latest below the floor
    // gets (correctly) lifted and would mask what this test asserts.
    __setLatestVersionsForTest({
      "@classytic/mongokit": "4.1.0",
      "@classytic/repo-core": "0.99.0",
    });
    const { dependencies } = resolveScaffoldDependencies(config);
    expect(dependencies["@classytic/mongokit"]).toBe("^4.1.0");
    expect(dependencies["@classytic/repo-core"]).toBe("^0.99.0");
  });

  it("rejects downgrades and prereleases", () => {
    __setLatestVersionsForTest({
      fastify: "5.0.0", // below the static floor
      "@classytic/mongokit": "4.0.0-beta.1",
    });
    const { dependencies } = resolveScaffoldDependencies(config);
    expect(dependencies.fastify).not.toBe("^5.0.0");
    expect(dependencies["@classytic/mongokit"]).not.toContain("beta");
  });

  it("devDependencies get the same treatment", () => {
    __setLatestVersionsForTest({ vitest: "4.99.0" });
    const { devDependencies } = resolveScaffoldDependencies(config);
    expect(devDependencies.vitest).toBe("^4.99.0");
  });

  it("peer-floor overlay still wins LAST (registry down can't undercut peers)", () => {
    // With an empty cache, @classytic/repo-core must still satisfy arc's
    // declared peer floor via overlayLiveArcVersions — the original 2.20
    // guarantee, unchanged by the new layer.
    __setLatestVersionsForTest({});
    const { dependencies } = resolveScaffoldDependencies(config);
    expect(dependencies["@classytic/repo-core"]).toMatch(/^\^\d+\.\d+\.\d+$/);
  });
});

describe("arc init — adapter-scoped dev dependencies (2.23)", () => {
  it("mongokit scaffolds get mongodb-memory-server as a dev dep", () => {
    const { devDependencies } = resolveScaffoldDependencies(config);
    expect(devDependencies["mongodb-memory-server"]).toMatch(/^\^/);
  });

  it("custom-adapter scaffolds do NOT install mongodb-memory-server", () => {
    // The package downloads a full MongoDB binary on install — far too
    // heavy to force on projects that never touch Mongo. The generated
    // test harness only imports it for mongokit scaffolds, so the dep
    // group mirrors that condition exactly.
    const custom = { ...config, adapter: "custom" } as ProjectConfig;
    const { dependencies, devDependencies } = resolveScaffoldDependencies(custom);
    expect(devDependencies).not.toHaveProperty("mongodb-memory-server");
    expect(dependencies).not.toHaveProperty("@classytic/mongokit");
    expect(dependencies).not.toHaveProperty("mongoose");
    // Common dev tooling still present.
    expect(devDependencies).toHaveProperty("vitest");
    expect(devDependencies).toHaveProperty("@biomejs/biome");
  });
});
