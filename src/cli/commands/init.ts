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

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync, spawn } from 'node:child_process';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

// ============================================================================
// Types
// ============================================================================

export interface InitOptions {
  name?: string;
  adapter?: 'mongokit' | 'custom';
  tenant?: 'multi' | 'single';
  typescript?: boolean;
  skipInstall?: boolean;
  force?: boolean;
}

interface ProjectConfig {
  name: string;
  adapter: 'mongokit' | 'custom';
  tenant: 'multi' | 'single';
  typescript: boolean;
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
║                    🔥 Arc Project Setup                       ║
║         Resource-Oriented Backend Framework                   ║
╚═══════════════════════════════════════════════════════════════╝
`);

  // Gather configuration (from options or prompts)
  const config = await gatherConfig(options);

  console.log(`\n📦 Creating project: ${config.name}`);
  console.log(`   Adapter: ${config.adapter === 'mongokit' ? 'MongoKit (MongoDB)' : 'Custom'}`);
  console.log(`   Tenant: ${config.tenant === 'multi' ? 'Multi-tenant' : 'Single-tenant'}`);
  console.log(`   Language: ${config.typescript ? 'TypeScript' : 'JavaScript'}\n`);

  const projectPath = path.join(process.cwd(), config.name);

  // Check if directory exists
  try {
    await fs.access(projectPath);
    if (!options.force) {
      console.error(`❌ Directory "${config.name}" already exists. Use --force to overwrite.`);
      process.exit(1);
    }
  } catch {
    // Directory doesn't exist - good
  }

  // Detect package manager
  const packageManager = detectPackageManager();
  console.log(`📦 Using package manager: ${packageManager}\n`);

  // Create project structure (without dependencies in package.json)
  await createProjectStructure(projectPath, config);

  // Install dependencies unless --skip-install
  if (!options.skipInstall) {
    console.log('\n📥 Installing dependencies...\n');
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
    if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
    if (existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  } catch {
    // Ignore errors
  }

  // Check which package managers are available
  if (isCommandAvailable('pnpm')) return 'pnpm';
  if (isCommandAvailable('yarn')) return 'yarn';
  if (isCommandAvailable('bun')) return 'bun';

  // Default to npm
  return 'npm';
}

/**
 * Check if a command is available in PATH
 */
function isCommandAvailable(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync check if file exists
 */
function existsSync(filePath: string): boolean {
  try {
    require('fs').accessSync(filePath);
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
  pm: PackageManager
): Promise<void> {
  // Build dependency lists
  const deps = [
    '@classytic/arc@latest',
    'fastify@latest',
    '@fastify/cors@latest',
    '@fastify/helmet@latest',
    '@fastify/jwt@latest',
    '@fastify/rate-limit@latest',
    '@fastify/sensible@latest',
    '@fastify/under-pressure@latest',
    'bcryptjs@latest',
    'dotenv@latest',
    'jsonwebtoken@latest',
  ];

  if (config.adapter === 'mongokit') {
    deps.push('@classytic/mongokit@latest', 'mongoose@latest');
  }

  const devDeps = [
    'vitest@latest',
    'pino-pretty@latest',
  ];

  if (config.typescript) {
    devDeps.push(
      'typescript@latest',
      '@types/node@latest',
      '@types/jsonwebtoken@latest',
      'tsx@latest'
    );
  }

  // Build install commands based on package manager
  const installCmd = getInstallCommand(pm, deps, false);
  const installDevCmd = getInstallCommand(pm, devDeps, true);

  // Run installation
  console.log(`  Installing dependencies...`);
  await runCommand(installCmd, projectPath);

  console.log(`  Installing dev dependencies...`);
  await runCommand(installDevCmd, projectPath);

  console.log(`\n✅ Dependencies installed successfully!`);
}

/**
 * Get the install command for a package manager
 */
function getInstallCommand(pm: PackageManager, packages: string[], isDev: boolean): string {
  const pkgList = packages.join(' ');

  switch (pm) {
    case 'pnpm':
      return `pnpm add ${isDev ? '-D' : ''} ${pkgList}`;
    case 'yarn':
      return `yarn add ${isDev ? '-D' : ''} ${pkgList}`;
    case 'bun':
      return `bun add ${isDev ? '-d' : ''} ${pkgList}`;
    case 'npm':
    default:
      return `npm install ${isDev ? '--save-dev' : ''} ${pkgList}`;
  }
}

/**
 * Run a shell command in a directory
 */
function runCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', reject);
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

  try {
    // Project name
    const name = options.name || (await question('📁 Project name: ')) || 'my-arc-app';

    // Adapter choice
    let adapter: 'mongokit' | 'custom' = options.adapter || 'mongokit';
    if (!options.adapter) {
      const adapterChoice = await question('🗄️  Database adapter [1=MongoKit (recommended), 2=Custom]: ');
      adapter = adapterChoice === '2' ? 'custom' : 'mongokit';
    }

    // Tenant mode
    let tenant: 'multi' | 'single' = options.tenant || 'single';
    if (!options.tenant) {
      const tenantChoice = await question('🏢 Tenant mode [1=Single-tenant, 2=Multi-tenant]: ');
      tenant = tenantChoice === '2' ? 'multi' : 'single';
    }

    // TypeScript or JavaScript
    let typescript = options.typescript ?? true;
    if (options.typescript === undefined) {
      const tsChoice = await question('�� Language [1=TypeScript (recommended), 2=JavaScript]: ');
      typescript = tsChoice !== '2';
    }

    return { name, adapter, tenant, typescript };
  } finally {
    rl.close();
  }
}

// ============================================================================
// Project Structure Creation
// ============================================================================

async function createProjectStructure(projectPath: string, config: ProjectConfig): Promise<void> {
  const ext = config.typescript ? 'ts' : 'js';

  // Create directories - Clean architecture (organized by resource, no barrels)
  const dirs = [
    '',
    'src',
    'src/config',              // Config & env loading (import first!)
    'src/shared',              // Shared utilities (adapters, presets, permissions)
    'src/shared/presets',      // Preset definitions
    'src/plugins',             // App-specific plugins
    'src/resources',           // Resource definitions
    'src/resources/user',      // User resource (user.model, user.repository, etc.)
    'src/resources/auth',      // Auth resource (auth.resource, auth.handlers, etc.)
    'src/resources/example',   // Example resource
    'tests',
  ];

  for (const dir of dirs) {
    await fs.mkdir(path.join(projectPath, dir), { recursive: true });
    console.log(`  📁 Created: ${dir || '/'}`);
  }

  // Generate and write files
  const files: Record<string, string> = {
    'package.json': packageJsonTemplate(config),
    '.gitignore': gitignoreTemplate(),
    '.env.example': envExampleTemplate(config),
    '.env.dev': envDevTemplate(config),
    'README.md': readmeTemplate(config),
  };

  // TypeScript config
  if (config.typescript) {
    files['tsconfig.json'] = tsconfigTemplate();
  }

  // Vitest config (always needed for path alias resolution)
  files['vitest.config.ts'] = vitestConfigTemplate(config);

  // Config files (env loader FIRST - imported before everything)
  files[`src/config/env.${ext}`] = envLoaderTemplate(config);
  files[`src/config/index.${ext}`] = configTemplate(config);

  // App factory + Entry point (separation for workers/tests)
  files[`src/app.${ext}`] = appTemplate(config);
  files[`src/index.${ext}`] = indexTemplate(config);

  // Shared utilities
  files[`src/shared/index.${ext}`] = sharedIndexTemplate(config);
  files[`src/shared/adapter.${ext}`] = config.adapter === 'mongokit'
    ? createAdapterTemplate(config)
    : customAdapterTemplate(config);
  files[`src/shared/permissions.${ext}`] = permissionsTemplate(config);

  // Presets
  if (config.tenant === 'multi') {
    files[`src/shared/presets/index.${ext}`] = presetsMultiTenantTemplate(config);
    files[`src/shared/presets/flexible-multi-tenant.${ext}`] = flexibleMultiTenantPresetTemplate(config);
  } else {
    files[`src/shared/presets/index.${ext}`] = presetsSingleTenantTemplate(config);
  }

  // Plugins (app-specific, easy to extend)
  files[`src/plugins/index.${ext}`] = pluginsIndexTemplate(config);

  // Resources (organized by folder, no barrels - prefixed filenames)
  files[`src/resources/index.${ext}`] = resourcesIndexTemplate(config);

  // User resource (src/resources/user/)
  files[`src/resources/user/user.model.${ext}`] = userModelTemplate(config);
  files[`src/resources/user/user.repository.${ext}`] = userRepositoryTemplate(config);
  files[`src/resources/user/user.controller.${ext}`] = userControllerTemplate(config);

  // Auth resource (src/resources/auth/)
  files[`src/resources/auth/auth.resource.${ext}`] = authResourceTemplate(config);
  files[`src/resources/auth/auth.handlers.${ext}`] = authHandlersTemplate(config);
  files[`src/resources/auth/auth.schemas.${ext}`] = authSchemasTemplate(config);

  // Example resource (src/resources/example/)
  files[`src/resources/example/example.model.${ext}`] = exampleModelTemplate(config);
  files[`src/resources/example/example.repository.${ext}`] = exampleRepositoryTemplate(config);
  files[`src/resources/example/example.resource.${ext}`] = exampleResourceTemplate(config);
  files[`src/resources/example/example.controller.${ext}`] = exampleControllerTemplate(config);
  files[`src/resources/example/example.schemas.${ext}`] = exampleSchemasTemplate(config);

  // Tests
  files[`tests/example.test.${ext}`] = exampleTestTemplate(config);
  files[`tests/auth.test.${ext}`] = authTestTemplate(config);

  // Write all files
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(projectPath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    console.log(`  ✅ Created: ${filePath}`);
  }
}

// ============================================================================
// Templates
// ============================================================================

function packageJsonTemplate(config: ProjectConfig): string {
  // Minimal package.json - dependencies are installed via package manager
  const scripts: Record<string, string> = config.typescript
    ? {
        dev: 'tsx watch src/index.ts',
        build: 'tsc',
        start: 'node dist/index.js',
        test: 'vitest run',
        'test:watch': 'vitest',
      }
    : {
        dev: 'node --watch src/index.js',
        start: 'node src/index.js',
        test: 'vitest run',
        'test:watch': 'vitest',
      };

  // Subpath imports for clean DX
  const imports: Record<string, string> = config.typescript
    ? {
        '#config/*': './dist/config/*',
        '#shared/*': './dist/shared/*',
        '#resources/*': './dist/resources/*',
        '#plugins/*': './dist/plugins/*',
      }
    : {
        '#config/*': './src/config/*',
        '#shared/*': './src/shared/*',
        '#resources/*': './src/resources/*',
        '#plugins/*': './src/plugins/*',
      };

  return JSON.stringify(
    {
      name: config.name,
      version: '1.0.0',
      type: 'module',
      main: config.typescript ? 'dist/index.js' : 'src/index.js',
      imports,
      scripts,
      engines: {
        node: '>=20',
      },
    },
    null,
    2
  );
}

function tsconfigTemplate(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        resolveJsonModule: true,
        paths: {
          '#shared/*': ['./src/shared/*'],
          '#resources/*': ['./src/resources/*'],
          '#config/*': ['./src/config/*'],
          '#plugins/*': ['./src/plugins/*'],
        },
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2
  );
}

function vitestConfigTemplate(config: ProjectConfig): string {
  const srcDir = config.typescript ? './src' : './src';

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

# Environment
.env
.env.local
.env.*.local

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
  let content = `# Server
PORT=8040
HOST=0.0.0.0
NODE_ENV=development

# JWT
JWT_SECRET=your-32-character-minimum-secret-here
`;

  if (config.adapter === 'mongokit') {
    content += `
# MongoDB
MONGODB_URI=mongodb://localhost:27017/${config.name}
`;
  }

  if (config.tenant === 'multi') {
    content += `
# Multi-tenant
DEFAULT_ORG_ID=
`;
  }

  return content;
}

function readmeTemplate(config: ProjectConfig): string {
  const ext = config.typescript ? 'ts' : 'js';

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
│   ├── adapter.${ext}          # ${config.adapter === 'mongokit' ? 'MongoKit adapter factory' : 'Custom adapter'}
│   ├── permissions.${ext}      # Permission helpers
│   └── presets/             # ${config.tenant === 'multi' ? 'Multi-tenant presets' : 'Standard presets'}
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

- **\`src/index.${ext}\`** - HTTP server entry point
- **\`src/app.${ext}\`** - App factory (import for workers/tests)

\`\`\`${config.typescript ? 'typescript' : 'javascript'}
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

\`\`\`${config.typescript ? 'typescript' : 'javascript'}
import productResource from './product/index.js';

export const resources = [
  exampleResource,
  productResource,  // Add here
];
\`\`\`

### Adding Plugins

Add custom plugins in \`src/plugins/index.${ext}\`:

\`\`\`${config.typescript ? 'typescript' : 'javascript'}
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

## Environment Files

- \`.env.dev\` - Development (default)
- \`.env.test\` - Testing
- \`.env.prod\` - Production
- \`.env\` - Fallback

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
`;
}

function indexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

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
${config.adapter === 'mongokit' ? "import mongoose from 'mongoose';" : ''}
import { createAppInstance } from './app.js';

async function main()${ts ? ': Promise<void>' : ''} {
  console.log(\`🔧 Environment: \${config.env}\`);
${config.adapter === 'mongokit' ? `
  // Connect to MongoDB
  await mongoose.connect(config.database.uri);
  console.log('📦 Connected to MongoDB');
` : ''}
  // Create and configure app
  const app = await createAppInstance();

  // Start server
  await app.listen({ port: config.server.port, host: config.server.host });
  console.log(\`🚀 Server running at http://\${config.server.host}:\${config.server.port}\`);
}

main().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
`;
}

function appTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : '';

  return `/**
 * ${config.name} - App Factory
 * Generated by Arc CLI
 *
 * Creates and configures the Fastify app instance.
 * Can be imported by:
 * - index.ts (HTTP server)
 * - worker.ts (background workers)
 * - tests (integration tests)
 */

${typeImport}import config from '#config/index.js';
import { createApp } from '@classytic/arc/factory';

// App-specific plugins
import { registerPlugins } from '#plugins/index.js';

// Resource registry
import { registerResources } from '#resources/index.js';

/**
 * Create a fully configured app instance
 *
 * @returns Configured Fastify instance ready to use
 */
export async function createAppInstance()${ts ? ': Promise<FastifyInstance>' : ''} {
  // Create Arc app with base configuration
  const app = await createApp({
    preset: config.env === 'production' ? 'production' : 'development',
    auth: {
      jwt: { secret: config.jwt.secret },
    },
    cors: {
      origin: config.cors.origins,
      methods: config.cors.methods,
      allowedHeaders: config.cors.allowedHeaders,
      credentials: config.cors.credentials,
    },
  });

  // Register app-specific plugins (explicit dependency injection)
  await registerPlugins(app, { config });

  // Register all resources
  await registerResources(app);

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
 * Loads .env files based on NODE_ENV.
 *
 * Usage:
 *   import './config/env.js';  // First line of entry point
 */

import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Normalize environment string to short form
 */
function normalizeEnv(env${ts ? ': string | undefined' : ''})${ts ? ': string' : ''} {
  const normalized = (env || '').toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return 'prod';
  if (normalized === 'test' || normalized === 'qa') return 'test';
  return 'dev';
}

// Determine environment
const env = normalizeEnv(process.env.NODE_ENV);

// Load environment-specific .env file
const envFile = resolve(process.cwd(), \`.env.\${env}\`);
const defaultEnvFile = resolve(process.cwd(), '.env');

if (existsSync(envFile)) {
  dotenv.config({ path: envFile });
  console.log(\`📄 Loaded: .env.\${env}\`);
} else if (existsSync(defaultEnvFile)) {
  dotenv.config({ path: defaultEnvFile });
  console.log('📄 Loaded: .env');
} else {
  console.warn('⚠️  No .env file found');
}

// Export for reference
export const ENV = env;
`;
}

