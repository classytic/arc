/**
 * Scaffolding I/O — given a fully-resolved `ProjectConfig`, materialise
 * the project directory tree and write every template-produced file.
 *
 * Splitting this out of the orchestrator keeps `init()` focused on
 * lifecycle (validation, prompts, package-manager work) while the
 * directory layout + file-fanout logic lives here. Templates remain
 * pure — this module is the only place file I/O happens.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createAdapterTemplate, customAdapterTemplate } from "./templates/adapter.js";
import { appTemplate, envLoaderTemplate, indexTemplate } from "./templates/app.js";
import {
  authHandlersTemplate,
  authResourceTemplate,
  authSchemasTemplate,
  authTestTemplate,
  betterAuthSetupTemplate,
} from "./templates/auth.js";
import {
  biomeTemplate,
  ciWorkflowTemplate,
  configTemplate,
  envDevTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  packageJsonTemplate,
  readmeTemplate,
  tsconfigTemplate,
  vitestConfigTemplate,
} from "./templates/config.js";
import {
  dockerComposeTemplate,
  dockerfileTemplate,
  dockerignoreTemplate,
  wranglerTemplate,
} from "./templates/docker.js";
import {
  exampleControllerTemplate,
  exampleModelTemplate,
  exampleRepositoryTemplate,
  exampleResourceTemplate,
  exampleSchemasTemplate,
  exampleTestTemplate,
} from "./templates/example.js";
import { permissionsTemplate } from "./templates/permissions.js";
import { pluginsIndexTemplate } from "./templates/plugins.js";
import {
  flexibleMultiTenantPresetTemplate,
  presetsMultiTenantTemplate,
  presetsSingleTenantTemplate,
} from "./templates/presets.js";
import { resourcesIndexTemplate, sharedIndexTemplate } from "./templates/resources.js";
import {
  userControllerTemplate,
  userModelTemplate,
  userRepositoryTemplate,
} from "./templates/user.js";
import type { ProjectConfig } from "./types.js";

export async function createProjectStructure(
  projectPath: string,
  config: ProjectConfig,
): Promise<void> {
  const ext = config.typescript ? "ts" : "js";

  // Create directories - Clean architecture (organized by resource, no barrels)
  const dirs = [
    "",
    "src",
    "src/config", // Config & env loading (import first!)
    "src/shared", // Shared utilities (adapters, presets, permissions)
    "src/shared/presets", // Preset definitions
    "src/plugins", // App-specific plugins
    "src/resources", // Resource definitions
    ...(config.auth === "jwt"
      ? [
          "src/resources/user", // User resource (user.model, user.repository, etc.)
          "src/resources/auth", // Auth resource (auth.resource, auth.handlers, etc.)
        ]
      : []),
    "src/resources/example", // Example resource
    "tests",
  ];

  for (const dir of dirs) {
    await fs.mkdir(path.join(projectPath, dir), { recursive: true });
    console.log(`  + Created: ${dir || "/"}`);
  }

  // Generate and write files
  const files: Record<string, string> = {
    "package.json": packageJsonTemplate(config),
    ".gitignore": gitignoreTemplate(),
    ".env.example": envExampleTemplate(config),
    ".env.dev": envDevTemplate(config),
    "README.md": readmeTemplate(config),
    // Quality tooling — lint/format + CI wired out of the box
    "biome.json": biomeTemplate(),
    ".github/workflows/ci.yml": ciWorkflowTemplate(config),
  };

  // TypeScript config
  if (config.typescript) {
    files["tsconfig.json"] = tsconfigTemplate();
  }

  // Vitest config (always needed for path alias resolution)
  files["vitest.config.ts"] = vitestConfigTemplate(config);

  // Config files (env loader FIRST - imported before everything)
  files[`src/config/env.${ext}`] = envLoaderTemplate(config);
  files[`src/config/index.${ext}`] = configTemplate(config);

  // App factory + Entry point (separation for workers/tests)
  files[`src/app.${ext}`] = appTemplate(config);
  files[`src/index.${ext}`] = indexTemplate(config);

  // Shared utilities
  files[`src/shared/index.${ext}`] = sharedIndexTemplate(config);
  files[`src/shared/adapter.${ext}`] =
    config.adapter === "mongokit" ? createAdapterTemplate(config) : customAdapterTemplate(config);
  files[`src/shared/permissions.${ext}`] = permissionsTemplate(config);

  // Presets
  if (config.tenant === "multi") {
    files[`src/shared/presets/index.${ext}`] = presetsMultiTenantTemplate(config);
    files[`src/shared/presets/flexible-multi-tenant.${ext}`] =
      flexibleMultiTenantPresetTemplate(config);
  } else {
    files[`src/shared/presets/index.${ext}`] = presetsSingleTenantTemplate(config);
  }

  // Plugins (app-specific, easy to extend)
  files[`src/plugins/index.${ext}`] = pluginsIndexTemplate(config);

  // Resources (organized by folder, no barrels - prefixed filenames)
  files[`src/resources/index.${ext}`] = resourcesIndexTemplate(config);

  // Auth setup — depends on strategy
  if (config.auth === "better-auth") {
    // Better Auth: single config file, no manual auth handlers
    files[`src/auth.${ext}`] = betterAuthSetupTemplate(config);
  } else {
    // JWT: manual user model + auth handlers
    files[`src/resources/user/user.model.${ext}`] = userModelTemplate(config);
    files[`src/resources/user/user.repository.${ext}`] = userRepositoryTemplate(config);
    files[`src/resources/user/user.controller.${ext}`] = userControllerTemplate(config);
    files[`src/resources/auth/auth.resource.${ext}`] = authResourceTemplate(config);
    files[`src/resources/auth/auth.handlers.${ext}`] = authHandlersTemplate(config);
    files[`src/resources/auth/auth.schemas.${ext}`] = authSchemasTemplate(config);
  }

  // Example resource (src/resources/example/)
  files[`src/resources/example/example.model.${ext}`] = exampleModelTemplate(config);
  files[`src/resources/example/example.repository.${ext}`] = exampleRepositoryTemplate(config);
  files[`src/resources/example/example.resource.${ext}`] = exampleResourceTemplate(config);
  files[`src/resources/example/example.controller.${ext}`] = exampleControllerTemplate(config);
  files[`src/resources/example/example.schemas.${ext}`] = exampleSchemasTemplate(config);

  // Tests
  files[`tests/example.test.${ext}`] = exampleTestTemplate(config);
  if (config.auth === "jwt") {
    files[`tests/auth.test.${ext}`] = authTestTemplate(config);
  }

  // Docker Containerization — OPT-IN (2.16). Frameworks don't dictate
  // deployment topology; hosts ship to Cloud Run / Fly / Vercel / AWS
  // Lambda / their own k8s manifests and the unsolicited Docker assets
  // were noise in those workflows. Emit only when explicitly requested
  // via `--docker` (or the interactive prompt's `y` answer). `edge: true`
  // still suppresses Docker — Workers don't run in containers.
  if (config.docker && !config.edge) {
    files.Dockerfile = dockerfileTemplate(config);
    files[".dockerignore"] = dockerignoreTemplate();
    files["docker-compose.yml"] = dockerComposeTemplate(config);
  }

  // Edge/Serverless deployment config
  if (config.edge) {
    files["wrangler.toml"] = wranglerTemplate(config);
  }

  // Save project config for CLI tools (generate, etc.)
  files[".arcrc"] = `${JSON.stringify(
    {
      adapter: config.adapter,
      auth: config.auth,
      tenant: config.tenant,
      typescript: config.typescript,
    },
    null,
    2,
  )}\n`;

  // Write all files
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(projectPath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    console.log(`  + Created: ${filePath}`);
  }
}

/** Print the post-scaffold success message — next steps for the user. */
export function printSuccessMessage(config: ProjectConfig, skipInstall?: boolean): void {
  const installStep = skipInstall ? `  npm install\n` : "";
  const ext = config.typescript ? "ts" : "js";

  const authInfo =
    config.auth === "better-auth"
      ? `
Auth (Better Auth):

  Auth routes:  http://localhost:8040/api/auth/*
  Better Auth handles: registration, login, sessions, OAuth
  Config file:  src/auth.${ext}
`
      : `
Auth (JWT):

  POST /auth/register      # Register
  POST /auth/login         # Login (returns JWT)
  POST /auth/refresh       # Refresh token
  GET  /users/me           # Current user profile
`;

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Project Created                             ║
╚═══════════════════════════════════════════════════════════════╝

Next steps:

  cd ${config.name}
${installStep}  npm run dev         # Uses .env.dev automatically
${authInfo}
API Documentation:

  http://localhost:8040/docs           # Scalar UI
  http://localhost:8040/_docs/openapi.json  # OpenAPI spec

Run tests:

  npm test            # Run once
  npm run test:watch  # Watch mode

Add resources:

  arc generate resource product

Project structure:

  src/
  ├── app.${ext}        # App factory (for workers/tests)
  ├── index.${ext}      # Server entry${config.auth === "better-auth" ? `\n  ├── auth.${ext}       # Better Auth config` : ""}
  ├── config/       # Configuration
  ├── shared/       # Adapters, presets, permissions
  ├── plugins/      # App plugins (DI pattern)
  └── resources/    # API resources

Documentation:
  https://github.com/classytic/arc
`);
}
