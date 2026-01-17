#!/usr/bin/env node

/**
 * Arc CLI - Smart Backend Framework
 *
 * Commands:
 *   arc generate resource <name> [options]   Generate a new resource
 *   arc generate controller <name>           Generate a controller only
 *   arc generate model <name>                Generate a model only
 *   arc introspect                           Show all registered resources
 *   arc docs [output-path]                   Export OpenAPI specification
 *
 * Examples:
 *   arc generate resource product --module catalog
 *   arc generate resource invoice --presets softDelete,multiTenant
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
        console.error(`❌ Unknown command: ${command}`);
        console.error('Run "arc --help" for usage');
        process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleGenerate(type, args) {
  if (!type) {
    console.error('❌ Missing type argument');
    console.log('\nUsage: arc generate <resource|controller|model> <name> [options]');
    console.log('\nExamples:');
    console.log('  arc generate resource product --module catalog');
    console.log('  arc g r invoice --presets softDelete,multiTenant');
    process.exit(1);
  }

  // Normalize type shortcuts
  const typeMap = {
    r: 'resource',
    c: 'controller',
    m: 'model',
    resource: 'resource',
    controller: 'controller',
    model: 'model',
  };

  const normalizedType = typeMap[type.toLowerCase()];
  if (!normalizedType) {
    console.error(`❌ Unknown type: ${type}`);
    console.log('Available types: resource (r), controller (c), model (m)');
    process.exit(1);
  }

  const name = args[0];
  if (!name) {
    console.error('❌ Missing name argument');
    console.log(`\nUsage: arc generate ${normalizedType} <name> [options]`);
    process.exit(1);
  }

  const options = parseGenerateOptions(args.slice(1));

  // Import and run
  const { generate } = await import('../dist/cli/index.js');
  await generate(normalizedType, name, options);
}

async function handleIntrospect(args) {
  // Check for --entry flag
  const entryIndex = args.findIndex(arg => arg === '--entry' || arg === '-e');
  if (entryIndex !== -1 && args[entryIndex + 1]) {
    const entryPath = args[entryIndex + 1];
    // Resolve path relative to CWD and convert to file URL for ESM import
    const absolutePath = resolve(process.cwd(), entryPath);
    const fileUrl = pathToFileURL(absolutePath).href;

    console.log(`📦 Loading resources from: ${entryPath}\n`);
    try {
      await import(fileUrl);
    } catch (err) {
      console.error(`❌ Failed to load entry file: ${err.message}`);
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

    console.log(`📦 Loading resources from: ${entryPath}\n`);
    try {
      await import(fileUrl);
    } catch (err) {
      console.error(`❌ Failed to load entry file: ${err.message}`);
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

function parseGenerateOptions(args) {
  const opts = {
    module: undefined,
    presets: [],
    parentField: 'parent',
    withTests: true,
    dryRun: false,
    force: false,
    typescript: true, // Default to TypeScript
    outputDir: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--module':
      case '-m':
        opts.module = next;
        i++;
        break;

      case '--presets':
      case '-p':
        opts.presets = next?.split(',').map((p) => p.trim()).filter(Boolean) || [];
        i++;
        break;

      case '--parent-field':
        opts.parentField = next;
        i++;
        break;

      case '--output':
      case '-o':
        opts.outputDir = next;
        i++;
        break;

      case '--no-tests':
        opts.withTests = false;
        break;

      case '--dry-run':
        opts.dryRun = true;
        break;

      case '--force':
      case '-f':
        opts.force = true;
        break;

      case '--js':
      case '--javascript':
        opts.typescript = false;
        break;

      case '--ts':
      case '--typescript':
        opts.typescript = true;
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
╔═══════════════════════════════════════════════════════════════╗
║                    🔥 Arc CLI v${VERSION}                         ║
║         Resource-Oriented Backend Framework                   ║
╚═══════════════════════════════════════════════════════════════╝

USAGE
  arc <command> [options]

COMMANDS
  generate, g     Generate resources, controllers, or models
  introspect, i   Show all registered resources
  docs, d         Export OpenAPI specification

GLOBAL OPTIONS
  --entry, -e <path>       Entry file to load before running command
                           (loads resources into registry for introspect/docs)
  --version, -v            Show version
  --help, -h               Show this help

GENERATE SUBCOMMANDS
  resource, r     Generate full resource (model, repo, controller, routes)
  controller, c   Generate controller only
  model, m        Generate model only

GENERATE OPTIONS
  --module, -m <name>      Parent module (e.g., catalog, sales)
  --presets, -p <list>     Comma-separated presets:
                           • softDelete   - Soft delete with restore
                           • slugLookup   - GET by slug endpoint
                           • ownedByUser  - User ownership checks
                           • multiTenant  - Organization scoping
                           • tree         - Hierarchical data support
                           • audited      - Audit logging
  --parent-field <name>    Custom parent field for tree preset
  --output, -o <path>      Output directory (default: cwd)
  --no-tests               Skip test file generation
  --dry-run                Preview without creating files
  --force, -f              Overwrite existing files
  --js, --javascript       Generate JavaScript (default: TypeScript)

EXAMPLES
  # Generate a product resource in catalog module
  arc generate resource product --module catalog

  # Generate with presets (shorthand)
  arc g r invoice -m finance -p softDelete,multiTenant

  # Generate controller only
  arc g controller auth

  # Preview what would be generated
  arc g r order --dry-run

  # Export OpenAPI spec (load resources first)
  arc docs ./docs/openapi.json --entry ./index.js

  # Show registered resources (load resources first)
  arc introspect --entry ./index.js

  # Quick introspect (if resources already loaded)
  arc introspect

PRESETS EXPLAINED
  softDelete     Adds: deletedAt field, GET /deleted, POST /:id/restore
  slugLookup     Adds: slug field, GET /slug/:slug endpoint
  ownedByUser    Adds: createdBy field, ownership validation
  multiTenant    Adds: organizationId field, org scoping middleware
  tree           Adds: parent field, GET /tree, GET /:id/children
  audited        Adds: audit log entries for all mutations

MORE INFO
  Documentation: https://github.com/classytic/arc
  Issues: https://github.com/classytic/arc/issues
`);
}

// Run
main();