function envDevTemplate(config: ProjectConfig): string {
  let content = `# Development Environment
NODE_ENV=development

# Server
PORT=8040
HOST=0.0.0.0

# JWT
JWT_SECRET=dev-secret-change-in-production-min-32-chars
JWT_EXPIRES_IN=7d

# CORS - Allowed origins
# Options:
#   * = allow all origins (not recommended for production)
#   Comma-separated list = specific origins only
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
`;

  if (config.adapter === 'mongokit') {
    content += `
# MongoDB
MONGODB_URI=mongodb://localhost:27017/${config.name}
`;
  }

  if (config.tenant === 'multi') {
    content += `
# Multi-tenant
ORG_HEADER=x-organization-id
`;
  }

  return content;
}

function pluginsIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : '';
  const configType = ts ? ': { config: AppConfig }' : '';
  const appType = ts ? ': FastifyInstance' : '';

  let content = `/**
 * App Plugins Registry
 *
 * Register your app-specific plugins here.
 * Dependencies are passed explicitly (no shims, no magic).
 */

${typeImport}${ts ? "import type { AppConfig } from '../config/index.js';\n" : ''}import { openApiPlugin, scalarPlugin } from '@classytic/arc/docs';
`;

  if (config.tenant === 'multi') {
    content += `import { orgScopePlugin } from '@classytic/arc/org';\n`;
  }

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
)${ts ? ': Promise<void>' : ''} {
  const { config } = deps;

  // API Documentation (Scalar UI)
  // OpenAPI spec: /_docs/openapi.json
  // Scalar UI: /docs
  await app.register(openApiPlugin, {
    title: '${config.name} API',
    version: '1.0.0',
    description: 'API documentation for ${config.name}',
  });
  await app.register(scalarPlugin, {
    routePrefix: '/docs',
    theme: 'default',
  });
`;

  if (config.tenant === 'multi') {
    content += `
  // Multi-tenant org scope
  await app.register(orgScopePlugin, {
    header: config.org?.header || 'x-organization-id',
    bypassRoles: ['superadmin', 'admin'],
  });
`;
  }

  content += `
  // Add your custom plugins here:
  // await app.register(myCustomPlugin, { ...options });
}
`;

  return content;
}

function resourcesIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : '';
  const appType = ts ? ': FastifyInstance' : '';

  return `/**
 * Resources Registry
 *
 * Central registry for all API resources.
 * Flat structure - no barrels, direct imports.
 */

