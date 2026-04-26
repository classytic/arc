/**
 * Arc CLI - Init Command
 *
 * Scaffolds a new Arc project with clean architecture:
 * - MongoKit or Custom adapter
 * - Multi-tenant or Single-tenant
 * - TypeScript or JavaScript
 *
 * Automatically installs dependencies using detected package manager.
 */

import { execSync, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// ============================================================================
// Types
// ============================================================================

export interface InitOptions {
  name?: string;
  adapter?: "mongokit" | "custom";
  auth?: "jwt" | "better-auth";
  tenant?: "multi" | "single";
  typescript?: boolean;
  edge?: boolean;
  skipInstall?: boolean;
  force?: boolean;
}

interface ProjectConfig {
  name: string;
  adapter: "mongokit" | "custom";
  auth: "jwt" | "better-auth";
  tenant: "multi" | "single";
  typescript: boolean;
  edge: boolean;
}

// ============================================================================
// Main Init Function
// ============================================================================

/**
 * Initialize a new Arc project
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
  console.log(`   Tenant: ${config.tenant === "multi" ? "Multi-tenant" : "Single-tenant"}`);
  console.log(`   Language: ${config.typescript ? "TypeScript" : "JavaScript"}`);
  console.log(`   Target: ${config.edge ? "Edge/Serverless" : "Node.js Server"}\n`);

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
  }

  // Print success message
  printSuccessMessage(config, options.skipInstall);
}

// ============================================================================
// Package Manager Detection & Installation
// ============================================================================

/**
 * Detect which package manager to use
 * Priority: pnpm > yarn > bun > npm (based on lockfile or global availability)
 */
function detectPackageManager(): PackageManager {
  // Check for lockfiles in current directory (user preference)
  try {
    const cwd = process.cwd();
    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
    if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
    if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  } catch {
    // Ignore errors
  }

  // Check which package managers are available
  if (isCommandAvailable("pnpm")) return "pnpm";
  if (isCommandAvailable("yarn")) return "yarn";
  if (isCommandAvailable("bun")) return "bun";

  // Default to npm
  return "npm";
}

/**
 * Check if a command is available in PATH
 */
function isCommandAvailable(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync check if file exists (ESM-compatible — no require())
 */
function existsSync(filePath: string): boolean {
  try {
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install dependencies using the detected package manager
 */
async function installDependencies(
  projectPath: string,
  config: ProjectConfig,
  pm: PackageManager,
): Promise<void> {
  // Build dependency lists
  const deps = [
    "@classytic/arc@latest",
    "fastify@latest",
    "@fastify/cors@latest",
    "@fastify/helmet@latest",
    "@fastify/rate-limit@latest",
    "@fastify/sensible@latest",
    "@fastify/under-pressure@latest",
    "dotenv@latest",
  ];

  // Pin optional peer deps to versions that match Arc's peerDependencies range.
  // Using `@latest` here is unsafe because users could install a version below
  // Arc's minimum (e.g. mongoose < 9.4.1, mongokit < 3.10.2) and hit silent
  // runtime breakage. The semver caret floors at the minimum Arc supports while
  // still allowing minor + patch upgrades.
  if (config.auth === "better-auth") {
    deps.push("better-auth@^1.6.0", "mongodb@latest");
  } else {
    deps.push("@fastify/jwt@latest", "bcryptjs@latest");
  }

  if (config.adapter === "mongokit") {
    deps.push("@classytic/mongokit@^3.11.0", "@classytic/repo-core@^0.2.0", "mongoose@^9.4.1");
  }

  const devDeps = ["vitest@latest", "pino-pretty@latest"];

  if (config.typescript) {
    devDeps.push("typescript@latest", "@types/node@latest", "tsx@latest");
  }

  // Build install commands based on package manager
  const installCmd = getInstallCommand(pm, deps, false);
  const installDevCmd = getInstallCommand(pm, devDeps, true);

  // Run installation
  console.log(`  Installing dependencies...`);
  await runCommand(installCmd, projectPath);

  console.log(`  Installing dev dependencies...`);
  await runCommand(installDevCmd, projectPath);

  console.log(`\nDependencies installed successfully.`);
}

/**
 * Get the install command for a package manager
 */
function getInstallCommand(pm: PackageManager, packages: string[], isDev: boolean): string {
  const pkgList = packages.join(" ");

  switch (pm) {
    case "pnpm":
      return `pnpm add ${isDev ? "-D" : ""} ${pkgList}`;
    case "yarn":
      return `yarn add ${isDev ? "-D" : ""} ${pkgList}`;
    case "bun":
      return `bun add ${isDev ? "-d" : ""} ${pkgList}`;
    default:
      return `npm install ${isDev ? "--save-dev" : ""} ${pkgList}`;
  }
}

/**
 * Run a shell command in a directory
 */
function runCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd" : "/bin/sh";
    const shellFlag = isWindows ? "/c" : "-c";

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

// ============================================================================
// Configuration Gathering
// ============================================================================

async function gatherConfig(options: InitOptions): Promise<ProjectConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // Non-interactive mode: if a project name was provided via args, skip prompts
  // and use defaults for any unspecified options
  const nonInteractive = !!options.name;

  try {
    // Project name
    const name = options.name || (await question("Project name: ")) || "my-arc-app";

    // Adapter choice
    let adapter: "mongokit" | "custom" = options.adapter || "mongokit";
    if (!options.adapter && !nonInteractive) {
      const adapterChoice = await question(
        "Database adapter [1=MongoKit (recommended), 2=Custom / Drizzle-ready]: ",
      );
      adapter = adapterChoice === "2" ? "custom" : "mongokit";
    }

    // Auth strategy
    let auth: "jwt" | "better-auth" = options.auth || "better-auth";
    if (!options.auth && !nonInteractive) {
      const authChoice = await question("Auth strategy [1=Better Auth (recommended), 2=Arc JWT]: ");
      auth = authChoice === "2" ? "jwt" : "better-auth";
    }

    // Tenant mode
    let tenant: "multi" | "single" = options.tenant || "single";
    if (!options.tenant && !nonInteractive) {
      const tenantChoice = await question("Tenant mode [1=Single-tenant, 2=Multi-tenant]: ");
      tenant = tenantChoice === "2" ? "multi" : "single";
    }

    // TypeScript or JavaScript
    let typescript = options.typescript ?? true;
    if (options.typescript === undefined && !nonInteractive) {
      const tsChoice = await question("Language [1=TypeScript (recommended), 2=JavaScript]: ");
      typescript = tsChoice !== "2";
    }

    // Environment/Target choice
    let edge = options.edge ?? false;
    if (options.edge === undefined && !nonInteractive) {
      const edgeChoice = await question(
        "Deployment target [1=Node.js Server (default), 2=Edge/Serverless]: ",
      );
      edge = edgeChoice === "2";
    }

    // Warn about edge + database compatibility
    if (edge && adapter === "mongokit" && !nonInteractive) {
      console.log("");
      console.log("  ⚠ Edge + MongoKit: Mongoose does NOT work on Cloudflare Workers.");
      console.log(
        "    MongoDB Atlas works with the raw driver (mongodb 6.15+ with nodejs_compat_v2),",
      );
      console.log("    but MongoKit depends on Mongoose. Options:");
      console.log("    1. Use AWS Lambda / Vercel Serverless (Node.js) — Mongoose works normally");
      console.log(
        "    2. Use Cloudflare Hyperdrive + PostgreSQL (wire sqlitekit/Drizzle via custom adapter)",
      );
      console.log(
        "    3. Continue with MongoKit — works on Lambda/Vercel, NOT on Cloudflare Workers",
      );
      console.log("");
      const proceed = await question("Continue with MongoKit? [y/N]: ");
      if (proceed.toLowerCase() !== "y") {
        adapter = "custom";
        console.log(
          "  Switched to custom adapter. Wire sqlitekit/Drizzle here; Prisma remains experimental.",
        );
      }
    }

    return { name, adapter, auth, tenant, typescript, edge };
  } finally {
    rl.close();
  }
}

// ============================================================================
// Project Structure Creation
// ============================================================================

async function createProjectStructure(projectPath: string, config: ProjectConfig): Promise<void> {
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

  // Docker Containerization (Node.js server only)
  if (!config.edge) {
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

// ============================================================================
// Templates
// ============================================================================

function packageJsonTemplate(config: ProjectConfig): string {
  // Minimal package.json - dependencies are installed via package manager
  const scripts: Record<string, string> = config.typescript
    ? config.edge
      ? {
          dev: "tsx watch src/index.ts",
          build: "tsc",
          start: "node dist/index.js",
          deploy: "wrangler deploy",
          "deploy:dev": "wrangler dev",
          test: "vitest run",
          "test:watch": "vitest",
        }
      : {
          dev: "tsx watch src/index.ts",
          build: "tsc",
          start: "node dist/index.js",
          test: "vitest run",
          "test:watch": "vitest",
        }
    : config.edge
      ? {
          dev: "node --watch src/index.js",
          start: "node src/index.js",
          deploy: "wrangler deploy",
          "deploy:dev": "wrangler dev",
          test: "vitest run",
          "test:watch": "vitest",
        }
      : {
          dev: "node --watch src/index.js",
          start: "node src/index.js",
          test: "vitest run",
          "test:watch": "vitest",
        };

  // Subpath imports — always point to ./src/ for tsx dev mode.
  // Production builds (tsc → dist/) can override via tsconfig paths or build step.
  const imports: Record<string, string> = {
    "#config/*": "./src/config/*",
    "#shared/*": "./src/shared/*",
    "#resources/*": "./src/resources/*",
    "#plugins/*": "./src/plugins/*",
    "#services/*": "./src/services/*",
    "#lib/*": "./src/lib/*",
    "#utils/*": "./src/utils/*",
  };

  return JSON.stringify(
    {
      name: config.name,
      version: "1.0.0",
      type: "module",
      main: config.typescript ? "dist/index.js" : "src/index.js",
      imports,
      scripts,
      // Must match @classytic/arc's own `engines.node` requirement — the
      // framework drops Node 20 APIs in core paths (e.g. structured clone
      // via node:util, require.main semantics), so scaffolding apps that
      // claim `>=20` is a real contract bug, not a style nit. Keep in lock
      // step with the root package.json and enforce via the regression test
      // at tests/cli/init-scaffolding.test.ts (look for `engines.node`).
      engines: {
        node: ">=22",
      },
    },
    null,
    2,
  );
}

function tsconfigTemplate(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        resolveJsonModule: true,
        paths: {
          "#shared/*": ["./src/shared/*"],
          "#resources/*": ["./src/resources/*"],
          "#config/*": ["./src/config/*"],
          "#plugins/*": ["./src/plugins/*"],
        },
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2,
  );
}

function vitestConfigTemplate(config: ProjectConfig): string {
  const srcDir = config.typescript ? "./src" : "./src";

  return `import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '#config': resolve(__dirname, '${srcDir}/config'),
      '#shared': resolve(__dirname, '${srcDir}/shared'),
      '#resources': resolve(__dirname, '${srcDir}/resources'),
      '#plugins': resolve(__dirname, '${srcDir}/plugins'),
    },
  },
});
`;
}

function gitignoreTemplate(): string {
  return `# Dependencies
node_modules/

# Build
dist/
*.js.map

# Environment (local overrides — never commit secrets)
.env.local
.env.*.local
# Uncomment if your .env contains secrets:
# .env

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Test coverage
coverage/
`;
}

function envExampleTemplate(config: ProjectConfig): string {
  let content = `# Environment Files (Next.js-style priority):
#   .env.local         → machine-specific overrides (gitignored)
#   .env.production    → production defaults
#   .env.development   → development defaults (or .env.dev)
#   .env               → shared defaults (fallback)
#
# Tip: Copy this file to .env.local for local development

# Server
PORT=8040
HOST=0.0.0.0
NODE_ENV=development
`;

  if (config.auth === "better-auth") {
    content += `
# Better Auth
BETTER_AUTH_SECRET=your-32-character-minimum-secret-here
FRONTEND_URL=http://localhost:3000

# Google OAuth (optional)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
`;
  } else {
    content += `
# JWT
JWT_SECRET=your-32-character-minimum-secret-here
JWT_EXPIRES_IN=7d
`;
  }

  content += `
# CORS - Allowed origins
# Options:
#   * = allow all origins (not recommended for production)
#   Comma-separated list = specific origins only
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
`;

  if (config.adapter === "mongokit") {
    content += `
# MongoDB
MONGODB_URI=mongodb://localhost:27017/${config.name}
`;
  }

  if (config.tenant === "multi") {
    content += `
# Multi-tenant
ORG_HEADER=x-organization-id
`;
  }

  return content;
}

function readmeTemplate(config: ProjectConfig): string {
  const ext = config.typescript ? "ts" : "js";

  return `# ${config.name}

Built with [Arc](https://github.com/classytic/arc) - Resource-Oriented Backend Framework

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Start development server (uses .env.dev)
npm run dev

# Run tests
npm test
\`\`\`

## Project Structure

\`\`\`
src/
├── config/                  # Configuration (loaded first)
│   ├── env.${ext}              # Env loader (import first!)
│   └── index.${ext}            # App config
├── shared/                  # Shared utilities
│   ├── adapter.${ext}          # ${config.adapter === "mongokit" ? "MongoKit adapter factory" : "Custom / Drizzle-ready adapter"}
│   ├── permissions.${ext}      # Permission helpers
│   └── presets/             # ${config.tenant === "multi" ? "Multi-tenant presets" : "Standard presets"}
├── plugins/                 # App-specific plugins
│   └── index.${ext}            # Plugin registry
├── resources/               # API Resources
│   ├── index.${ext}            # Resource registry
│   └── example/             # Example resource
│       ├── index.${ext}        # Resource definition
│       ├── model.${ext}        # Mongoose schema
│       └── repository.${ext}   # MongoKit repository
├── app.${ext}                  # App factory (reusable)
└── index.${ext}                # Server entry point
tests/
└── example.test.${ext}         # Example tests
\`\`\`

## Architecture

### Entry Points

- **\`src/index.${ext}\`** - ${config.edge ? "Edge/serverless fetch handler (Cloudflare Workers, Lambda, Vercel)" : "HTTP server entry point"}
- **\`src/app.${ext}\`** - App factory (import for workers/tests)

\`\`\`${config.typescript ? "typescript" : "javascript"}
// For workers or custom entry points:
import { createAppInstance } from './app.js';

const app = await createAppInstance();
// Use app for your worker logic
\`\`\`

### Adding Resources

1. Create a new folder in \`src/resources/\`:

\`\`\`
src/resources/product/
├── index.${ext}      # Resource definition
├── model.${ext}      # Mongoose schema
└── repository.${ext} # MongoKit repository
\`\`\`

2. Register in \`src/resources/index.${ext}\`:

\`\`\`${config.typescript ? "typescript" : "javascript"}
import productResource from './product/index.js';

export const resources = [
  exampleResource,
  productResource,  // Add here
];
\`\`\`

### Adding Plugins

Add custom plugins in \`src/plugins/index.${ext}\`:

\`\`\`${config.typescript ? "typescript" : "javascript"}
export async function registerPlugins(app, deps) {
  const { config } = deps;  // Explicit dependency injection

  await app.register(myCustomPlugin, { ...options });
}
\`\`\`

## CLI Commands

\`\`\`bash
# Generate a new resource
arc generate resource product

# Introspect existing schema
arc introspect

# Generate API docs
arc docs
\`\`\`

## Environment Files (Next.js-style)

Priority (first loaded wins):
1. \`.env.local\` — Machine-specific overrides (gitignored)
2. \`.env.{environment}\` — e.g., \`.env.production\`, \`.env.development\`, \`.env.test\`
3. \`.env\` — Shared defaults (fallback)

Short forms also supported: \`.env.prod\`, \`.env.dev\`, \`.env.test\`

## API Documentation

API documentation is available via Scalar UI:

- **Interactive UI**: [http://localhost:8040/docs](http://localhost:8040/docs)
- **OpenAPI Spec**: [http://localhost:8040/_docs/openapi.json](http://localhost:8040/_docs/openapi.json)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /docs | API documentation (Scalar UI) |
| GET | /_docs/openapi.json | OpenAPI 3.0 spec |
| GET | /examples | List all |
| GET | /examples/:id | Get by ID |
| POST | /examples | Create |
| PATCH | /examples/:id | Update |
| DELETE | /examples/:id | Delete |

## Docker Deployment

This project comes ready for containerization:

\`\`\`bash
# Build the production image
docker build -t ${config.name} .

# Run the container
docker run -p 8040:8040 --env-file .env ${config.name}
\`\`\`

If you're using a database (like MongoDB), you can use Docker Compose to spin up the full stack locally:

\`\`\`bash
docker-compose up -d
\`\`\`
`;
}

function indexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  if (config.edge) {
    return edgeIndexTemplate(config);
  }

  return `/**
 * ${config.name} - Server Entry Point
 * Generated by Arc CLI
 *
 * This file starts the HTTP server.
 * For workers or other entry points, import createAppInstance from './app.js'
 */

// Load environment FIRST (before any other imports)
import '#config/env.js';

import config from '#config/index.js';
${config.adapter === "mongokit" ? "import mongoose from 'mongoose';" : ""}
import { createAppInstance } from './app.js';

async function main()${ts ? ": Promise<void>" : ""} {
  console.log(\`Environment: \${config.env}\`);
${
  config.adapter === "mongokit"
    ? `
  // Connect to MongoDB
  await mongoose.connect(config.database.uri);
  console.log('Connected to MongoDB');
`
    : ""
}
  // Create and configure app
  const app = await createAppInstance();

  // Start server
  await app.listen({ port: config.server.port, host: config.server.host });
  console.log(\`Server running at http://\${config.server.host}:\${config.server.port}\`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
`;
}

/**
 * Edge/serverless entry point — exports a Web Standards fetch handler.
 * Works on Cloudflare Workers, AWS Lambda, Vercel Serverless, etc.
 */
function edgeIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  const dbNote =
    config.adapter === "mongokit"
      ? ` *\n * NOTE: Mongoose does NOT work on Cloudflare Workers. This entry point\n * works on AWS Lambda and Vercel Serverless (Node.js runtime) where\n * Mongoose/MongoKit works normally. For Cloudflare Workers, switch to\n * Drizzle + Hyperdrive (PostgreSQL) or the raw mongodb driver.`
      : "";

  return `/**
 * ${config.name} - Edge/Serverless Entry Point
 * Generated by Arc CLI
 *
 * Exports a Web Standards fetch handler that works on:
 * - Cloudflare Workers (enable nodejs_compat in wrangler.toml)
 * - AWS Lambda (via fetch-based adapter)
 * - Vercel Serverless Functions
 * - Any runtime supporting the Web Standards Request/Response API
 *
 * No app.listen() — routes through Fastify's .inject() internally.
${dbNote}
 */

import { toFetchHandler } from '@classytic/arc/factory';
import { createAppInstance } from './app.js';

const app = await createAppInstance();
const handler = toFetchHandler(app);

/**
 * Cloudflare Workers / generic fetch handler
 */
export default {
  async fetch(request${ts ? ": Request" : ""})${ts ? ": Promise<Response>" : ""} {
    return handler(request);
  },
};

/**
 * Named export for platforms that expect it (Vercel, AWS Lambda adapters)
 */
export { handler };
`;
}

function appTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : "";

  const betterAuthImport =
    config.auth === "better-auth"
      ? `import { createBetterAuthAdapter } from '@classytic/arc/auth';
import { getAuth } from './auth.js';
`
      : "";

  const authConfig =
    config.auth === "better-auth"
      ? config.tenant === "multi"
        ? `auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth: getAuth(), orgContext: true }) },`
        : `auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth: getAuth() }) },`
      : `auth: {
      type: 'jwt',
      jwt: { secret: config.jwt.secret },
    },`;

  return `/**
 * ${config.name} - App Factory
 * Generated by Arc CLI
 *
 * Creates and configures the Fastify app instance.
 * Can be imported by:
 * - index.ts (HTTP server via app.listen, or edge handler via toFetchHandler)
 * - worker.ts (background workers)
 * - tests (integration tests via app.inject)
 */

${typeImport}import config from '#config/index.js';
import { createApp, loadResources } from '@classytic/arc/factory';
${betterAuthImport}
// App-specific plugins
import { registerPlugins } from '#plugins/index.js';

// Resource registry
import { resources, registerResources } from '#resources/index.js';

/**
 * Create a fully configured app instance
 *
 * @returns Configured Fastify instance ready to use
 */
export async function createAppInstance()${ts ? ": Promise<FastifyInstance>" : ""} {
  // Create Arc app with resources and base configuration
  const app = await createApp({
    preset: config.env === 'production' ? (${config.edge ? "'edge'" : "'production'"}) : 'development',
    resources,
    ${authConfig}
    cors: {
      origin: config.cors.origins,
      methods: config.cors.methods,
      allowedHeaders: config.cors.allowedHeaders,
      credentials: config.cors.credentials,
    },
    trustProxy: true,
    arcPlugins: {
      metrics: config.env === 'production',  // Prometheus /_metrics endpoint
    },
  });

  // Register app-specific plugins (explicit dependency injection)
  await registerPlugins(app, { config });

  return app;
}

export default createAppInstance;
`;
}

function envLoaderTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Environment Loader
 *
 * MUST be imported FIRST before any other imports.
 * Loads .env files based on NODE_ENV with Next.js-style priority:
 *
 *   .env.local        (always loaded first — gitignored, machine-specific overrides)
 *   .env.{environment} (e.g., .env.production, .env.dev, .env.test)
 *   .env              (fallback defaults)
 *
 * Supports both long-form (production, development, test) and
 * short-form (prod, dev, test) env file names.
 *
 * Usage:
 *   import '#config/env.js';  // First line of entry point
 */

import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

${ts ? "type EnvName = 'prod' | 'dev' | 'test';\n" : ""}const ENV_ALIASES${ts ? ": Record<EnvName, string>" : ""} = {
  prod: 'production',
  dev: 'development',
  test: 'test',
};

function normalizeEnv(env${ts ? ": string | undefined" : ""})${ts ? ": EnvName" : ""} {
  const raw = (env || '').toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'prod';
  if (raw === 'test' || raw === 'qa') return 'test';
  return 'dev';
}

const env = normalizeEnv(process.env.NODE_ENV);
const longForm = ENV_ALIASES[env];

// Priority: .env.local → .env.{long} → .env.{short} → .env
// Same convention as Next.js — .env.local always wins, never committed to git
const candidates = [
  '.env.local',
  \`.env.\${longForm}\`,
  \`.env.\${env}\`,
  '.env',
].map((f) => resolve(process.cwd(), f));

const loaded${ts ? ": string[]" : ""} = [];
for (const file of candidates) {
  if (existsSync(file)) {
    // override: false means earlier files take priority (first loaded wins)
    dotenv.config({ path: file, override: false });
    loaded.push(file.split(/[\\\\/]/).pop()${ts ? "!" : ""});
  }
}

// Only log in development (silent in production/test)
if (env === 'dev' && loaded.length > 0) {
  console.log(\`env: \${loaded.join(' + ')}\`);
} else if (loaded.length === 0) {
  console.warn('No .env file found — using process environment only');
}

export const ENV = env;
`;
}

function envDevTemplate(config: ProjectConfig): string {
  let content = `# Development Environment
NODE_ENV=development

# Server
PORT=8040
HOST=0.0.0.0
`;

  if (config.auth === "better-auth") {
    content += `
# Better Auth
BETTER_AUTH_SECRET=dev-secret-change-in-production-min-32-chars
FRONTEND_URL=http://localhost:3000

# Google OAuth (optional — leave empty to disable)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
`;
  } else {
    content += `
# JWT
JWT_SECRET=dev-secret-change-in-production-min-32-chars
JWT_EXPIRES_IN=7d
`;
  }

  content += `
# CORS - Allowed origins
# Options:
#   * = allow all origins (not recommended for production)
#   Comma-separated list = specific origins only
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
`;

  if (config.adapter === "mongokit") {
    content += `
# MongoDB
MONGODB_URI=mongodb://localhost:27017/${config.name}
`;
  }

  if (config.tenant === "multi") {
    content += `
# Multi-tenant
ORG_HEADER=x-organization-id
`;
  }

  return content;
}

function pluginsIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : "";
  const configType = ts ? ": { config: AppConfig }" : "";
  const appType = ts ? ": FastifyInstance" : "";

  let content = `/**
 * App Plugins Registry
 *
 * Register your app-specific plugins here.
 * Dependencies are passed explicitly (no shims, no magic).
 */

${typeImport}${ts ? "import type { AppConfig } from '../config/index.js';\n" : ""}import { openApiPlugin, scalarPlugin } from '@classytic/arc/docs';
import { errorHandlerPlugin } from '@classytic/arc/plugins';
`;

  content += `
/**
 * Register all app-specific plugins
 *
 * @param app - Fastify instance
 * @param deps - Explicit dependencies (config, services, etc.)
 */
export async function registerPlugins(
  app${appType},
  deps${configType}
)${ts ? ": Promise<void>" : ""} {
  const { config } = deps;

  // Error handling (CastError → 400, validation → 422, duplicate → 409)
  await app.register(errorHandlerPlugin, {
    includeStack: config.isDev,
  });

  // API Documentation (Scalar UI)
  // OpenAPI spec: /_docs/openapi.json
  // Scalar UI: /docs
  await app.register(openApiPlugin, {
    title: '${config.name} API',
    version: '1.0.0',
    description: 'API documentation for ${config.name}',
    apiPrefix: '/api',
  });
  await app.register(scalarPlugin, {
    routePrefix: '/docs',
    theme: 'default',
  });

  // Add your custom plugins here:
  // await app.register(myCustomPlugin, { ...options });
}
`;

  return content;
}

function resourcesIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : "";
  const appType = ts ? ": FastifyInstance" : "";

  const authImports =
    config.auth === "jwt"
      ? `
// Auth resources (register, login, /users/me)
import { authResource, userProfileResource } from './auth/auth.resource.js';
`
      : `
// Auth is handled by Better Auth — routes at /api/auth/*
// No manual auth resource needed.
`;

  const authResources =
    config.auth === "jwt"
      ? `  authResource,
  userProfileResource,
  `
      : `  `;

  return `/**
 * Resources Registry
 *
 * Central registry for all API resources.
 * All resources are mounted under /api prefix via Fastify scoping.
 */

${typeImport}${authImports}
// App resources
import exampleResource from './example/example.resource.js';

// Add more resources here:
// import productResource from './product/product.resource.js';

/**
 * All registered resources
 */
export const resources = [
${authResources}exampleResource,
]${ts ? " as const" : ""};

/**
 * Register all resources with the app under a common prefix.
 * Fastify scoping ensures all routes are mounted at /api/*.
 * The apiPrefix option in openApiPlugin keeps OpenAPI docs in sync.
 */
export async function registerResources(app${appType}, prefix = '/api')${ts ? ": Promise<void>" : ""} {
  await app.register(async (scope) => {
    for (const resource of resources) {
      await scope.register(resource.toPlugin());
    }
  }, { prefix });
}
`;
}

