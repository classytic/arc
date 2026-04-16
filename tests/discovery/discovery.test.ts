/**
 * Discovery Module — smoke coverage
 *
 * `src/discovery/` was previously untested. These tests lock down the
 * scan + import + filter contract and three footgun paths: (1) a file
 * that matches the pattern but exports no resource, (2) filter opt-out,
 * (3) ordering (deterministic).
 *
 * Uses a temp directory so the suite doesn't rely on repo layout.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverResources } from "../../src/discovery/index.js";

describe("Discovery: discoverResources", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arc-discovery-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeResource(name: string, resourceName: string): Promise<void> {
    const body = `
      export const resource = {
        name: ${JSON.stringify(resourceName)},
        toPlugin: () => async () => {},
      };
    `;
    await writeFile(join(dir, name), body, "utf8");
  }

  it("returns [] when no files match", async () => {
    const result = await discoverResources({ paths: [dir] });
    expect(result).toEqual([]);
  });

  it("discovers a single matching file", async () => {
    await writeResource("user.resource.mjs", "user");

    const result = await discoverResources({
      paths: [dir],
      pattern: "*.resource.{mjs,js}",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.resource.name).toBe("user");
  });

  it("returns files in deterministic (sorted) order", async () => {
    await writeResource("b.resource.mjs", "b");
    await writeResource("a.resource.mjs", "a");
    await writeResource("c.resource.mjs", "c");

    const result = await discoverResources({
      paths: [dir],
      pattern: "*.resource.{mjs,js}",
    });
    expect(result.map((r) => r.resource.name)).toEqual(["a", "b", "c"]);
  });

  it("throws a helpful error when a matching file has no resource", async () => {
    await writeFile(join(dir, "empty.resource.mjs"), "export const foo = 1;", "utf8");

    await expect(
      discoverResources({ paths: [dir], pattern: "*.resource.{mjs,js}" }),
    ).rejects.toThrow(/No resource found/);
  });

  it("respects the filter callback", async () => {
    await writeResource("keep.resource.mjs", "keep");
    await writeResource("drop.resource.mjs", "drop");

    const result = await discoverResources({
      paths: [dir],
      pattern: "*.resource.{mjs,js}",
      filter: (r) => r.name !== "drop",
    });
    expect(result.map((r) => r.resource.name)).toEqual(["keep"]);
  });

  it("fires onDiscover for each kept resource", async () => {
    await writeResource("a.resource.mjs", "a");
    await writeResource("b.resource.mjs", "b");

    const discovered: string[] = [];
    await discoverResources({
      paths: [dir],
      pattern: "*.resource.{mjs,js}",
      onDiscover: (name) => discovered.push(name),
    });
    expect(discovered).toEqual(["a", "b"]);
  });

  it("ignores files that don't match the pattern", async () => {
    await writeResource("user.resource.mjs", "user");
    await writeFile(join(dir, "helpers.mjs"), "export const x = 1;", "utf8");

    const result = await discoverResources({
      paths: [dir],
      pattern: "*.resource.{mjs,js}",
    });
    expect(result).toHaveLength(1);
  });

  it("surfaces import errors with the file path", async () => {
    await writeFile(join(dir, "broken.resource.mjs"), "this is not valid javascript {", "utf8");

    await expect(
      discoverResources({ paths: [dir], pattern: "*.resource.{mjs,js}" }),
    ).rejects.toThrow(/broken\.resource\.mjs/);
  });
});
