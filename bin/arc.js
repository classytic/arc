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
 *   arc docs [output-path]            Export OpenAPI specification
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
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

      case 'docs':
      case 'd':
        await handleDocs(subcommand ? [subcommand, ...rest] : rest);
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
  const { init } = await import('../dist/cli/commands/init.js');
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
  const { generate } = await import('../dist/cli/commands/generate.js');
  await generate(normalizedType, args);
}

async function handleIntrospect(args) {
  // Check for --entry flag
  const entryIndex = args.findIndex(arg => arg === '--entry' || arg === '-e');
  if (entryIndex !== -1 && args[entryIndex + 1]) {
    const entryPath = args[entryIndex + 1];
    // Resolve path relative to CWD and convert to file URL for ESM import
    const absolutePath = resolve(process.cwd(), entryPath);
    const fileUrl = pathToFileURL(absolutePath).href;

    console.log(`Loading resources from: ${entryPath}\n`);
    try {
      await import(fileUrl);
    } catch (err) {
      console.error(`Failed to load entry file: ${err.message}`);
      if (process.env.DEBUG) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  }

  const { introspect } = await import('../dist/cli/commands/introspect.js');
  await introspect(args.filter((arg, i) => arg !== '--entry' && arg !== '-e' && i !== entryIndex + 1));
}

async function handleDocs(args) {
  // Check for --entry flag
  const entryIndex = args.findIndex(arg => arg === '--entry' || arg === '-e');
  if (entryIndex !== -1 && args[entryIndex + 1]) {
    const entryPath = args[entryIndex + 1];
    // Resolve path relative to CWD and convert to file URL for ESM import
    const absolutePath = resolve(process.cwd(), entryPath);
    const fileUrl = pathToFileURL(absolutePath).href;

    console.log(`Loading resources from: ${entryPath}\n`);
    try {
      await import(fileUrl);
    } catch (err) {
      console.error(`Failed to load entry file: ${err.message}`);
      if (process.env.DEBUG) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  }

  const filteredArgs = args.filter((arg, i) => arg !== '--entry' && arg !== '-e' && i !== entryIndex + 1);
  const outputPath = filteredArgs[0] || './openapi.json';
  const { exportDocs } = await import('../dist/cli/commands/docs.js');
  await exportDocs([outputPath]);
}

// ============================================================================
// Option Parsing
// ============================================================================

function parseInitOptions(args) {
  const opts = {
    name: undefined,
    adapter: undefined,
    tenant: undefined,
    typescript: undefined,
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
  docs, d         Export OpenAPI specification

GLOBAL OPTIONS
  --entry, -e <path>       Entry file to load before running command
                           (loads resources into registry for introspect/docs)
  --version, -v            Show version
  --help, -h               Show this help

INIT OPTIONS
  --mongokit               Use MongoKit adapter (default, recommended)
  --custom                 Use custom adapter (empty template)
  --multi-tenant, --multi  Multi-tenant mode (adds org scoping)
  --single-tenant, --single Single-tenant mode (default)
  --ts, --typescript       Generate TypeScript (default)
  --js, --javascript       Generate JavaScript
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
  arc init my-api --mongokit --single --ts

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

MORE INFO
  Documentation: https://github.com/classytic/arc
  Issues: https://github.com/classytic/arc/issues
`);
}

// Run
main();
