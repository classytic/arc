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
  const imports: Record<string, string> = config.typescript
    ? {
        "#config/*": "./dist/config/*",
        "#shared/*": "./dist/shared/*",
        "#resources/*": "./dist/resources/*",
        "#plugins/*": "./dist/plugins/*",
        "#services/*": "./dist/services/*",
        "#lib/*": "./dist/lib/*",
        "#utils/*": "./dist/utils/*",
      }
    : {
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

export function gitignoreTemplate(): string {
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