${typeImport}
// Auth resources (register, login, /users/me)
import { authResource, userProfileResource } from './auth/auth.resource.js';

// App resources
import exampleResource from './example/example.resource.js';

// Add more resources here:
// import productResource from './product/product.resource.js';

/**
 * All registered resources
 */
export const resources = [
  authResource,
  userProfileResource,
  exampleResource,
]${ts ? ' as const' : ''};

/**
 * Register all resources with the app
 */
export async function registerResources(app${appType})${ts ? ': Promise<void>' : ''} {
  for (const resource of resources) {
    await app.register(resource.toPlugin());
  }
}
`;
}

function sharedIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

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

// Permission helpers
export {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
  allOf,
  anyOf,
  denyAll,
  when,${ts ? '\n  type PermissionCheck,' : ''}
} from '@classytic/arc/permissions';

// Application permissions
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
${ts ? "import type { Model } from 'mongoose';\nimport type { Repository } from '@classytic/mongokit';" : ''}

/**
 * Create a MongoKit-powered adapter for a resource
 *
 * Note: Query parsing is handled by MongoKit's Repository class.
 * Just pass the model and repository - Arc handles the rest.
 */
export function createAdapter${ts ? '<TDoc, TRepo extends Repository<TDoc>>' : ''}(
  model${ts ? ': Model<TDoc>' : ''},
  repository${ts ? ': TRepo' : ''}
)${ts ? ': ReturnType<typeof createMongooseAdapter>' : ''} {
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
 * Implement your own database adapter here.
 */

import { createMongooseAdapter } from '@classytic/arc';
${ts ? "import type { Model } from 'mongoose';" : ''}

/**
 * Create a custom adapter for a resource
 *
 * Implement this based on your database choice:
 * - Prisma: Use @classytic/prismakit (coming soon)
 * - Drizzle: Create custom adapter
 * - Raw SQL: Create custom adapter
 */
export function createAdapter${ts ? '<TDoc>' : ''}(
  model${ts ? ': Model<TDoc>' : ''},
  repository${ts ? ': any' : ''}
)${ts ? ': ReturnType<typeof createMongooseAdapter>' : ''} {
  // TODO: Implement your custom adapter
  return createMongooseAdapter({
    model,
    repository,
  });
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
  bypassRoles: ['superadmin', 'admin'],
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
}${ts ? ' as const' : ''};

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
}${ts ? ' as const' : ''};

export default presets;
`;
}

function flexibleMultiTenantPresetTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeAnnotations = ts ? `
interface FlexibleMultiTenantOptions {
  tenantField?: string;
  bypassRoles?: string[];
  extractOrganizationId?: (request: any) => string | null;
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
` : '';

  return `/**
 * Flexible Multi-Tenant Preset
 *
 * Smarter tenant filtering that works with public + authenticated routes.
 *
 * Philosophy:
 * - No org header → No filtering (public data, all orgs)
 * - Org header present → Require auth, filter by org
 *
 * This differs from Arc's strict multiTenant which always requires auth.
 */
${typeAnnotations}
/**
 * Default organization ID extractor
 * Tries multiple sources in order of priority
 */
function defaultExtractOrganizationId(request${ts ? ': any' : ''})${ts ? ': string | null' : ''} {
  // Priority 1: Explicit context (set by org-scope plugin)
  if (request.context?.organizationId) {
    return String(request.context.organizationId);
  }

  // Priority 2: User's organizationId field
  if (request.user?.organizationId) {
    return String(request.user.organizationId);
  }

  // Priority 3: User's organization object (nested)
  if (request.user?.organization) {
    const org = request.user.organization;
    return String(org._id || org.id || org);
  }

  return null;
}

/**
 * Create flexible tenant filter middleware
 * Only filters when org context is present
 */
function createFlexibleTenantFilter(
  tenantField${ts ? ': string' : ''},
  bypassRoles${ts ? ': string[]' : ''},
  extractOrganizationId${ts ? ': (request: any) => string | null' : ''}
) {
  return async (request${ts ? ': any' : ''}, reply${ts ? ': any' : ''}) => {
    const user = request.user;
    const orgId = extractOrganizationId(request);

    // No org context - allow through (public data, no filtering)
    if (!orgId) {
      request.log?.debug?.({ msg: 'No org context - showing all data' });
      return;
    }

    // Org context present - auth should already be handled by org-scope plugin
    // But double-check for safety
    if (!user) {
      request.log?.warn?.({ msg: 'Org context present but no user - should not happen' });
      return reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required for organization-scoped data',
      });
    }

    // Bypass roles skip filter (superadmin sees all)
    const userRoles = Array.isArray(user.roles) ? user.roles : [];
    if (bypassRoles.some((r${ts ? ': string' : ''}) => userRoles.includes(r))) {
      request.log?.debug?.({ msg: 'Bypass role - no tenant filter' });
      return;
    }

    // Apply tenant filter to query
    request.query = request.query ?? {};
    request.query._policyFilters = {
      ...(request.query._policyFilters ?? {}),
      [tenantField]: orgId,
    };

    request.log?.debug?.({ msg: 'Tenant filter applied', orgId, tenantField });
  };
}

/**
 * Create tenant injection middleware
 * Injects tenant ID into request body on create
 */
function createTenantInjection(
  tenantField${ts ? ': string' : ''},
  extractOrganizationId${ts ? ': (request: any) => string | null' : ''}
) {
  return async (request${ts ? ': any' : ''}, reply${ts ? ': any' : ''}) => {
    const orgId = extractOrganizationId(request);

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
 * @param options.bypassRoles - Roles that bypass tenant isolation (default: ['superadmin'])
 * @param options.extractOrganizationId - Custom org ID extractor function
 */
export function flexibleMultiTenantPreset(options${ts ? ': FlexibleMultiTenantOptions = {}' : ' = {}'})${ts ? ': Preset' : ''} {
  const {
    tenantField = 'organizationId',
    bypassRoles = ['superadmin'],
    extractOrganizationId = defaultExtractOrganizationId,
  } = options;

  const tenantFilter = createFlexibleTenantFilter(tenantField, bypassRoles, extractOrganizationId);
  const tenantInjection = createTenantInjection(tenantField, extractOrganizationId);

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
  const typeImport = ts ? ",\n  type PermissionCheck," : '';
  const returnType = ts ? ': PermissionCheck' : '';

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

  if (config.tenant === 'multi') {
    content += `
/**
 * Require organization owner
 */
export const requireOrgOwner = ()${returnType} =>
  requireRoles(['owner'], { bypassRoles: ['admin', 'superadmin'] });

/**
 * Require organization manager or higher
 */
export const requireOrgManager = ()${returnType} =>
  requireRoles(['owner', 'manager'], { bypassRoles: ['admin', 'superadmin'] });

/**
 * Require organization staff (any org member)
 */
export const requireOrgStaff = ()${returnType} =>
  requireRoles(['owner', 'manager', 'staff'], { bypassRoles: ['admin', 'superadmin'] });
`;
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

  if (config.tenant === 'multi') {
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
  }

  return content;
}

function configTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  let typeDefinition = '';
  if (ts) {
    typeDefinition = `
export interface AppConfig {
  env: string;
  server: {
    port: number;
    host: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  cors: {
    origins: string[] | boolean;  // true = allow all ('*')
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };${config.adapter === 'mongokit' ? `
  database: {
    uri: string;
  };` : ''}${config.tenant === 'multi' ? `
  org?: {
    header: string;
  };` : ''}
}
`;
  }

  return `/**
 * Application Configuration
 *
 * All config is loaded from environment variables.
 * ENV file is loaded by config/env.ts (imported first in entry points).
 */
${typeDefinition}
const config${ts ? ': AppConfig' : ''} = {
  env: process.env.NODE_ENV || 'development',

  server: {
    port: parseInt(process.env.PORT || '8040', 10),
    host: process.env.HOST || '0.0.0.0',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

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
${config.adapter === 'mongokit' ? `
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/${config.name}',
  },
` : ''}${config.tenant === 'multi' ? `
  org: {
    header: process.env.ORG_HEADER || 'x-organization-id',
  },
` : ''}};

export default config;
`;
}

function databaseConfigTemplate(config: ProjectConfig): string {
  if (config.adapter === 'mongokit') {
    return `/**
 * Database Configuration
 */

export const databaseConfig = {
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/${config.name}',
};

export default databaseConfig;
`;
  }

  return `/**
 * Database Configuration
 *
 * Configure your database connection here.
 */

export const databaseConfig = {
  // Add your database configuration
};

export default databaseConfig;
`;
}

function exampleModelTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeExport = ts ? `
export type ExampleDocument = mongoose.InferSchemaType<typeof exampleSchema>;
export type ExampleModel = mongoose.Model<ExampleDocument>;
` : '';

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
${config.tenant === 'multi' ? "    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },\n" : ''}    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
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
${config.tenant === 'multi' ? "exampleSchema.index({ organizationId: 1, deletedAt: 1 });\n" : ''}${typeExport}
const Example = mongoose.model${ts ? '<ExampleDocument>' : ''}('Example', exampleSchema);

export default Example;
`;
}

function exampleRepositoryTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { ExampleDocument } from './example.model.js';\n" : '';
  const generic = ts ? '<ExampleDocument>' : '';

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
} from '@classytic/mongokit';
${typeImport}import Example from './example.model.js';

