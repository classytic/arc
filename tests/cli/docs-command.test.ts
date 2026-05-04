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
        "  routes: [],",
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
      const deleteOp = spec.paths["/products/{id}"]?.delete;

      expect(listOp).toBeDefined();
      expect(createOp).toBeDefined();
      expect(getOp).toBeDefined();
      expect(deleteOp).toBeDefined();

      // Arc 2.13 runtime: list response is a discriminated union of the
      // four canonical pagination shapes — branch on `method`. NOT a
      // `{ success, data }` envelope. Every variant carries `data`
      // inside the union, but the top-level schema is `oneOf`.
      const listSchema = listOp.responses["200"].content["application/json"].schema;
      expect(listSchema.oneOf).toBeDefined();
      expect(Array.isArray(listSchema.oneOf)).toBe(true);
      // Every variant should declare a `data` array property.
      for (const variant of listSchema.oneOf) {
        expect(variant.properties).toHaveProperty("data");
      }

      // Create / get / update / delete all return the doc (or DeleteResult)
      // DIRECTLY — no `{ success, data }` wrapper — via $ref.
      expect(createOp.responses["201"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/product",
      );
      expect(getOp.responses["200"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/product",
      );
      expect(deleteOp.responses["200"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/DeleteResult",
      );

      // Error responses everywhere reference the canonical ErrorContract,
      // not the legacy `{ success, error, code, requestId, timestamp }`.
      expect(createOp.responses["400"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/ErrorContract",
      );
      expect(createOp.responses["500"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/ErrorContract",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
