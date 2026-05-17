/**
 * Scaffolding I/O for `arc generate`.
 *
 * Templates are pure (see `./templates.ts`); this module owns every
 * disk-touching step:
 *
 *   - `generateResource` writes the full resource folder
 *     (`<name>.model.ts` + `.repository.ts` + `.resource.ts` + optional
 *     `.mcp.ts`) plus the companion test file.
 *   - `generateFile` writes a single file (`controller` / `model` /
 *     `repository` / `schemas` / `mcp`).
 *
 * Both functions skip existing files with a clear console warning
 * (idempotent re-runs are safe) and use `node:fs` sync APIs — the CLI
 * is already synchronous in spirit and `Promise.all` parallelism on
 * file writes is not worth the readability tax.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toCamelCase } from "./name-helpers.js";
import { readProjectConfig } from "./project-config.js";
import type { GenerateTemplates } from "./templates.js";

export async function generateResource(
  name: string,
  lowerName: string,
  resourcePath: string,
  templates: GenerateTemplates,
  ext: string,
  includeMcp = false,
): Promise<void> {
  console.log(`\nGenerating resource: ${name}...\n`);

  // Create directory
  if (!existsSync(resourcePath)) {
    mkdirSync(resourcePath, { recursive: true });
    console.log(`  + Created: src/resources/${lowerName}/`);
  }

  // Generate files (defineResource() auto-creates controller, no schemas needed)
  const files: Record<string, string> = {
    [`${lowerName}.model.${ext}`]: templates.model(name, lowerName),
    [`${lowerName}.repository.${ext}`]: templates.repository(name, lowerName),
    [`${lowerName}.resource.${ext}`]: templates.resource(name, lowerName),
  };

  // Include MCP tools file if project uses MCP or --mcp flag passed
  if (includeMcp) {
    files[`${lowerName}.mcp.${ext}`] = templates.mcp(name, lowerName);
  }

  for (const [filename, content] of Object.entries(files)) {
    const filepath = join(resourcePath, filename);
    if (existsSync(filepath)) {
      console.warn(`  ! Skipped: ${filename} (already exists)`);
    } else {
      writeFileSync(filepath, content);
      console.log(`  + Created: ${filename}`);
    }
  }

  // Generate test file
  const testsDir = join(process.cwd(), "tests");
  if (!existsSync(testsDir)) {
    mkdirSync(testsDir, { recursive: true });
  }
  const testPath = join(testsDir, `${lowerName}.test.${ext}`);
  if (!existsSync(testPath)) {
    writeFileSync(testPath, templates.test(name, lowerName));
    console.log(`  + Created: tests/${lowerName}.test.${ext}`);
  }

  const camel = toCamelCase(name);
  const isMultiTenant = readProjectConfig().tenant === "multi";

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Resource Generated                         ║
╚═══════════════════════════════════════════════════════════════╝

Next steps:

1. Register in src/resources/index.${ext}:
   import ${camel}Resource from './${lowerName}/${lowerName}.resource.js';

   export const resources = [
     // ... existing resources
     ${camel}Resource,
   ];

2. Customize the model schema in:
   src/resources/${lowerName}/${lowerName}.model.${ext}

3. Adjust permissions in ${lowerName}.resource.${ext}:
${
  isMultiTenant
    ? `   - requireOrgMembership() → member of the current organization
   - multiTenantPreset()    → injects and filters organizationId
   - requireRoles(['admin']) → admin writes inside the org scope`
    : `   - requireAuth()          → any authenticated user
   - requireRoles(['admin']) → specific platform roles`
}

4. Run tests:
   npm test
${
  includeMcp
    ? `
5. MCP tools file created: ${lowerName}.mcp.${ext}
   Uncomment and customize the example tools.
   Import and add to extraTools in your mcpPlugin config.
`
    : ""
}`);
}

export async function generateFile(
  name: string,
  lowerName: string,
  resourcePath: string,
  fileType: string,
  template: (name: string, fileName: string) => string,
  ext: string,
): Promise<void> {
  console.log(`\nGenerating ${fileType}: ${name}...\n`);

  if (!existsSync(resourcePath)) {
    mkdirSync(resourcePath, { recursive: true });
    console.log(`  + Created: src/resources/${lowerName}/`);
  }

  const filename = `${lowerName}.${fileType}.${ext}`;
  const filepath = join(resourcePath, filename);

  if (existsSync(filepath)) {
    throw new Error(`${filename} already exists. Remove it first or use a different name.`);
  }

  writeFileSync(filepath, template(name, lowerName));
  console.log(`  + Created: ${filename}`);
}