class ExampleRepository extends Repository${generic} {
  constructor() {
    super(Example, [
      methodRegistryPlugin(),  // Required for plugin method registration
      softDeletePlugin(),      // Soft delete support
    ]);
  }

  /**
   * Find all active (non-deleted) records
   */
  async findActive() {
    return this.Model.find({ isActive: true, deletedAt: null }).lean();
  }
${config.tenant === 'multi' ? `
  /**
   * Find active records for an organization
   */
  async findActiveByOrg(organizationId${ts ? ': string' : ''}) {
    return this.Model.find({
      organizationId,
      isActive: true,
      deletedAt: null,
    }).lean();
  }
` : ''}
  // Note: softDeletePlugin provides restore() and getDeleted() methods automatically
}

const exampleRepository = new ExampleRepository();

export default exampleRepository;
export { ExampleRepository };
`;
}

function exampleResourceTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const presets = config.tenant === 'multi'
    ? "['softDelete', 'flexibleMultiTenant']"
    : "['softDelete']";

  return `/**
 * Example Resource
 * Generated by Arc CLI
 *
 * A complete resource with:
 * - Model (Mongoose schema)
 * - Repository (MongoKit with plugins)
 * - Permissions (role-based access)
 * - Presets (soft delete${config.tenant === 'multi' ? ', multi-tenant' : ''})
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { publicReadPermissions } from '#shared/permissions.js';
${config.tenant === 'multi' ? "import { flexibleMultiTenantPreset } from '#shared/presets/flexible-multi-tenant.js';\n" : ''}import Example from './example.model.js';
import exampleRepository from './example.repository.js';
import exampleController from './example.controller.js';

const exampleResource = defineResource({
  name: 'example',
  displayName: 'Examples',
  prefix: '/examples',

  adapter: createAdapter(Example, exampleRepository),
  controller: exampleController,

  presets: [
    'softDelete',${config.tenant === 'multi' ? `
    flexibleMultiTenantPreset({ tenantField: 'organizationId' }),` : ''}
  ],

  permissions: publicReadPermissions,

  // Add custom routes here:
  // additionalRoutes: [
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
  const ts = config.typescript;

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
    super(exampleRepository${ts ? ' as any' : ''}, { schemaOptions: exampleSchemaOptions });
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
  const multiTenantFields = config.tenant === 'multi';

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
    // Mark fields as system-managed (excluded from create/update)
    // deletedAt: { systemManaged: true },
  },
  query: {
    filterableFields: {
      isActive: 'boolean',${multiTenantFields ? `
      organizationId: 'ObjectId',` : ''}
      createdAt: 'date',
    },
  },
});

// Schema options for controller
export const exampleSchemaOptions${ts ? ': any' : ''} = {
  query: {${multiTenantFields ? `
    allowedPopulate: ['organizationId'],` : ''}
    filterableFields: {
      isActive: 'boolean',${multiTenantFields ? `
      organizationId: 'ObjectId',` : ''}
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
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
${config.adapter === 'mongokit' ? "import mongoose from 'mongoose';\n" : ''}import { createAppInstance } from '../src/app.js';
${ts ? "import type { FastifyInstance } from 'fastify';\n" : ''}
describe('Example Resource', () => {
  let app${ts ? ': FastifyInstance' : ''};

  beforeAll(async () => {
${config.adapter === 'mongokit' ? `    // Connect to test database
    const testDbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/${config.name}-test';
    await mongoose.connect(testDbUri);
` : ''}
    // Create app instance
    app = await createAppInstance();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
${config.adapter === 'mongokit' ? '    await mongoose.connection.close();' : ''}
  });

  describe('GET /examples', () => {
    it('should return a list of examples', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/examples',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('docs');
      expect(Array.isArray(body.docs)).toBe(true);
    });
  });

  describe('POST /examples', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/examples',
        payload: { name: 'Test Example' },
      });

      // Should fail without auth token
      expect(response.statusCode).toBe(401);
    });
  });

  // Add more tests as needed:
  // - GET /examples/:id
  // - PATCH /examples/:id
  // - DELETE /examples/:id
  // - Custom endpoints
});
`;
}

// ============================================================================
// User & Auth Templates
// ============================================================================

function userModelTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  const orgRoles = config.tenant === 'multi' ? `
// Organization roles (for multi-tenant)
const ORG_ROLES = ['owner', 'manager', 'hr', 'staff', 'contractor'] as const;
type OrgRole = typeof ORG_ROLES[number];
` : '';

  const orgInterface = config.tenant === 'multi' ? `
type UserOrganization = {
  organizationId: Types.ObjectId;
  organizationName: string;
  roles: OrgRole[];
  joinedAt: Date;
};
` : '';

  const orgSchema = config.tenant === 'multi' ? `
    // Multi-org support
    organizations: [{
      organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
      organizationName: { type: String, required: true },
      roles: { type: [String], enum: ORG_ROLES, default: [] },
      joinedAt: { type: Date, default: () => new Date() },
    }],
` : '';

  const orgMethods = config.tenant === 'multi' ? `
// Organization methods
userSchema.methods.getOrgRoles = function(orgId${ts ? ': Types.ObjectId | string' : ''}) {
  const org = this.organizations.find(o => o.organizationId.toString() === orgId.toString());
  return org?.roles || [];
};

userSchema.methods.hasOrgAccess = function(orgId${ts ? ': Types.ObjectId | string' : ''}) {
  return this.organizations.some(o => o.organizationId.toString() === orgId.toString());
};

userSchema.methods.addOrganization = function(
  organizationId${ts ? ': Types.ObjectId' : ''},
  organizationName${ts ? ': string' : ''},
  roles${ts ? ': OrgRole[]' : ''} = []
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

userSchema.methods.removeOrganization = function(organizationId${ts ? ': Types.ObjectId' : ''}) {
  this.organizations = this.organizations.filter(o => o.organizationId.toString() !== organizationId.toString());
  return this;
};

// Index for org queries
userSchema.index({ 'organizations.organizationId': 1 });
` : '';

  const userType = ts ? `
type PlatformRole = 'user' | 'admin' | 'superadmin';

type User = {
  name: string;
  email: string;
  password: string;
  roles: PlatformRole[];${config.tenant === 'multi' ? `
  organizations: UserOrganization[];` : ''}
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
};

type UserMethods = {
  matchPassword: (enteredPassword: string) => Promise<boolean>;${config.tenant === 'multi' ? `
  getOrgRoles: (orgId: Types.ObjectId | string) => OrgRole[];
  hasOrgAccess: (orgId: Types.ObjectId | string) => boolean;
  addOrganization: (orgId: Types.ObjectId, name: string, roles?: OrgRole[]) => UserDocument;
  removeOrganization: (orgId: Types.ObjectId) => UserDocument;` : ''}
};

export type UserDocument = HydratedDocument<User, UserMethods>;
export type UserModel = Model<User, {}, UserMethods>;
` : '';

  return `/**
 * User Model
 * Generated by Arc CLI
 */