function sharedIndexTemplate(_config: ProjectConfig): string {
  return `/**
 * Shared Utilities
 *
 * Central exports for resource definitions.
 * Import from here for clean, consistent code.
 */

// Adapter factory
export { createAdapter } from './adapter.js';

// Core Arc exports
export { createMongooseAdapter, defineResource } from '@classytic/arc';

// Permission helpers (core + application-level)
export * from './permissions.js';

// Presets
export * from './presets/index.js';
`;
}

function createAdapterTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * MongoKit Adapter Factory
 *
 * Creates Arc adapters using MongoKit repositories.
 * The repository handles query parsing via MongoKit's built-in QueryParser.
 */

import { createMongooseAdapter } from '@classytic/arc';
${ts ? "import type { Model } from 'mongoose';\nimport type { Repository } from '@classytic/mongokit';" : ""}

/**
 * Create a MongoKit-powered adapter for a resource
 *
 * Note: Query parsing is handled by MongoKit's Repository class.
 * Just pass the model and repository - Arc handles the rest.
 */
export function createAdapter${ts ? "<TDoc = any>" : ""}(
  model${ts ? ": Model<TDoc>" : ""},
  repository${ts ? ": Repository<TDoc>" : ""}
) {
  return createMongooseAdapter({
    model,
    repository,
  });
}
`;
}

function customAdapterTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Custom Adapter Factory
 *
 * Use this for sqlitekit/Drizzle, Prisma experiments, or any repository
 * that satisfies Arc's RepositoryLike contract.
 */

${ts ? "import type { DataAdapter, RepositoryLike } from '@classytic/arc/adapters';" : ""}

/**
 * Create a custom adapter for a resource.
 *
 * Recommended SQL path:
 * - sqlitekit repository + Arc's createDrizzleAdapter for Drizzle tables
 *
 * Experimental path:
 * - Prisma can be wired with createPrismaAdapter, but keep it opt-in until
 *   your app has integration coverage.
 */
export function createAdapter${ts ? "<TDoc = unknown>" : ""}(
  _source${ts ? ": unknown" : ""},
  repository${ts ? ": RepositoryLike<TDoc>" : ""}
)${ts ? ": DataAdapter<TDoc>" : ""} {
  return {
    type: 'custom',
    name: 'custom-repository',
    repository,
  };
}
`;
}

function presetsMultiTenantTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Arc Presets - Multi-Tenant Configuration
 *
 * Pre-configured presets for multi-tenant applications.
 * Includes both strict and flexible tenant isolation options.
 */

import {
  multiTenantPreset,
  ownedByUserPreset,
  softDeletePreset,
  slugLookupPreset,
} from '@classytic/arc/presets';

// Flexible preset for mixed public/private routes
export { flexibleMultiTenantPreset } from './flexible-multi-tenant.js';

/**
 * Organization-scoped preset (STRICT)
 * Always requires auth, always filters by organizationId.
 * Use for admin-only resources.
 */
export const orgScoped = multiTenantPreset({
  tenantField: 'organizationId',
});

/**
 * Owned by creator preset
 * Filters queries by createdBy field.
 */
export const ownedByCreator = ownedByUserPreset({
  ownerField: 'createdBy',
});

/**
 * Owned by user preset
 * For resources where userId references the owner.
 */
export const ownedByUser = ownedByUserPreset({
  ownerField: 'userId',
});

/**
 * Soft delete preset
 * Adds deletedAt filtering and restore endpoint.
 */
export const softDelete = softDeletePreset();

/**
 * Slug lookup preset
 * Enables GET by slug in addition to ID.
 */
export const slugLookup = slugLookupPreset();

// Export all presets
export const presets = {
  orgScoped,
  ownedByCreator,
  ownedByUser,
  softDelete,
  slugLookup,
}${ts ? " as const" : ""};

export default presets;
`;
}

function presetsSingleTenantTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Arc Presets - Single-Tenant Configuration
 *
 * Pre-configured presets for single-tenant applications.
 */

import {
  ownedByUserPreset,
  softDeletePreset,
  slugLookupPreset,
} from '@classytic/arc/presets';

/**
 * Owned by creator preset
 * Filters queries by createdBy field.
 */
export const ownedByCreator = ownedByUserPreset({
  ownerField: 'createdBy',
});

/**
 * Owned by user preset
 * For resources where userId references the owner.
 */
export const ownedByUser = ownedByUserPreset({
  ownerField: 'userId',
});

/**
 * Soft delete preset
 * Adds deletedAt filtering and restore endpoint.
 */
export const softDelete = softDeletePreset();

/**
 * Slug lookup preset
 * Enables GET by slug in addition to ID.
 */
export const slugLookup = slugLookupPreset();

// Export all presets
export const presets = {
  ownedByCreator,
  ownedByUser,
  softDelete,
  slugLookup,
}${ts ? " as const" : ""};

export default presets;
`;
}

function flexibleMultiTenantPresetTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeAnnotations = ts
    ? `
import { getOrgId, isElevated, isMember } from '@classytic/arc/scope';
import type { RequestScope } from '@classytic/arc/scope';

interface FlexibleMultiTenantOptions {
  tenantField?: string;
}

interface PresetMiddlewares {
  list: ((request: any, reply: any) => Promise<void>)[];
  get: ((request: any, reply: any) => Promise<void>)[];
  create: ((request: any, reply: any) => Promise<void>)[];
  update: ((request: any, reply: any) => Promise<void>)[];
  delete: ((request: any, reply: any) => Promise<void>)[];
}

interface Preset {
  [key: string]: unknown;
  name: string;
  middlewares: PresetMiddlewares;
}
`
    : `
const { getOrgId, isElevated, isMember } = require('@classytic/arc/scope');
`;

  return `/**
 * Flexible Multi-Tenant Preset
 *
 * Smarter tenant filtering that works with public + authenticated routes.
 *
 * Philosophy:
 * - No org scope → No filtering (public data, all orgs)
 * - Org scope present → Filter by org
 * - Elevated scope → No filter (platform admin sees all)
 *
 * Uses request.scope (RequestScope) from Arc's scope system.
 */
${typeAnnotations}
/**
 * Create flexible tenant filter middleware.
 * Only filters when org context is present.
 */
function createFlexibleTenantFilter(tenantField${ts ? ": string" : ""}) {
  return async (request${ts ? ": any" : ""}, reply${ts ? ": any" : ""}) => {
    const scope${ts ? ": RequestScope" : ""} = request.scope ?? { kind: 'public' };

    // Elevated scope — platform admin sees all, no filter
    if (isElevated(scope)) {
      request.log?.debug?.({ msg: 'Elevated scope — no tenant filter' });
      return;
    }

    // Member scope — filter by org
    if (isMember(scope)) {
      request.query = request.query ?? {};
      request.query._policyFilters = {
        ...(request.query._policyFilters ?? {}),
        [tenantField]: scope.organizationId,
      };
      request.log?.debug?.({ msg: 'Tenant filter applied', orgId: scope.organizationId, tenantField });
      return;
    }

    // Public / authenticated — no org context, show all data (public routes)
    request.log?.debug?.({ msg: 'No org context — showing all data' });
  };
}

/**
 * Create tenant injection middleware.
 * Injects tenant ID into request body on create.
 */
function createTenantInjection(tenantField${ts ? ": string" : ""}) {
  return async (request${ts ? ": any" : ""}, reply${ts ? ": any" : ""}) => {
    const scope${ts ? ": RequestScope" : ""} = request.scope ?? { kind: 'public' };
    const orgId = getOrgId(scope);

    // Fail-closed: Require orgId for create operations
    if (!orgId) {
      return reply.code(403).send({
        success: false,
        error: 'Forbidden',
        message: 'Organization context required to create resources',
      });
    }

    if (request.body) {
      request.body[tenantField] = orgId;
    }
  };
}

/**
 * Flexible Multi-Tenant Preset
 *
 * @param options.tenantField - Field name in database (default: 'organizationId')
 */
export function flexibleMultiTenantPreset(options${ts ? ": FlexibleMultiTenantOptions = {}" : " = {}"})${ts ? ": Preset" : ""} {
  const { tenantField = 'organizationId' } = options;

  const tenantFilter = createFlexibleTenantFilter(tenantField);
  const tenantInjection = createTenantInjection(tenantField);

  return {
    name: 'flexibleMultiTenant',
    middlewares: {
      list: [tenantFilter],
      get: [tenantFilter],
      create: [tenantInjection],
      update: [tenantFilter],
      delete: [tenantFilter],
    },
  };
}

export default flexibleMultiTenantPreset;
`;
}

function permissionsTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? ",\n  type PermissionCheck," : "";
  const returnType = ts ? ": PermissionCheck" : "";

  let content = `/**
 * Permission Helpers
 *
 * Clean, type-safe permission definitions for resources.
 */

import {
  requireAuth,
  requireRoles,
  requireOwnership,
  allowPublic,
  roles,
  anyOf,
  allOf,
  denyAll,
  when${typeImport}
} from '@classytic/arc/permissions';

// Re-export core helpers
export {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
  roles,
  allOf,
  anyOf,
  denyAll,
  when,
};

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Require any authenticated user
 */
export const requireAuthenticated = ()${returnType} =>
  requireRoles(['user', 'admin', 'superadmin']);

/**
 * Require admin or superadmin
 */
export const requireAdmin = ()${returnType} =>
  requireRoles(['admin', 'superadmin']);

/**
 * Require superadmin only
 */
export const requireSuperadmin = ()${returnType} =>
  requireRoles(['superadmin']);
`;

  if (config.tenant === "multi") {
    if (config.auth === "better-auth") {
      // Better Auth: use requireOrgRole() which checks per-org member.role
      content += `
// ============================================================================
// Better Auth Organization & Team Permission Helpers
// ============================================================================

/**
 * Organization-level guards (per-org member.role):
 *
 * - requireRoles('admin')              — checks BOTH user.role AND org member.role (recommended)
 * - requireOrgRole(['admin','owner'])  — checks member.role in active org ONLY
 * - requireOrgMembership()             — just checks if user is in the org (any role)
 * - requireTeamMembership()            — checks if user is in the active team
 *
 * RECOMMENDED: Use requireRoles() for most cases. Since Arc 2.7.1 it defaults to
 * checking both platform AND org roles, so a single call covers BA org plugin users
 * with platform-admin overrides. Use requireOrgRole() when you ONLY want org-level
 * checks (and want to explicitly exclude platform admins).
 *
 * Platform superadmin automatically bypasses all org role checks.
 *
 * IMPORTANT: When using Better Auth's Access Control (ac) with custom roles,
 * you MUST define ALL roles (owner, admin, member, + any custom) using the
 * same AC instance. BA's built-in defaults won't cover custom statements.
 * Omitting any role causes BA's hasPermission to fail silently for that role.
 *
 * @see multi-org-betterauth boilerplate (src/shared/access-control.ts) for the recommended pattern.
 */
import {
  requireOrgMembership,
  requireOrgRole,
  requireTeamMembership,
} from '@classytic/arc/permissions';
export { requireOrgMembership, requireOrgRole, requireTeamMembership };

/**
 * Require organization owner (checks member.role, not user.role)
 */
export const requireOrgOwner = ()${returnType} =>
  requireOrgRole(['owner']);

/**
 * Require organization manager or higher (checks member.role, not user.role)
 */
export const requireOrgManager = ()${returnType} =>
  requireOrgRole(['manager', 'admin', 'owner']);

/**
 * Require any organization member (any role)
 */
export const requireOrgStaff = ()${returnType} =>
  requireOrgMembership();
`;
    } else {
      // JWT: no BA org plugin — use requireRoles() with user.role
      content += `
/**
 * Require organization owner (elevated scope auto-bypasses)
 */
export const requireOrgOwner = ()${returnType} =>
  requireRoles(['owner', 'admin', 'superadmin']);

/**
 * Require organization manager or higher
 */
export const requireOrgManager = ()${returnType} =>
  requireRoles(['owner', 'manager', 'admin', 'superadmin']);

/**
 * Require organization staff (any org member)
 */
export const requireOrgStaff = ()${returnType} =>
  requireRoles(['owner', 'manager', 'staff', 'admin', 'superadmin']);
`;
    }
  }

  content += `
// ============================================================================
// Standard Permission Sets
// ============================================================================

/**
 * Public read, authenticated write (default for most resources)
 */
export const publicReadPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireAuthenticated(),
  update: requireAuthenticated(),
  delete: requireAuthenticated(),
};

/**
 * All operations require authentication
 */
export const authenticatedPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: requireAuth(),
  delete: requireAuth(),
};

/**
 * Admin only permissions
 */
export const adminPermissions = {
  list: requireAdmin(),
  get: requireAdmin(),
  create: requireSuperadmin(),
  update: requireSuperadmin(),
  delete: requireSuperadmin(),
};
`;

  if (config.tenant === "multi") {
    content += `
/**
 * Organization staff permissions
 */
export const orgStaffPermissions = {
  list: requireOrgStaff(),
  get: requireOrgStaff(),
  create: requireOrgManager(),
  update: requireOrgManager(),
  delete: requireOrgOwner(),
};
`;

    if (config.auth === "better-auth") {
      content += `
/**
 * Team-scoped permissions (requires active team)
 * Uses Better Auth's team membership — flat groups, no team-level roles.
 */
export const teamScopedPermissions = {
  list: requireTeamMembership(),
  get: requireTeamMembership(),
  create: requireTeamMembership(),
  update: requireTeamMembership(),
  delete: requireOrgOwner(),
};
`;
    }
  }

  return content;
}

function configTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  const authTypeBlock =
    config.auth === "better-auth"
      ? `
  betterAuth: {
    secret: string;
  };
  frontend: {
    url: string;
  };`
      : `
  jwt: {
    secret: string;
    expiresIn: string;
  };`;

  let typeDefinition = "";
  if (ts) {
    typeDefinition = `
export interface AppConfig {
  env: string;
  isDev: boolean;
  isProd: boolean;
  server: {
    port: number;
    host: string;
  };${authTypeBlock}
  cors: {
    origins: string[] | boolean;  // true = allow all ('*')
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };${
    config.adapter === "mongokit"
      ? `
  database: {
    uri: string;
  };`
      : ""
  }${
    config.tenant === "multi"
      ? `
  org: {
    header: string;
  };`
      : ""
  }
}
`;
  }

  const authConfigBlock =
    config.auth === "better-auth"
      ? `
  betterAuth: {
    secret: process.env.BETTER_AUTH_SECRET || 'dev-secret-change-in-production-min-32-chars',
  },

  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:3000',
  },`
      : `
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },`;

  return `/**
 * Application Configuration
 *
 * All config is loaded from environment variables.
 * ENV file is loaded by config/env.ts (imported first in entry points).
 */
${typeDefinition}
const config${ts ? ": AppConfig" : ""} = {
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') !== 'production',
  isProd: process.env.NODE_ENV === 'production',

  server: {
    port: parseInt(process.env.PORT || '8040', 10),
    host: process.env.HOST || '0.0.0.0',
  },
${authConfigBlock}

  cors: {
    // '*' = allow all origins (true), otherwise comma-separated list
    origins:
      process.env.CORS_ORIGINS === '*'
        ? true
        : (process.env.CORS_ORIGINS || 'http://localhost:3000').split(','),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-organization-id', 'x-request-id'],
    credentials: true,
  },
${
  config.adapter === "mongokit"
    ? `
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/${config.name}',
  },
`
    : ""
}${
  config.tenant === "multi"
    ? `
  org: {
    header: process.env.ORG_HEADER || 'x-organization-id',
  },
`
    : ""
}};

export default config;
`;
}

function exampleModelTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeExport = ts
    ? `
export type ExampleDocument = mongoose.InferSchemaType<typeof exampleSchema>;
export type ExampleModel = mongoose.Model<ExampleDocument>;
`
    : "";

  return `/**
 * Example Model
 * Generated by Arc CLI
 */

import mongoose from 'mongoose';

const exampleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
${config.tenant === "multi" ? "    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },\n" : ""}    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for common queries
exampleSchema.index({ name: 1 });
exampleSchema.index({ deletedAt: 1, isActive: 1 });
${config.tenant === "multi" ? "exampleSchema.index({ organizationId: 1, deletedAt: 1 });\n" : ""}${typeExport}
const Example = mongoose.model${ts ? "<ExampleDocument>" : ""}('Example', exampleSchema);

export default Example;
`;
}

function exampleRepositoryTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { ExampleDocument } from './example.model.js';\n" : "";
  const generic = ts ? "<ExampleDocument>" : "";

  return `/**
 * Example Repository
 * Generated by Arc CLI
 *
 * MongoKit repository with plugins for:
 * - Soft delete (deletedAt filtering)
 * - Custom business logic methods
 */

import {
  Repository,
  softDeletePlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
} from '@classytic/mongokit';
${typeImport}import Example from './example.model.js';

class ExampleRepository extends Repository${generic} {
  constructor() {
    super(Example, [
      methodRegistryPlugin(),
      softDeletePlugin(),
      mongoOperationsPlugin(),
    ]);
  }

  /**
   * Find all active (non-deleted) records
   */
  async findActive() {
    return this.Model.find({ isActive: true, deletedAt: null }).lean();
  }
${
  config.tenant === "multi"
    ? `
  /**
   * Find active records for an organization
   */
  async findActiveByOrg(organizationId${ts ? ": string" : ""}) {
    return this.Model.find({
      organizationId,
      isActive: true,
      deletedAt: null,
    }).lean();
  }
`
    : ""
}
  // Note: softDeletePlugin provides restore() and getDeleted() methods automatically
}

const exampleRepository = new ExampleRepository();

export default exampleRepository;
export { ExampleRepository };
`;
}

function exampleResourceTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Example Resource
 * Generated by Arc CLI
 *
 * A complete resource with:
 * - Model (Mongoose schema)
 * - Repository (MongoKit with plugins)
 * - Permissions (role-based access)
 * - Presets (soft delete${config.tenant === "multi" ? ", multi-tenant" : ""})
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import { createAdapter } from '#shared/adapter.js';
import { ${config.tenant === "multi" ? "orgStaffPermissions" : "publicReadPermissions"} } from '#shared/permissions.js';
${config.tenant === "multi" ? "import { flexibleMultiTenantPreset } from '#shared/presets/flexible-multi-tenant.js';\n" : ""}import Example${ts ? ", { type ExampleDocument }" : ""} from './example.model.js';
import exampleRepository from './example.repository.js';
import exampleController from './example.controller.js';

const queryParser = new QueryParser({
  allowedFilterFields: ['isActive'],
});

const exampleResource = defineResource${ts ? "<ExampleDocument>" : ""}({
  name: 'example',
  displayName: 'Examples',
  prefix: '/examples',

  adapter: createAdapter(Example, exampleRepository),
  controller: exampleController,
  queryParser,

  presets: [
    'softDelete',
    'bulk',${
      config.tenant === "multi"
        ? `
    flexibleMultiTenantPreset({ tenantField: 'organizationId' }),`
        : ""
    }
  ],

  permissions: ${config.tenant === "multi" ? "orgStaffPermissions" : "publicReadPermissions"},

  // Add custom routes here:
  // routes: [
  //   {
  //     method: 'GET',
  //     path: '/custom',
  //     summary: 'Custom endpoint',
  //     handler: async (request, reply) => { ... },
  //   },
  // ],
});

export default exampleResource;
`;
}

function exampleControllerTemplate(config: ProjectConfig): string {
  const _ts = config.typescript;

  return `/**
 * Example Controller
 * Generated by Arc CLI
 *
 * BaseController provides CRUD operations with:
 * - Automatic pagination
 * - Query parsing
 * - Validation
 */

import { BaseController } from '@classytic/arc';
import exampleRepository from './example.repository.js';
import { exampleSchemaOptions } from './example.schemas.js';

class ExampleController extends BaseController {
  constructor() {
    super(exampleRepository, {
      schemaOptions: exampleSchemaOptions,${
        config.tenant === "multi"
          ? `
      tenantField: 'organizationId', // Configurable tenant field for multi-tenant`
          : `
      // tenantField: 'organizationId', // For multi-tenant apps`
      }
    });
  }

