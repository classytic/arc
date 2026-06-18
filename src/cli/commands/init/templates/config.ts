/**
 * Project-level config templates — package.json, tsconfig, vitest, gitignore,
 * env files, README, runtime config module.
 *
 * Every function here is pure: takes a `ProjectConfig` and returns a file
 * body. No I/O, no side effects — so each template is unit-testable in
 * isolation by the CLI verification suite.
 */

import { resolveScaffoldDependencies } from "../dependency-plan.js";
import type { ProjectConfig } from "../types.js";

export function packageJsonTemplate(config: ProjectConfig): string {
  // Dependencies declared up-front so `npm install` works without the
  // CLI's `installDependencies` pre-pass — fixes the blocker where a
  // user could `--skip-install` (or run `npm install` manually) and
  // get a package.json with zero deps. See `resolveScaffoldDependencies`.
  const { dependencies, devDependencies } = resolveScaffoldDependencies(config);

  // Quality scripts shared across every variant. `typecheck` is TS-only.
  const qualityScripts: Record<string, string> = {
    lint: "biome check src/",
    format: "biome check --write src/",
    ...(config.typescript ? { typecheck: "tsc --noEmit" } : {}),
    test: "vitest run",
    "test:watch": "vitest",
  };

  const runScripts: Record<string, string> = config.typescript
    ? config.edge
      ? {
          dev: "tsx watch src/index.ts",
          build: "tsc",
          start: "node dist/index.js",
          deploy: "wrangler deploy",
          "deploy:dev": "wrangler dev",
        }
      : {
          dev: "tsx watch src/index.ts",
          build: "tsc",
          start: "node dist/index.js",
        }
    : config.edge
      ? {
          dev: "node --watch src/index.js",
          start: "node src/index.js",
          deploy: "wrangler deploy",
          "deploy:dev": "wrangler dev",
        }
      : {
          dev: "node --watch src/index.js",
          start: "node src/index.js",
        };

  const scripts: Record<string, string> = { ...runScripts, ...qualityScripts };

  // Subpath imports — point at the COMPILED output so production
  // (`node dist/index.js`) can resolve `#alias/*.js` correctly.
  //
  // Why dist/ and not src/: `tsc` is a transpiler, not a rewriter — the
  // compiled `dist/index.js` keeps every `import '#config/env.js'` line
  // byte-for-byte. At runtime Node walks `package.json#imports` to find
  // the real file. If that map points at `./src/*`, prod tries to load
  // `.ts` files Node can't run and crashes with `ERR_MODULE_NOT_FOUND`.
  //
  // Dev still works because `tsx` reads `tsconfig.json#paths` (which we
  // emit pointing at `./src/*`) BEFORE falling back to package.json
  // imports. Vitest takes the `resolve.alias` route from `vitest.config`.
  // So both runtimes resolve correctly:
  //   tsx watch src/index.ts  → tsconfig paths   → ./src/*
  //   node dist/index.js      → package imports  → ./dist/*
  //   vitest                  → vite resolve.alias → ./src/*
  // One alias per scaffolded dir — kept in lock step with tsconfig#paths
  // and vitest#resolve.alias. Add a line here (and in those two) when you
  // introduce a new top-level dir like `src/services`.
  const imports: Record<string, string> = config.typescript
    ? {
        "#config/*": "./dist/config/*",
        "#shared/*": "./dist/shared/*",
        "#resources/*": "./dist/resources/*",
        "#plugins/*": "./dist/plugins/*",
      }
    : {
        "#config/*": "./src/config/*",
        "#shared/*": "./src/shared/*",
        "#resources/*": "./src/resources/*",
        "#plugins/*": "./src/plugins/*",
      };

  return JSON.stringify(
    {
      name: config.name,
      version: "1.0.0",
      type: "module",
      main: config.typescript ? "dist/index.js" : "src/index.js",
      imports,
      scripts,
      dependencies,
      devDependencies,
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

export function tsconfigTemplate(): string {
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

export function vitestConfigTemplate(config: ProjectConfig): string {
  const srcDir = config.typescript ? "./src" : "./src";

  return `import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

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

export function gitignoreTemplate(): string {
  return `# Dependencies
node_modules/

# Build
dist/
*.js.map
*.tsbuildinfo

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

/**
 * Biome config — formatter + linter in one. Mirrors arc's own defaults
 * (2-space indent, double quotes, organize-imports on) so generated code
 * and the framework share a house style. `npm run lint` / `npm run format`.
 */
export function biomeTemplate(): string {
  return `${JSON.stringify(
    {
      $schema: "https://biomejs.dev/schemas/2.4.15/schema.json",
      vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
      files: { ignoreUnknown: true },
      formatter: { enabled: true, indentStyle: "space", indentWidth: 2, lineWidth: 100 },
      assist: { actions: { source: { organizeImports: "on" } } },
      linter: { enabled: true, rules: { recommended: true } },
      javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
    },
    null,
    2,
  )}\n`;
}

/**
 * GitHub Actions CI — install, typecheck, lint, test on push + PR.
 * The quality gate every team re-adds by hand; ship it wired.
 */
export function ciWorkflowTemplate(config: ProjectConfig): string {
  const typecheckStep = config.typescript
    ? `      - name: Typecheck
        run: npm run typecheck
`
    : "";

  return `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install
        run: npm ci
${typecheckStep}      - name: Lint
        run: npm run lint
      - name: Test
        run: npm test
`;
}

export function envExampleTemplate(config: ProjectConfig): string {
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

export function envDevTemplate(config: ProjectConfig): string {
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

export function readmeTemplate(config: ProjectConfig): string {
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

- **Interactive UI**: [http://localhost:8040/docs](http://localhost:8040/data)
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

export function configTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const isBetterAuth = config.auth === "better-auth";
  const isMongo = config.adapter === "mongokit";
  const isMulti = config.tenant === "multi";

  // ── Zod env schema fields (conditional on the chosen presets) ──
  const authSchemaFields = isBetterAuth
    ? `  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters')
    .default('dev-secret-change-in-production-min-32-chars'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),`
    : `  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .default('dev-secret-change-in-production-min-32'),
  JWT_EXPIRES_IN: z.string().default('7d'),`;

  const dbSchemaField = isMongo
    ? `\n  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/${config.name}'),`
    : "";

  const orgSchemaField = isMulti ? `\n  ORG_HEADER: z.string().default('x-organization-id'),` : "";

  // Production must never boot on the bundled dev secret.
  const secretVar = isBetterAuth ? "BETTER_AUTH_SECRET" : "JWT_SECRET";
  const prodGuard = `  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.${secretVar}.startsWith('dev-secret')) {
      ctx.addIssue({
        code: 'custom',
        path: ['${secretVar}'],
        message:
          'Set a strong ${secretVar} in production — the bundled dev default is not allowed.',
      });
    }
  })`;

  // ── AppConfig interface (TS only) ──
  const authTypeBlock = isBetterAuth
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

  const typeDefinition = ts
    ? `
export interface AppConfig {
  env: 'development' | 'production' | 'test';
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
    isMongo
      ? `
  database: {
    uri: string;
  };`
      : ""
  }${
    isMulti
      ? `
  org: {
    header: string;
  };`
      : ""
  }
}
`
    : "";

  // ── config object built from the VALIDATED env ──
  const authConfigBlock = isBetterAuth
    ? `
  betterAuth: {
    secret: env.BETTER_AUTH_SECRET,
  },

  frontend: {
    url: env.FRONTEND_URL,
  },`
    : `
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },`;

  const dbConfigBlock = isMongo
    ? `
  database: {
    uri: env.MONGODB_URI,
  },
`
    : "";

  const orgConfigBlock = isMulti
    ? `
  org: {
    header: env.ORG_HEADER,
  },
`
    : "";

  return `/**
 * Application Configuration
 *
 * Environment variables are validated with Zod at startup. A missing or
 * malformed var fails fast here with a clear message — instead of surfacing
 * as a confusing runtime error on the first request. ENV files are loaded
 * by config/env.${ts ? "ts" : "js"} (imported first in the entry points).
 */

import { z } from 'zod';

// Normalize NODE_ENV to the three canonical values the rest of the app
// reasons about (matches the env loader's prod/dev/test aliasing).
const NodeEnv = z.preprocess((v) => {
  const s = String(v ?? '').toLowerCase();
  if (s === 'prod' || s === 'production') return 'production';
  if (s === 'test' || s === 'qa') return 'test';
  return 'development';
}, z.enum(['development', 'production', 'test']));

const EnvSchema = z
  .object({
    NODE_ENV: NodeEnv,
    PORT: z.coerce.number().int().positive().default(8040),
    HOST: z.string().min(1).default('0.0.0.0'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
${authSchemaFields}${dbSchemaField}${orgSchemaField}
  })
${prodGuard};

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues
    .map((i) => \`  - \${i.path.join('.') || '(root)'}: \${i.message}\`)
    .join('\\n');
  console.error(\`Invalid environment configuration:\\n\${lines}\`);
  process.exit(1);
}

const env = parsed.data;
${typeDefinition}
const config${ts ? ": AppConfig" : ""} = {
  env: env.NODE_ENV,
  isDev: env.NODE_ENV !== 'production',
  isProd: env.NODE_ENV === 'production',

  server: {
    port: env.PORT,
    host: env.HOST,
  },
${authConfigBlock}

  cors: {
    // '*' = allow all origins (true), otherwise comma-separated list
    origins: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(','),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-organization-id', 'x-request-id'],
    credentials: true,
  },
${dbConfigBlock}${orgConfigBlock}};

export default config;
`;
}
