/**
 * `arc init` orchestrator — banners, prompt-gathering, scaffold writing,
 * dependency installation. Every step lives in its own module under
 * `./`; this file owns the lifecycle and the user-facing console output
 * (`src/cli/` is the one place in arc that's allowed to speak directly
 * to `console.*` — see CLAUDE.md).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createProjectStructure, printSuccessMessage } from "./file-writer.js";
import { gatherConfig } from "./options.js";
import { detectPackageManager, formatProject, installDependencies } from "./postinstall.js";
import type { InitOptions } from "./types.js";

export type { DependencyManifest, InitOptions, PackageManager, ProjectConfig } from "./types.js";

/**
 * Initialize a new Arc project.
 */
export async function init(options: InitOptions = {}): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Arc Project Setup                           ║
║         Resource-Oriented Backend Framework                   ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Gather configuration (from options or prompts)
  const config = await gatherConfig(options);

  console.log(`\nCreating project: ${config.name}`);
  console.log(
    `   Adapter: ${config.adapter === "mongokit" ? "MongoKit (MongoDB)" : "Custom / Drizzle-ready"}`,
  );
  console.log(
    `   Auth: ${config.auth === "better-auth" ? "Better Auth (recommended)" : "Arc JWT"}`,
  );
  if (config.auth === "better-auth") {
    console.log(
      `   Session: ${config.session === "cookie" ? "Cookie" : config.session === "bearer" ? "Bearer token" : "Cookie + Bearer"}`,
    );
    if (config.apiKey) console.log(`   API keys: enabled (@better-auth/api-key)`);
  }
  console.log(`   Tenant: ${config.tenant === "multi" ? "Multi-tenant" : "Single-tenant"}`);
  console.log(`   Language: ${config.typescript ? "TypeScript" : "JavaScript"}`);
  console.log(`   Target: ${config.edge ? "Edge/Serverless" : "Node.js Server"}`);
  // 2.16 — only echo when opted in. Default (false) stays silent so the
  // summary doesn't advertise scaffolding the host explicitly skipped.
  if (config.docker) console.log(`   Docker: included (--docker)`);
  console.log("");

  const projectPath = path.join(process.cwd(), config.name);

  // Check if directory exists
  try {
    await fs.access(projectPath);
    // If we reach here, the directory EXISTS
    if (!options.force) {
      throw new Error(`Directory "${config.name}" already exists. Use --force to overwrite.`);
    }
  } catch (err) {
    // ENOENT = directory doesn't exist = good, fall through to scaffolding
    const isNotFound = err && typeof err === "object" && "code" in err && err.code === "ENOENT";
    if (!isNotFound) throw err;
    // else: directory doesn't exist, continue normally
  }

  // Detect package manager
  const packageManager = detectPackageManager();
  console.log(`Using package manager: ${packageManager}\n`);

  // Create project structure (without dependencies in package.json)
  await createProjectStructure(projectPath, config);

  // Install dependencies unless --skip-install
  if (!options.skipInstall) {
    console.log("\n📥 Installing dependencies...\n");
    await installDependencies(projectPath, config, packageManager);
    // Normalize to Biome house style so `npm run lint` is green on first run.
    await formatProject(projectPath, packageManager);
  }

  // Print success message
  printSuccessMessage(config, options.skipInstall);
}
