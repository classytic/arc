/**
 * `arc generate` orchestrator.
 *
 * Routes the user-supplied type (`resource` / `controller` / `model` /
 * `repository` / `schemas` / `mcp`, plus their short aliases) into the
 * matching file-writer call. The orchestrator owns:
 *
 *   - Name normalisation (kebab-case → PascalCase, kebab stays as the
 *     filename root).
 *   - The Better Auth-owned collection guard — refusing to generate a
 *     model named `user` / `organization` / etc. since BA writes those
 *     itself and a duplicate Mongoose registration silently collides.
 *   - Project-config detection (`.arcrc` + `tsconfig.json`) to pick the
 *     right template set + extension.
 *
 * Every step downstream is pure (templates) or local I/O (file-writer);
 * no network, no DB, no global state.
 */

import { join } from "node:path";
import { generateFile, generateResource } from "./file-writer.js";
import { toPascalCase } from "./name-helpers.js";
import { isTypeScriptProject, readProjectConfig } from "./project-config.js";
import { getTemplates } from "./templates.js";

export async function generate(type: string | undefined, args: string[]): Promise<void> {
  if (!type) {
    throw new Error(
      "Missing type argument\nUsage: arc generate <resource|controller|model|repository|schemas> <name>",
    );
  }

  const [name, ...restArgs] = args;
  if (!name) {
    throw new Error(
      "Missing name argument\nUsage: arc generate <type> <name>\nExample: arc generate resource product",
    );
  }

  // Validate the name BEFORE it touches the filesystem or a code template.
  // It flows into `join(cwd, "src/resources", name)` and into PascalCase TS
  // identifiers, so an unvalidated name is both a path-traversal sink
  // (`../../evil` escapes the project tree) and an invalid-code source
  // (dots/slashes/spaces produce garbage identifiers). A single kebab-ish
  // pattern with no path separators or dots closes both: a letter followed by
  // letters, digits, or hyphens.
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
    throw new Error(
      `Invalid name "${name}". Use kebab-case: a letter followed by letters, ` +
        "digits, or hyphens (e.g. 'product', 'order-line'). No slashes, dots, " +
        "spaces, or path segments.",
    );
  }

  // Convert kebab-case to PascalCase (e.g., org-profile → OrgProfile)
  const capitalizedName = toPascalCase(name);
  // Keep original kebab-case for file names (e.g., org-profile)
  const lowerName = name.toLowerCase();

  // Better Auth's `organization` plugin already manages these collections
  // — generating a duplicate model creates conflict (two Mongoose models
  // for the same collection, divergent Zod schemas). Surface as a warning
  // and point at the canonical overlay path instead of generating a stub.
  const BA_OWNED_COLLECTIONS = new Set([
    "user",
    "session",
    "account",
    "verification",
    "organization",
    "member",
    "invitation",
    "team",
    "team-member",
    "apikey",
  ]);
  if (
    (type === "resource" || type === "r" || type === "model" || type === "m") &&
    BA_OWNED_COLLECTIONS.has(lowerName)
  ) {
    console.warn(
      `\n[arc generate] "${lowerName}" is a Better Auth-owned collection.\n` +
        `Better Auth's organization/admin/bearer plugins write this collection directly,\n` +
        `so generating a parallel arc model would create a duplicate registration.\n\n` +
        `Recommended pattern:\n` +
        `  import { createBetterAuthOverlay } from '@classytic/mongokit/better-auth';\n` +
        `  const adapter = await createBetterAuthOverlay({\n` +
        `    auth, mongoose, collection: '${lowerName}',\n` +
        `  });\n` +
        `  // ...then \`defineResource({ name: '${lowerName}', adapter, ... })\` reads\n` +
        `  //    BA's collection through arc with full pagination/filters/permissions.\n\n` +
        `Aborting. Re-run with a different name if you need a separate domain model.\n`,
    );
    return;
  }

  // Detect project config
  const projectConfig = readProjectConfig();
  const ts = projectConfig.typescript ?? isTypeScriptProject();
  const ext = ts ? "ts" : "js";
  const templates = getTemplates(ts, projectConfig);

  // Resource path: src/resources/<name>/
  const resourcePath = join(process.cwd(), "src", "resources", lowerName);

  switch (type) {
    case "resource":
    case "r": {
      const includeMcp = projectConfig.mcp === true || restArgs.includes("--mcp");
      await generateResource(capitalizedName, lowerName, resourcePath, templates, ext, includeMcp);
      break;
    }

    case "controller":
    case "c":
      await generateFile(
        capitalizedName,
        lowerName,
        resourcePath,
        "controller",
        templates.controller,
        ext,
      );
      break;

    case "model":
    case "m":
      await generateFile(capitalizedName, lowerName, resourcePath, "model", templates.model, ext);
      break;

    case "repository":
    case "repo":
      await generateFile(
        capitalizedName,
        lowerName,
        resourcePath,
        "repository",
        templates.repository,
        ext,
      );
      break;

    case "schemas":
    case "s":
      await generateFile(
        capitalizedName,
        lowerName,
        resourcePath,
        "schemas",
        templates.schemas,
        ext,
      );
      break;

    case "mcp":
      await generateFile(capitalizedName, lowerName, resourcePath, "mcp", templates.mcp, ext);
      break;

    default:
      throw new Error(
        `Unknown type: ${type}\nAvailable types: resource, controller, model, repository, schemas, mcp`,
      );
  }
}
