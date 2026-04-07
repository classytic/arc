import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { introspect } from "../../src/cli/commands/introspect.js";

describe("CLI introspect permission rendering", () => {
  it("renders function permissions without crashing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "arc-introspect-"));
    const entryPath = join(tempDir, "resource.mjs");

    await writeFile(
      entryPath,
      [
        "function allowList() { return true; }",
        "function requireAdmin() { return false; }",
        "export const productResource = {",
        "  name: 'product',",
        "  displayName: 'Products',",
        "  tag: 'Products',",
        "  prefix: '/products',",
        "  permissions: { list: allowList, create: requireAdmin },",
        "  _appliedPresets: [],",
        "  additionalRoutes: [],",
        "  events: {},",
        "  disableDefaultRoutes: false,",
        "  _registryMeta: {},",
        "  toPlugin() { return async function plugin() {}; },",
        "};",
      ].join("\n"),
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await introspect([entryPath]);

      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Permissions:");
      expect(output).toContain("list: allowList()");
      expect(output).toContain("create: requireAdmin()");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
