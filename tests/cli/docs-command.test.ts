import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportDocs } from "../../src/cli/commands/docs.js";

describe("CLI docs command", () => {
  it("exports OpenAPI using Arc runtime response shapes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "arc-docs-"));
    const entryPath = join(tempDir, "resources.mjs");
    const outputPath = join(tempDir, "openapi.json");

    await writeFile(
      entryPath,
      [
        "function allowPublic() { return true; }",
        "allowPublic._isPublic = true;",
        "export const productResource = {",
        "  name: 'product',",
        "  displayName: 'Products',",
        "  tag: 'Products',",
        "  prefix: '/products',",
        "  permissions: { list: allowPublic, get: allowPublic, create: allowPublic, update: allowPublic, delete: allowPublic },",
        "  _appliedPresets: [],",
        "  additionalRoutes: [],",
        "  events: {},",
        "  disableDefaultRoutes: false,",
        "  _registryMeta: {",
        "    openApiSchemas: { createBody: { type: 'object', properties: { name: { type: 'string' } } } }",
        "  },",
        "  toPlugin() { return async function plugin() {}; },",
        "};",
      ].join("\n"),
      "utf8",
    );

    try {
      await exportDocs([entryPath, outputPath]);

      const raw = await readFile(outputPath, "utf8");
      const spec = JSON.parse(raw) as {
        paths: Record<string, any>;
      };

      const listOp = spec.paths["/products"]?.get;
      const createOp = spec.paths["/products"]?.post;
      const getOp = spec.paths["/products/{id}"]?.get;

      expect(listOp).toBeDefined();
      expect(createOp).toBeDefined();
      expect(getOp).toBeDefined();

      expect(listOp.responses["200"].content["application/json"].schema.properties).toHaveProperty(
        "docs",
      );
      expect(
        createOp.responses["201"].content["application/json"].schema.properties,
      ).toHaveProperty("data");
      expect(
        createOp.responses["201"].content["application/json"].schema.properties,
      ).not.toHaveProperty("doc");
      expect(getOp.responses["200"].content["application/json"].schema.properties).toHaveProperty(
        "data",
      );
      expect(
        getOp.responses["200"].content["application/json"].schema.properties,
      ).not.toHaveProperty("doc");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