  // Add custom controller methods here:
  // async customAction(request, reply) {
  //   // Custom logic
  // }
}

const exampleController = new ExampleController();
export default exampleController;
`;
}

function exampleSchemasTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const multiTenantFields = config.tenant === "multi";

  return `/**
 * Example Schemas
 * Generated by Arc CLI
 *
 * Schema options for controller validation and query parsing
 */

import Example from './example.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * CRUD Schemas with Field Rules
 * Auto-generated from Mongoose model
 */
const crudSchemas = buildCrudSchemasFromModel(Example, {
  strictAdditionalProperties: true,
  fieldRules: {
    // Framework-injected fields — strip from body + required[]
    // deletedAt: { systemManaged: true },
    // Legitimate null values (Zod .nullable() patterns) — widen JSON-Schema type
    // priceMode: { nullable: true },
    // Elevated-admin override for systemManaged fields (cross-tenant writes)
    // organizationId: { systemManaged: true, preserveForElevated: true },
  },
  query: {
    filterableFields: {
      isActive: 'boolean',${
        multiTenantFields
          ? `
      organizationId: 'ObjectId',`
          : ""
      }
      createdAt: 'date',
    },
  },
});

// Schema options for controller
export const exampleSchemaOptions${ts ? ": any" : ""} = {
  query: {${
    multiTenantFields
      ? `
    allowedPopulate: ['organizationId'],`
      : ""
  }
    filterableFields: {
      isActive: 'boolean',${
        multiTenantFields
          ? `
      organizationId: 'ObjectId',`
          : ""
      }
      createdAt: 'date',
    },
  },
};

export default crudSchemas;
`;
}

function exampleTestTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Example Resource Tests
 * Generated by Arc CLI
 *
 * Run tests: npm test
 * Watch mode: npm run test:watch
 *
 * Uses arc's 2.11 testing surface:
 *   - createTestApp  — turnkey Fastify + in-memory Mongo + auth + fixtures
 *   - expectArc      — fluent envelope matchers (.ok, .unauthorized, .forbidden, ...)
 *   - ctx.auth       — unified TestAuthProvider, register a role once then reuse .headers
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import { createTestApp, expectArc } from '@classytic/arc/testing';
import type { TestAppContext } from '@classytic/arc/testing';
import { exampleResource } from '../src/resources/example/example.js';

describe('Example Resource', () => {
  let ctx${ts ? ": TestAppContext" : ""};

  beforeAll(async () => {
    ctx = await createTestApp({
      resources: [exampleResource],
      authMode: 'jwt',
${config.adapter === "mongokit" ? "      connectMongoose: true,\n" : ""}    });

    ctx.auth${ts ? "!" : ""}.register('admin', {
      user: { id: '1', roles: ['admin'] },
      orgId: 'org-1',
    });
  });

  afterAll(() => ctx.close());

  describe('GET /examples', () => {
    it('should return a list of examples (public)', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/examples' });
      expectArc(res).ok().paginated();
    });
  });

  describe('POST /examples', () => {
    it('should require authentication', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/examples',
        payload: { name: 'Test Example' },
      });
      expectArc(res).unauthorized();
    });

    it('should create when admin is authenticated', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/examples',
        headers: ctx.auth${ts ? "!" : ""}.as('admin').headers,
        payload: { name: 'Test Example' },
      });
      expectArc(res).ok();
    });
  });

  // Add more tests as needed:
  // - GET /examples/:id         (expectArc(res).ok().hasData({ name: '...' }))
  // - PATCH /examples/:id       (expectArc(res).ok())
  // - DELETE /examples/:id      (expectArc(res).ok())
  // - Custom endpoints
  // - Permission denials        (expectArc(res).forbidden().hasError(/reason/))
  // - Field hiding              (expectArc(res).hidesField('password'))
});
`;
}

// ============================================================================
// User & Auth Templates
// ============================================================================

function userModelTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  const orgRoles =
    config.tenant === "multi"
      ? `
// Organization roles (for multi-tenant)
const ORG_ROLES = ['owner', 'manager', 'hr', 'staff', 'contractor'] as const;
type OrgRole = typeof ORG_ROLES[number];
`
      : "";

  const orgInterface =
    config.tenant === "multi"
      ? `
type UserOrganization = {
  organizationId: Types.ObjectId;
  organizationName: string;
  roles: OrgRole[];
  joinedAt: Date;
};
`
      : "";

  const orgSchema =
    config.tenant === "multi"
      ? `
    // Multi-org support
    organizations: [{
      organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
      organizationName: { type: String, required: true },
      roles: { type: [String], enum: ORG_ROLES, default: [] },
      joinedAt: { type: Date, default: () => new Date() },
    }],
`
      : "";

  const orgMethods =
    config.tenant === "multi"
      ? `
// Organization methods
userSchema.methods.getOrgRoles = function(orgId${ts ? ": Types.ObjectId | string" : ""}) {
  const org = this.organizations.find(o => o.organizationId.toString() === orgId.toString());
  return org?.roles || [];
};

userSchema.methods.hasOrgAccess = function(orgId${ts ? ": Types.ObjectId | string" : ""}) {
  return this.organizations.some(o => o.organizationId.toString() === orgId.toString());
};

userSchema.methods.addOrganization = function(
  organizationId${ts ? ": Types.ObjectId" : ""},
  organizationName${ts ? ": string" : ""},
  roles${ts ? ": OrgRole[]" : ""} = []
) {
  const existing = this.organizations.find(o => o.organizationId.toString() === organizationId.toString());
  if (existing) {
    existing.organizationName = organizationName;
    existing.roles = [...new Set([...existing.roles, ...roles])];
  } else {
    this.organizations.push({ organizationId, organizationName, roles, joinedAt: new Date() });
  }
  return this;
};

userSchema.methods.removeOrganization = function(organizationId${ts ? ": Types.ObjectId" : ""}) {
  this.organizations = this.organizations.filter(o => o.organizationId.toString() !== organizationId.toString());
  return this;
};

// Index for org queries
userSchema.index({ 'organizations.organizationId': 1 });
`
      : "";

  const userType = ts
    ? `
type PlatformRole = 'user' | 'admin' | 'superadmin';

type User = {
  name: string;
  email: string;
  password: string;
  roles: PlatformRole[];${
    config.tenant === "multi"
      ? `
  organizations: UserOrganization[];`
      : ""
  }
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
};

type UserMethods = {
  matchPassword: (enteredPassword: string) => Promise<boolean>;${
    config.tenant === "multi"
      ? `
  getOrgRoles: (orgId: Types.ObjectId | string) => OrgRole[];
  hasOrgAccess: (orgId: Types.ObjectId | string) => boolean;
  addOrganization: (orgId: Types.ObjectId, name: string, roles?: OrgRole[]) => UserDocument;
  removeOrganization: (orgId: Types.ObjectId) => UserDocument;`
      : ""
  }
};

export type UserDocument = HydratedDocument<User, UserMethods>;
export type UserModel = Model<User, {}, UserMethods>;
`
    : "";

  return `/**
 * User Model
 * Generated by Arc CLI
 */

import bcrypt from 'bcryptjs';
import mongoose${ts ? ", { type HydratedDocument, type Model, type Types }" : ""} from 'mongoose';
${orgRoles}
const { Schema } = mongoose;
${orgInterface}${userType}
const userSchema = new Schema${ts ? "<User, UserModel, UserMethods>" : ""}(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },

    // Platform roles
    roles: {
      type: [String],
      enum: ['user', 'admin', 'superadmin'],
      default: ['user'],
    },
${orgSchema}
    // Password reset
    resetPasswordToken: String,
    resetPasswordExpires: Date,
  },
  { timestamps: true }
);

// Password hashing
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Password comparison
userSchema.methods.matchPassword = async function(enteredPassword${ts ? ": string" : ""}) {
  return bcrypt.compare(enteredPassword, this.password);
};
${orgMethods}
// Exclude password in JSON
userSchema.set('toJSON', {
  transform: (_doc, ret${ts ? ": any" : ""}) => {
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

const User = mongoose.models.User${ts ? " as UserModel" : ""} || mongoose.model${ts ? "<User, UserModel>" : ""}('User', userSchema);
export default User;
`;
}

function userRepositoryTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts
    ? "import type { UserDocument } from './user.model.js';\nimport type { ClientSession, Types } from 'mongoose';\n"
    : "";

  return `/**
 * User Repository
 * Generated by Arc CLI
 *
 * MongoKit repository with plugins for common operations
 */

import {
  Repository,
  methodRegistryPlugin,
  mongoOperationsPlugin,
} from '@classytic/mongokit';
${typeImport}import User from './user.model.js';

${ts ? "type ID = string | Types.ObjectId;\n" : ""}
class UserRepository extends Repository${ts ? "<UserDocument>" : ""} {
  constructor() {
    super(User${ts ? " as any" : ""}, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]);
  }

  /**
   * Find user by email
   */
  async findByEmail(email${ts ? ": string" : ""}) {
    return this.Model.findOne({ email: email.toLowerCase().trim() });
  }

  /**
   * Find user by reset token
   */
  async findByResetToken(token${ts ? ": string" : ""}) {
    return this.Model.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });
  }

  /**
   * Check if email exists
   */
  async emailExists(email${ts ? ": string" : ""})${ts ? ": Promise<boolean>" : ""} {
    const result = await this.Model.exists({ email: email.toLowerCase().trim() });
    return !!result;
  }

  /**
   * Update user password (triggers hash middleware)
   */
  async updatePassword(userId${ts ? ": ID" : ""}, newPassword${ts ? ": string" : ""}, options${ts ? ": { session?: ClientSession }" : ""} = {}) {
    const user = await this.Model.findById(userId).session(options.session ?? null);
    if (!user) throw new Error('User not found');

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save({ session: options.session ?? undefined });
    return user;
  }

  /**
   * Set reset token
   */
  async setResetToken(userId${ts ? ": ID" : ""}, token${ts ? ": string" : ""}, expiresAt${ts ? ": Date" : ""}) {
    return this.Model.findByIdAndUpdate(
      userId,
      { resetPasswordToken: token, resetPasswordExpires: expiresAt },
      { new: true }
    );
  }
${
  config.tenant === "multi"
    ? `
  /**
   * Find users by organization
   */
  async findByOrganization(organizationId${ts ? ": ID" : ""}) {
    return this.Model.find({ 'organizations.organizationId': organizationId })
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .lean();
  }