import bcrypt from 'bcryptjs';
import mongoose${ts ? ', { type HydratedDocument, type Model, type Types }' : ''} from 'mongoose';
${orgRoles}
const { Schema } = mongoose;
${orgInterface}${userType}
const userSchema = new Schema${ts ? '<User, UserModel, UserMethods>' : ''}(
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
userSchema.methods.matchPassword = async function(enteredPassword${ts ? ': string' : ''}) {
  return bcrypt.compare(enteredPassword, this.password);
};
${orgMethods}
// Exclude password in JSON
userSchema.set('toJSON', {
  transform: (_doc, ret${ts ? ': any' : ''}) => {
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

const User = mongoose.models.User${ts ? ' as UserModel' : ''} || mongoose.model${ts ? '<User, UserModel>' : ''}('User', userSchema);
export default User;
`;
}

function userRepositoryTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { UserDocument } from './user.model.js';\nimport type { ClientSession, Types } from 'mongoose';\n" : '';

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

${ts ? 'type ID = string | Types.ObjectId;\n' : ''}
class UserRepository extends Repository${ts ? '<UserDocument>' : ''} {
  constructor() {
    super(User${ts ? ' as any' : ''}, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]);
  }

  /**
   * Find user by email
   */
  async findByEmail(email${ts ? ': string' : ''}) {
    return this.Model.findOne({ email: email.toLowerCase().trim() });
  }

  /**
   * Find user by reset token
   */
  async findByResetToken(token${ts ? ': string' : ''}) {
    return this.Model.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });
  }

  /**
   * Check if email exists
   */
  async emailExists(email${ts ? ': string' : ''})${ts ? ': Promise<boolean>' : ''} {
    const result = await this.Model.exists({ email: email.toLowerCase().trim() });
    return !!result;
  }

  /**
   * Update user password (triggers hash middleware)
   */
  async updatePassword(userId${ts ? ': ID' : ''}, newPassword${ts ? ': string' : ''}, options${ts ? ': { session?: ClientSession }' : ''} = {}) {
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
  async setResetToken(userId${ts ? ': ID' : ''}, token${ts ? ': string' : ''}, expiresAt${ts ? ': Date' : ''}) {
    return this.Model.findByIdAndUpdate(
      userId,
      { resetPasswordToken: token, resetPasswordExpires: expiresAt },
      { new: true }
    );
  }
${config.tenant === 'multi' ? `
  /**
   * Find users by organization
   */
  async findByOrganization(organizationId${ts ? ': ID' : ''}) {
    return this.Model.find({ 'organizations.organizationId': organizationId })
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .lean();
  }
` : ''}
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
    super(userRepository${ts ? ' as any' : ''});
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

  adapter: createAdapter(User${ts ? ' as any' : ''}, userRepository${ts ? ' as any' : ''}),
  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/register',
      summary: 'Register new user',
      permissions: allowPublic(),
      handler: handlers.register,
      wrapHandler: false,
      schema: { body: schemas.registerBody },
    },
    {
      method: 'POST',
      path: '/login',
      summary: 'User login',
      permissions: allowPublic(),
      handler: handlers.login,
      wrapHandler: false,
      schema: { body: schemas.loginBody },
    },
    {
      method: 'POST',
      path: '/refresh',
      summary: 'Refresh access token',
      permissions: allowPublic(),
      handler: handlers.refreshToken,
      wrapHandler: false,
      schema: { body: schemas.refreshBody },
    },
    {
      method: 'POST',
      path: '/forgot-password',
      summary: 'Request password reset',
      permissions: allowPublic(),
      handler: handlers.forgotPassword,
      wrapHandler: false,
      schema: { body: schemas.forgotBody },
    },
    {
      method: 'POST',
      path: '/reset-password',
      summary: 'Reset password with token',
      permissions: allowPublic(),
      handler: handlers.resetPassword,
      wrapHandler: false,
      schema: { body: schemas.resetBody },
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

  adapter: createAdapter(User${ts ? ' as any' : ''}, userRepository${ts ? ' as any' : ''}),
  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/me',
      summary: 'Get current user profile',
      permissions: requireAuth(),
      handler: handlers.getUserProfile,
      wrapHandler: false,
    },
    {
      method: 'PATCH',
      path: '/me',
      summary: 'Update current user profile',
      permissions: requireAuth(),
      handler: handlers.updateUserProfile,
      wrapHandler: false,
      schema: { body: schemas.updateUserBody },
    },
  ],
});

export default authResource;
`;
}

function authHandlersTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeAnnotations = ts ? `
import type { FastifyRequest, FastifyReply } from 'fastify';
` : '';

  return `/**
 * Auth Handlers
 * Generated by Arc CLI
 */

import jwt from 'jsonwebtoken';
import config from '#config/index.js';
import userRepository from '../user/user.repository.js';
${typeAnnotations}
// Token helpers
function generateTokens(userId${ts ? ': string' : ''}) {
  const accessToken = jwt.sign({ id: userId }, config.jwt.secret, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: userId }, config.jwt.secret, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

/**
 * Register new user
 */
export async function register(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const { name, email, password } = request.body${ts ? ' as any' : ''};

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
export async function login(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const { email, password } = request.body${ts ? ' as any' : ''};

    const user = await userRepository.findByEmail(email);
    if (!user || !(await user.matchPassword(password))) {
      return reply.code(401).send({ success: false, message: 'Invalid credentials' });
    }

    const tokens = generateTokens(user._id.toString());

    return reply.send({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, roles: user.roles },
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
export async function refreshToken(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const { token } = request.body${ts ? ' as any' : ''};
    if (!token) {
      return reply.code(401).send({ success: false, message: 'Refresh token required' });
    }

    const decoded = jwt.verify(token, config.jwt.secret)${ts ? ' as { id: string }' : ''};
    const tokens = generateTokens(decoded.id);

    return reply.send({ success: true, ...tokens });
  } catch {
    return reply.code(401).send({ success: false, message: 'Invalid refresh token' });
  }
}

/**
 * Forgot password
 */
export async function forgotPassword(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const { email } = request.body${ts ? ' as any' : ''};
    const user = await userRepository.findByEmail(email);

    if (user) {
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const expires = new Date(Date.now() + 3600000); // 1 hour
      await userRepository.setResetToken(user._id, token, expires);
      // TODO: Send email with reset link
      request.log.info(\`Password reset token for \${email}: \${token}\`);
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
export async function resetPassword(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const { token, newPassword } = request.body${ts ? ' as any' : ''};
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
export async function getUserProfile(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const userId = (request${ts ? ' as any' : ''}).user?._id || (request${ts ? ' as any' : ''}).user?.id;
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
export async function updateUserProfile(request${ts ? ': FastifyRequest' : ''}, reply${ts ? ': FastifyReply' : ''}) {
  try {
    const userId = (request${ts ? ' as any' : ''}).user?._id || (request${ts ? ' as any' : ''}).user?.id;
    const updates = { ...request.body${ts ? ' as any' : ''} };

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

function authSchemasTemplate(config: ProjectConfig): string {
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
`;
}

function authTestTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Auth Tests
 * Generated by Arc CLI
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
${config.adapter === 'mongokit' ? "import mongoose from 'mongoose';\n" : ''}import { createAppInstance } from '../src/app.js';
${ts ? "import type { FastifyInstance } from 'fastify';\n" : ''}
describe('Auth', () => {
  let app${ts ? ': FastifyInstance' : ''};
  const testUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
  };

  beforeAll(async () => {
${config.adapter === 'mongokit' ? `    const testDbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/${config.name}-test';
    await mongoose.connect(testDbUri);
    // Clean up test data
    await mongoose.connection.collection('users').deleteMany({ email: testUser.email });
` : ''}
    app = await createAppInstance();
    await app.ready();
  });

  afterAll(async () => {
${config.adapter === 'mongokit' ? `    await mongoose.connection.collection('users').deleteMany({ email: testUser.email });
    await mongoose.connection.close();
` : ''}    await app.close();
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
  const installStep = skipInstall ? `  npm install\n` : '';

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    ✅ Project Created!                        ║
╚═══════════════════════════════════════════════════════════════╝

Next steps:

  cd ${config.name}
${installStep}  npm run dev         # Uses .env.dev automatically

API Documentation:

  http://localhost:8040/docs           # Scalar UI
  http://localhost:8040/_docs/openapi.json  # OpenAPI spec

Run tests:

  npm test            # Run once
  npm run test:watch  # Watch mode

Add resources:

  1. Create folder: src/resources/product/
  2. Add: index.${config.typescript ? 'ts' : 'js'}, model.${config.typescript ? 'ts' : 'js'}, repository.${config.typescript ? 'ts' : 'js'}
  3. Register in src/resources/index.${config.typescript ? 'ts' : 'js'}

Project structure:

  src/
  ├── app.${config.typescript ? 'ts' : 'js'}        # App factory (for workers/tests)
  ├── index.${config.typescript ? 'ts' : 'js'}      # Server entry
  ├── config/       # Configuration
  ├── shared/       # Adapters, presets, permissions
  ├── plugins/      # App plugins (DI pattern)
  └── resources/    # API resources

Documentation:
  https://github.com/classytic/arc
`);
}

export default init;
