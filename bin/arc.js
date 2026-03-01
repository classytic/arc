#!/usr/bin/env node

/**
 * Arc CLI - Smart Backend Framework
 *
 * Commands:
 *   arc init [name]                   Initialize a new Arc project
 *   arc generate resource <name>      Generate a new resource
 *   arc generate controller <name>    Generate a controller only
 *   arc generate model <name>         Generate a model only
 *   arc introspect                    Show all registered resources
 *   arc describe <entry-file>        Output JSON metadata for AI agents
 *   arc docs [output-path]            Export OpenAPI specification
 *   arc doctor                        Check environment and dependencies
 *
 * Examples:
 *   arc init my-api
 *   arc init my-api --mongokit --single --ts
 *   arc generate resource product
 *   arc g r invoice
 *   arc introspect
 *   arc docs ./openapi.json
 */

import { readFileSync } from 'node:fs';

function getPackageVersion() {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = getPackageVersion();

// ============================================================================
// Argument Parsing
// ============================================================================

const args = process.argv.slice(2);

// Version flag
if (args.includes('--version') || args.includes('-v')) {
  console.log(`Arc CLI v${VERSION}`);
  process.exit(0);
}

// Help flag or no args
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

// ============================================================================
// Command Routing
// ============================================================================

const [command, subcommand, ...rest] = args;

async function main() {
  try {
    switch (command) {
      case 'init':
      case 'new':
        await handleInit(subcommand ? [subcommand, ...rest] : rest);
        break;

      case 'generate':
      case 'g':
        await handleGenerate(subcommand, rest);
        break;

      case 'introspect':
      case 'i':
        await handleIntrospect(rest);
        break;

      case 'describe':
      case 'desc':
        await handleDescribe(subcommand ? [subcommand, ...rest] : rest);
        break;

      case 'docs':
      case 'd':
        await handleDocs(subcommand ? [subcommand, ...rest] : rest);
        break;

      case 'doctor':
        await handleDoctor(subcommand ? [subcommand, ...rest] : rest);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "arc --help" for usage');
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleInit(args) {
  const options = parseInitOptions(args);
  const { init } = await import('../dist/cli/commands/init.mjs');
  await init(options);
}

async function handleGenerate(type, args) {
  if (!type) {
    console.error('Missing type argument');
    console.log('\nUsage: arc generate <resource|controller|model|repository|schemas> <name>');
    console.log('\nExamples:');
    console.log('  arc generate resource product');
    console.log('  arc g r invoice');
    process.exit(1);
  }

  // Normalize type shortcuts
  const typeMap = {
    r: 'resource',
    c: 'controller',
    m: 'model',
    repo: 'repository',
    s: 'schemas',
    resource: 'resource',
    controller: 'controller',
    model: 'model',
    repository: 'repository',
    schemas: 'schemas',
  };

  const normalizedType = typeMap[type.toLowerCase()];
  if (!normalizedType) {
    console.error(`Unknown type: ${type}`);
    console.log('Available types: resource (r), controller (c), model (m), repository (repo), schemas (s)');
    process.exit(1);
  }

  const name = args[0];
  if (!name) {
    console.error('Missing name argument');
    console.log(`\nUsage: arc generate ${normalizedType} <name>`);
    process.exit(1);
  }

  // Import and run
  const { generate } = await import('../dist/cli/commands/generate.mjs');
  await generate(normalizedType, args);
}

async function handleIntrospect(rawArgs) {
  const args = normalizeArgs(rawArgs);
  const { entryPath, filteredArgs } = extractEntryArg(args);

  const { introspect } = await import('../dist/cli/commands/introspect.mjs');
  await introspect(entryPath ? [entryPath, ...filteredArgs] : filteredArgs);
}

async function handleDescribe(rawArgs) {
  const args = normalizeArgs(rawArgs);
  const { describe } = await import('../dist/cli/commands/describe.mjs');
  await describe(args);
}

async function handleDocs(rawArgs) {
  const args = normalizeArgs(rawArgs);
  const { entryPath, filteredArgs } = extractEntryArg(args);
  const { exportDocs } = await import('../dist/cli/commands/docs.mjs');
  await exportDocs(entryPath ? [entryPath, ...filteredArgs] : filteredArgs);
}

async function handleDoctor(rawArgs) {
  const { doctor } = await import('../dist/cli/commands/doctor.mjs');
  await doctor(rawArgs);
}

// ============================================================================
// Option Parsing
// ============================================================================

// Mirrors src/cli/utils/normalizeArgs.ts — keep in sync
// (bin/arc.js is unbundled, can't import tree-shaken dist internals)
function normalizeArgs(raw) {
  const out = [];
  for (const arg of raw) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      out.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      out.push(arg);
    }
  }
  return out;
}

function extractEntryArg(args) {
  const entryIndex = args.findIndex(arg => arg === '--entry' || arg === '-e');
  const hasEntry = entryIndex !== -1 && !!args[entryIndex + 1];
  const entryPath = hasEntry ? args[entryIndex + 1] : undefined;
  const filteredArgs = hasEntry
    ? args.filter((arg, i) => i !== entryIndex && i !== entryIndex + 1)
    : args;

  return { entryPath, filteredArgs };
}

function parseInitOptions(rawArgs) {
  const args = normalizeArgs(rawArgs);

  const opts = {
    name: undefined,
    adapter: undefined,
    tenant: undefined,
    typescript: undefined,
    edge: undefined,
    skipInstall: false,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    // First non-flag argument is the project name
    if (!arg.startsWith('-') && !opts.name) {
      opts.name = arg;
      continue;
    }

    switch (arg) {
      case '--name':
      case '-n':
        opts.name = next;
        i++;
        break;

      case '--mongokit':
        opts.adapter = 'mongokit';
        break;

      case '--custom':
        opts.adapter = 'custom';
        break;

      case '--multi-tenant':
      case '--multi':
        opts.tenant = 'multi';
        break;

      case '--single-tenant':
      case '--single':
        opts.tenant = 'single';
        break;

      case '--ts':
      case '--typescript':
        opts.typescript = true;
        break;

      case '--js':
      case '--javascript':
        opts.typescript = false;
        break;

      case '--better-auth':
        opts.auth = 'better-auth';
        break;

      case '--jwt':
        opts.auth = 'jwt';
        break;

      case '--edge':
      case '--serverless':
        opts.edge = true;
        break;

      case '--skip-install':
        opts.skipInstall = true;
        break;

      case '--force':
      case '-f':
        opts.force = true;
        break;
    }
  }

  return opts;
}

// ============================================================================
// Help
// ============================================================================

function printHelp() {
  console.log(`
Arc CLI v${VERSION}
Resource-Oriented Backend Framework

USAGE
  arc <command> [options]

COMMANDS
  init, new       Initialize a new Arc project
  generate, g     Generate resources, controllers, or models
  introspect, i   Show all registered resources
  describe, desc  Output JSON metadata for AI agents
  docs, d         Export OpenAPI specification
  doctor          Check environment and dependencies

GLOBAL OPTIONS
  --entry, -e <path>       Entry file to load before running command
                           (loads resources into registry for introspect/docs)
  --version, -v            Show version
  --help, -h               Show this help

INIT OPTIONS
  --mongokit               Use MongoKit adapter (default, recommended)
  --custom                 Use custom adapter (empty template)
  --better-auth            Use Better Auth (default, recommended)
  --jwt                    Use Arc built-in JWT auth
  --multi-tenant, --multi  Multi-tenant mode (adds org scoping)
  --single-tenant, --single Single-tenant mode (default)
  --ts, --typescript       Generate TypeScript (default)
  --js, --javascript       Generate JavaScript
  --edge, --serverless     Target Edge/Serverless environments
  --force, -f              Overwrite existing directory
  --skip-install           Skip npm install after scaffolding

GENERATE SUBCOMMANDS
  resource, r       Generate full resource (model, repo, controller, schemas, resource)
  controller, c     Generate controller only
  model, m          Generate model only
  repository, repo  Generate repository only
  schemas, s        Generate schemas only

GENERATE NOTES
  - Auto-detects TypeScript/JavaScript from tsconfig.json
  - Files are created in src/resources/<name>/ directory
  - Uses prefixed filenames: <name>.model.ts, <name>.repository.ts, etc.

EXAMPLES
  # Initialize a new project (interactive prompts)
  arc init my-api

  # Initialize with all options (non-interactive)
  arc init my-api --mongokit --better-auth --single --ts

  # Initialize with JWT auth instead of Better Auth
  arc init my-api --mongokit --jwt --single --ts

  # Initialize a JavaScript single-tenant app
  arc init my-api --mongokit --single --js

  # Generate a product resource
  arc generate resource product

  # Shorthand for generating a resource
  arc g r invoice

  # Generate only a controller
  arc g controller auth

  # Generate only a model
  arc g model order

  # Export OpenAPI spec (load resources first)
  arc docs ./docs/openapi.json --entry ./dist/index.js

  # Show registered resources
  arc introspect --entry ./dist/index.js

  # Output JSON metadata for AI agents
  arc describe ./dist/resources.js --json

  # Describe a single resource
  arc describe ./dist/resources.js product

MORE INFO
  Documentation: https://github.com/classytic/arc
  Issues: https://github.com/classytic/arc/issues
`);
}

// Run
main();