`
    : ""
}
}

const userRepository = new UserRepository();
export default userRepository;
export { UserRepository };
`;
}

function userControllerTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * User Controller
 * Generated by Arc CLI
 *
 * BaseController for user management operations.
 * Used by auth resource for /users/me endpoints.
 */

import { BaseController } from '@classytic/arc';
import userRepository from './user.repository.js';

class UserController extends BaseController {
  constructor() {
    super(userRepository${ts ? " as any" : ""});
  }

  // Custom user operations can be added here
}

const userController = new UserController();
export default userController;
`;
}

function authResourceTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Auth Resource
 * Generated by Arc CLI
 *
 * Combined auth + user profile endpoints:
 * - POST /auth/register
 * - POST /auth/login
 * - POST /auth/refresh
 * - POST /auth/forgot-password
 * - POST /auth/reset-password
 * - GET /users/me
 * - PATCH /users/me
 */

import { defineResource } from '@classytic/arc';
import { allowPublic, requireAuth } from '@classytic/arc/permissions';
import { createAdapter } from '#shared/adapter.js';
import User from '../user/user.model.js';
import userRepository from '../user/user.repository.js';
import * as handlers from './auth.handlers.js';
import * as schemas from './auth.schemas.js';

/**
 * Auth Resource - handles authentication
 */
export const authResource = defineResource({
  name: 'auth',
  displayName: 'Authentication',
  tag: 'Authentication',
  prefix: '/auth',

  adapter: createAdapter(User${ts ? " as any" : ""}, userRepository${ts ? " as any" : ""}),
  disableDefaultRoutes: true,

  routes: [
    {
      method: 'POST',
      path: '/register',
      summary: 'Register new user',
      permissions: allowPublic(),
      handler: handlers.register,
      raw: true,
      schema: { body: schemas.registerBody, response: { 201: schemas.successResponse } },
    },
    {
      method: 'POST',
      path: '/login',
      summary: 'User login',
      permissions: allowPublic(),
      handler: handlers.login,
      raw: true,
      schema: { body: schemas.loginBody, response: { 200: schemas.loginResponse } },
    },
    {
      method: 'POST',
      path: '/refresh',
      summary: 'Refresh access token',
      permissions: allowPublic(),
      handler: handlers.refreshToken,
      raw: true,
      schema: { body: schemas.refreshBody, response: { 200: schemas.tokenResponse } },
    },
    {
      method: 'POST',
      path: '/forgot-password',
      summary: 'Request password reset',
      permissions: allowPublic(),
      handler: handlers.forgotPassword,
      raw: true,
      schema: { body: schemas.forgotBody, response: { 200: schemas.successResponse } },
    },
    {
      method: 'POST',
      path: '/reset-password',
      summary: 'Reset password with token',
      permissions: allowPublic(),
      handler: handlers.resetPassword,
      raw: true,
      schema: { body: schemas.resetBody, response: { 200: schemas.successResponse } },
    },
  ],
});

/**
 * User Profile Resource - handles /users/me
 */
export const userProfileResource = defineResource({
  name: 'user-profile',
  displayName: 'User Profile',
  tag: 'User Profile',
  prefix: '/users',

  adapter: createAdapter(User${ts ? " as any" : ""}, userRepository${ts ? " as any" : ""}),
  disableDefaultRoutes: true,

  routes: [
    {
      method: 'GET',
      path: '/me',
      summary: 'Get current user profile',
      permissions: requireAuth(),
      handler: handlers.getUserProfile,
      raw: true,
      schema: { response: { 200: schemas.userProfileResponse } },
    },
    {
      method: 'PATCH',
      path: '/me',
      summary: 'Update current user profile',
      permissions: requireAuth(),
      handler: handlers.updateUserProfile,
      raw: true,
      schema: { body: schemas.updateUserBody, response: { 200: schemas.userProfileResponse } },
    },
  ],
});

export default authResource;
`;
}

function betterAuthSetupTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const mongoImport =
    config.adapter === "mongokit"
      ? `import mongoose from 'mongoose';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';`
      : "";

  const dbAdapter =
    config.adapter === "mongokit"
      ? config.typescript
        ? `database: mongodbAdapter(mongoose.connection.getClient().db() as any),`
        : `database: mongodbAdapter(mongoose.connection.getClient().db()),`
      : `// Configure your database adapter here
    // See: https://www.better-auth.com/docs/concepts/database`;

  const orgPlugin =
    config.tenant === "multi"
      ? `
import { organization } from 'better-auth/plugins/organization';
import { bearer } from 'better-auth/plugins/bearer';`
      : "";

  const orgPluginUsage =
    config.tenant === "multi"
      ? `
      plugins: [
        bearer(),
        organization({
          allowUserToCreateOrganization: true,
          creatorRole: 'owner',
          teams: {
            enabled: true,
          },
        }),
      ],`
      : "";

  const googleProvider = `
      // Google OAuth (enabled when env vars are set)
      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            socialProviders: {
              google: {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              },
            },
          }
        : {}),`;

  return `/**
 * Better Auth Configuration
 * Generated by Arc CLI
 *
 * Authentication is handled entirely by Better Auth.
 * Routes are registered automatically at /api/auth/*
 *
 * Better Auth manages these collections:
 * - user, session, account${config.tenant === "multi" ? ", organization, member, invitation, team, teamMember" : ""}
 *
 * @see https://www.better-auth.com/docs
 */

import { betterAuth } from 'better-auth';
${mongoImport}${orgPlugin}
import config from '#config/index.js';

let _auth${ts ? ": ReturnType<typeof betterAuth> | null" : ""} = null;

/**
 * Get the Better Auth instance (lazy singleton)
 *
 * Must be called AFTER database connection is established.
 */
export function getAuth()${ts ? ": ReturnType<typeof betterAuth>" : ""} {
  if (process.env.NODE_ENV === 'production' && !process.env.BETTER_AUTH_SECRET) {
    throw new Error('BETTER_AUTH_SECRET is required in production (min 32 chars)');
  }

  if (!_auth) {
    _auth = betterAuth({
      secret: config.betterAuth.secret,
      baseURL: process.env.BETTER_AUTH_URL || \`http://localhost:\${config.server.port}\`,
      basePath: '/api/auth',

      ${dbAdapter}
${
  config.tenant === "multi"
    ? `
      user: {
        additionalFields: {
          roles: {
            type: 'string[]',
            defaultValue: ['user'],
            required: false,
            input: false, // Cannot be set during signup
          },
        },
      },
`
    : ""
}
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 6,
      },
${googleProvider}
${orgPluginUsage}
      session: {
        cookieCache: {
          enabled: true,
          maxAge: 5 * 60, // 5 minutes
        },
      },

      trustedOrigins: [config.frontend.url],

      rateLimit: {
        enabled: process.env.NODE_ENV === 'production',
      },
    });
${
  config.adapter === "mongokit"
    ? `
    // Register stub Mongoose models for Better Auth collections.
    // BA uses the raw MongoDB driver, so no Mongoose models exist by default.
    // These stubs (strict: false) enable populate() on refs like 'user', 'organization', etc.
    const baCollections = ['user', 'organization', 'member', 'invitation', 'session', 'account'];
    for (const name of baCollections) {
      if (!mongoose.models[name]) {
        mongoose.model(name, new mongoose.Schema({}, { strict: false, collection: name }));
      }
    }
`
    : ""
}  }

  return _auth;
}

export default getAuth;
`;
}

function authHandlersTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeAnnotations = ts
    ? `
import type { FastifyRequest, FastifyReply } from 'fastify';
// Load Arc auth type augmentations (adds request.server.auth typings)
import '@classytic/arc/auth';
`
    : "";

  return `/**
 * Auth Handlers
 * Generated by Arc CLI
 *
 * Uses Arc's built-in JWT utilities via fastify.auth (provided by @fastify/jwt v10).
 * No standalone jsonwebtoken dependency needed.
 */

import userRepository from '../user/user.repository.js';
${typeAnnotations}

/**
 * Register new user
 */
export async function register(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const { name, email, password } = request.body${ts ? " as any" : ""};

    // Check if email exists
    if (await userRepository.emailExists(email)) {
      return reply.code(400).send({ success: false, message: 'Email already registered' });
    }

    // Create user
    await userRepository.create({ name, email, password, roles: ['user'] });

    return reply.code(201).send({ success: true, message: 'User registered successfully' });
  } catch (error) {
    request.log.error({ err: error }, 'Register error');
    return reply.code(500).send({ success: false, message: 'Registration failed' });
  }
}

/**
 * Login user
 */
export async function login(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const { email, password } = request.body${ts ? " as any" : ""};

    const user = await userRepository.findByEmail(email);
    if (!user || !(await user.matchPassword(password))) {
      return reply.code(401).send({ success: false, message: 'Invalid credentials' });
    }

    const tokens = request.server.auth.issueTokens({ id: user._id.toString(), role: user.role });

    return reply.send({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      ...tokens,
    });
  } catch (error) {
    request.log.error({ err: error }, 'Login error');
    return reply.code(500).send({ success: false, message: 'Login failed' });
  }
}

/**
 * Refresh access token
 */
export async function refreshToken(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const { token } = request.body${ts ? " as any" : ""};
    if (!token) {
      return reply.code(401).send({ success: false, message: 'Refresh token required' });
    }

    const decoded = request.server.auth.verifyRefreshToken(token)${ts ? " as { id: string }" : ""};
    const tokens = request.server.auth.issueTokens({ id: decoded.id });

    return reply.send({ success: true, ...tokens });
  } catch {
    return reply.code(401).send({ success: false, message: 'Invalid refresh token' });
  }
}

/**
 * Forgot password
 */
export async function forgotPassword(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const { email } = request.body${ts ? " as any" : ""};
    const user = await userRepository.findByEmail(email);

    if (user) {
      const { randomBytes } = await import('node:crypto');
      const token = randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000); // 1 hour
      await userRepository.setResetToken(user._id, token, expires);
      // SCAFFOLD: Integrate your email provider to send the reset link
      request.log.info(\`Password reset requested for \${email}\`);
    }

    // Always return success to prevent email enumeration
    return reply.send({ success: true, message: 'If email exists, reset link sent' });
  } catch (error) {
    request.log.error({ err: error }, 'Forgot password error');
    return reply.code(500).send({ success: false, message: 'Failed to process request' });
  }
}

/**
 * Reset password
 */
export async function resetPassword(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const { token, newPassword } = request.body${ts ? " as any" : ""};
    const user = await userRepository.findByResetToken(token);

    if (!user) {
      return reply.code(400).send({ success: false, message: 'Invalid or expired token' });
    }

    await userRepository.updatePassword(user._id, newPassword);
    return reply.send({ success: true, message: 'Password has been reset' });
  } catch (error) {
    request.log.error({ err: error }, 'Reset password error');
    return reply.code(500).send({ success: false, message: 'Failed to reset password' });
  }
}

/**
 * Get current user profile
 */
export async function getUserProfile(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const userId = (request${ts ? " as any" : ""}).user?._id || (request${ts ? " as any" : ""}).user?.id;
    const user = await userRepository.getById(userId);

    if (!user) {
      return reply.code(404).send({ success: false, message: 'User not found' });
    }

    return reply.send({ success: true, data: user });
  } catch (error) {
    request.log.error({ err: error }, 'Get profile error');
    return reply.code(500).send({ success: false, message: 'Failed to get profile' });
  }
}

/**
 * Update current user profile
 */
export async function updateUserProfile(request${ts ? ": FastifyRequest" : ""}, reply${ts ? ": FastifyReply" : ""}) {
  try {
    const userId = (request${ts ? " as any" : ""}).user?._id || (request${ts ? " as any" : ""}).user?.id;
    const updates = { ...request.body${ts ? " as any" : ""} };

    // Prevent updating protected fields
    if ('password' in updates) delete updates.password;
    if ('roles' in updates) delete updates.roles;
    if ('organizations' in updates) delete updates.organizations;

    const user = await userRepository.Model.findByIdAndUpdate(userId, updates, { new: true });
    return reply.send({ success: true, data: user });
  } catch (error) {
    request.log.error({ err: error }, 'Update profile error');
    return reply.code(500).send({ success: false, message: 'Failed to update profile' });
  }
}
`;
}

function authSchemasTemplate(_config: ProjectConfig): string {
  return `/**
 * Auth Schemas
 * Generated by Arc CLI
 */

export const registerBody = {
  type: 'object',
  required: ['name', 'email', 'password'],
  properties: {
    name: { type: 'string', minLength: 2 },
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
  },
};

export const loginBody = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string' },
  },
};

export const refreshBody = {
  type: 'object',
  required: ['token'],
  properties: {
    token: { type: 'string' },
  },
};

export const forgotBody = {
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', format: 'email' },
  },
};

export const resetBody = {
  type: 'object',
  required: ['token', 'newPassword'],
  properties: {
    token: { type: 'string' },
    newPassword: { type: 'string', minLength: 6 },
  },
};

export const updateUserBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2 },
    email: { type: 'string', format: 'email' },
  },
};

// Response schemas (enables fast-json-stringify serialization)

export const successResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
  },
};

export const loginResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        roles: { type: 'array', items: { type: 'string' } },
      },
    },
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
  },
};

export const tokenResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
  },
};

export const userProfileResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: { type: 'object', additionalProperties: true },
  },
};
`;
}

function authTestTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Auth Tests
 * Generated by Arc CLI
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
${config.adapter === "mongokit" ? "import mongoose from 'mongoose';\n" : ""}import { createAppInstance } from '../src/app.js';
${ts ? "import type { FastifyInstance } from 'fastify';\n" : ""}
describe('Auth', () => {
  let app${ts ? ": FastifyInstance" : ""};
  const testUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
  };

  beforeAll(async () => {
${
  config.adapter === "mongokit"
    ? `    const testDbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/${config.name}-test';
    await mongoose.connect(testDbUri);
    // Clean up test data
    await mongoose.connection.collection('users').deleteMany({ email: testUser.email });
`
    : ""
}
    app = await createAppInstance();
    await app.ready();
  });

  afterAll(async () => {
${
  config.adapter === "mongokit"
    ? `    await mongoose.connection.collection('users').deleteMany({ email: testUser.email });
    await mongoose.connection.close();
`
    : ""
}    await app.close();
  });

  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: testUser,
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should reject duplicate email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: testUser,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('should login with valid credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testUser.email, password: testUser.password },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
    });

    it('should reject invalid credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testUser.email, password: 'wrongpassword' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /users/me', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/users/me',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
`;
}

// ============================================================================
// Success Message
// ============================================================================

function printSuccessMessage(config: ProjectConfig, skipInstall?: boolean): void {
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

function dockerignoreTemplate(): string {
  return `node_modules
dist
.env
.env.*
.git
.vscode
.idea
Dockerfile
docker-compose.yml
coverage
npm-debug.log*
.DS_Store
`;
}

function dockerfileTemplate(config: ProjectConfig): string {
  return `# Multi-stage Dockerfile for Arc + Fastify
# Optimized for production and caching

# 1. Build Stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
${config.typescript ? "COPY tsconfig*.json ./" : ""}
# If using pnpm, bun, or yarn, adjust the lockfile here
RUN npm ci

COPY . .
${config.typescript ? "RUN npm run build" : ""}

# 2. Production Stage
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production

${config.typescript ? "COPY --from=builder /app/dist ./dist" : "COPY src ./src"}

EXPOSE 8040
CMD ["npm", "start"]
`;
}

function dockerComposeTemplate(config: ProjectConfig): string {
  let content = `version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8040:8040"
    environment:
      - NODE_ENV=development
      - PORT=8040
      - HOST=0.0.0.0`;

  if (config.adapter === "mongokit") {
    content += `
      - MONGODB_URI=mongodb://mongo:27017/${config.name}
    depends_on:
      - mongo

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db`;
  }

  content += `

volumes:`;

  if (config.adapter === "mongokit") {
    content += `
  mongo-data:
`;
  }

  return content;
}

function wranglerTemplate(config: ProjectConfig): string {
  const entry = config.typescript ? "dist/index.js" : "src/index.js";

  // MongoDB requires nodejs_compat_v2 for node:net/tls; others only need nodejs_compat
  const compatFlag = config.adapter === "mongokit" ? "nodejs_compat_v2" : "nodejs_compat";

  let dbConfig = "";

  if (config.adapter === "mongokit") {
    dbConfig = `
# MongoDB Atlas — store URI as a secret:
#   npx wrangler secret put MONGODB_URI
#
# IMPORTANT: Mongoose does NOT work on Workers. Use the raw mongodb driver (6.15+).
# For Lambda/Vercel (Node.js), Mongoose works normally.
`;
  } else {
    dbConfig = `
# Database options for Cloudflare Workers:
#
# PostgreSQL via Hyperdrive (recommended — connection pooling + caching):
#   npx wrangler hyperdrive create my-db --connection-string="postgres://user:pass@host:5432/db"
#   Then uncomment:
# [[hyperdrive]]
# binding = "HYPERDRIVE"
# id = "<your-hyperdrive-id>"
#
# Turso (edge SQLite):
#   npx wrangler secret put TURSO_URL
#   npx wrangler secret put TURSO_AUTH_TOKEN
#
# Neon (serverless PostgreSQL via HTTP):
#   npx wrangler secret put DATABASE_URL
#
# D1 (Cloudflare's native SQLite):
# [[d1_databases]]
# binding = "DB"
# database_name = "${config.name}-db"
# database_id = "<run: npx wrangler d1 create ${config.name}-db>"
`;
  }

  return `# Cloudflare Workers configuration
# Generated by Arc CLI — see https://developers.cloudflare.com/workers/

name = "${config.name}"
main = "${entry}"
compatibility_date = "2025-03-20"

# Required for Arc — enables node:crypto and AsyncLocalStorage
compatibility_flags = ["${compatFlag}"]

[vars]
NODE_ENV = "production"

# Secrets (never commit these — use wrangler secret put):
#   npx wrangler secret put JWT_SECRET
${dbConfig}
# Custom domain:
# [routes]
# { pattern = "api.example.com/*", zone_name = "example.com" }
`;
}
