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

// Version / help are GLOBAL only in the leading position. Scanning the whole
// argv made `arc init --help` print the global help and exit, which left the
// per-command usage in COMMAND_HELP unreachable — a user asking how to use
// one command got the manual for all of them.
const leading = args[0];

// ============================================================================
// Command Routing
// ============================================================================

const [command, subcommand, ...rest] = args;

// Per-command usage — `arc <command> --help` prints this instead of falling
// through to the command (where `--help` was mistaken for an argument).
const COMMAND_ALIASES = { new: 'init', g: 'generate', i: 'introspect', desc: 'describe', d: 'docs' };
const COMMAND_HELP = {
  init: 'Usage: arc init [name] [--jwt|--better-auth] [--mongokit|--custom] [--api-key|--no-api-key] [--session cookie|bearer|both]\n            [--multi|--single] [--js] [--edge] [--docker|--no-docker] [--skip-install] [--force]\n  Scaffold a new arc project (prompts when run in a TTY without a name).',
  generate: 'Usage: arc generate <resource|controller|model|repository|schemas|mcp> <name> [--mcp]\n  Aliases: g; types r/c/m/repo/s. Name must be kebab-case (letters, digits, hyphens).',
  introspect: 'Usage: arc introspect <entry-file>\n  Print a human-readable summary of the resources an entry file exports.',
  describe: 'Usage: arc describe <entry-file> [--json] [--pretty] [--entry <file>]\n  Describe resources; --json emits machine output for AI agents.',
  docs: 'Usage: arc docs <entry-file> [output.json] [--entry <file>]\n  Export the generated OpenAPI document.',
  doctor: 'Usage: arc doctor\n  Diagnose common arc setup issues (exit 1 on hard failures).',
};

/**
 * `process.exitCode` + return, never `process.exit()`.
 *
 * `process.exit()` tears the process down immediately; on POSIX a `stdout`
 * that is a PIPE (`arc --help | less`, `arc describe --json > out.json`)
 * writes asynchronously, so an exit racing the flush TRUNCATES output. Arc's
 * own `doctor` already sets `exitCode`; this file is the one that did not.
 * Setting the code and returning lets Node drain stdout and exit on its own.
 */
async function main() {
  try {
    // Global help/version are the LEADING argument only — see `leading`.
    if (leading === '--version' || leading === '-v') {
      console.log(`Arc CLI v${VERSION}`);
      return;
    }
    if (args.length === 0 || leading === '--help' || leading === '-h') {
      printHelp();
      return;
    }

    // `arc <command> --help` / `-h` → command-specific usage, exit 0.
    const canonicalCommand = COMMAND_ALIASES[command] ?? command;
    if (
      COMMAND_HELP[canonicalCommand] &&
      [subcommand, ...rest].some((a) => a === '--help' || a === '-h')
    ) {
      console.log(COMMAND_HELP[canonicalCommand]);
      return;
    }

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
        process.exitCode = 1;
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    if (process.env.DEBUG) {
      console.error(err instanceof Error ? err.stack : err);
    }
    process.exitCode = 1;
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
    console.log('\nUsage: arc generate <resource|controller|model|repository|schemas|mcp> <name>');
    console.log('\nExamples:');
    console.log('  arc generate resource product');
    console.log('  arc generate resource product --mcp');
    console.log('  arc generate mcp product');
    console.log('  arc g r invoice');
    process.exitCode = 1;
    return;
  }

  // Normalize type shortcuts
  const typeMap = {
    r: 'resource',
    c: 'controller',
    m: 'model',
    repo: 'repository',
    s: 'schemas',
    mcp: 'mcp',
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
    process.exitCode = 1;
    return;
  }

  const name = args[0];
  if (!name) {
    console.error('Missing name argument');
    console.log(`\nUsage: arc generate ${normalizedType} <name>`);
    process.exitCode = 1;
    return;
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
    auth: undefined,
    tenant: undefined,
    // Better Auth-specific. `undefined` (not a default) is load-bearing:
    // options.ts prompts ONLY when the field is undefined, so defaulting
    // here would silently skip the interactive question.
    apiKey: undefined,
    session: undefined,
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

      case '--api-key':
        opts.apiKey = true;
        break;

      case '--no-api-key':
        opts.apiKey = false;
        break;

      case '--session':
        // cookie | bearer | both — options.ts falls back to the documented
        // default for anything else.
        opts.session = next;
        i++;
        break;

      case '--edge':
      case '--serverless':
        opts.edge = true;
        break;

      case '--docker':
        // 2.16 — Docker scaffolding is opt-in (frameworks don't dictate
        // deployment). `--no-docker` skips even the interactive prompt.
        opts.docker = true;
        break;

      case '--no-docker':
        opts.docker = false;
        break;

      case '--skip-install':
        opts.skipInstall = true;
        break;

      case '--force':
      case '-f':
        opts.force = true;
        break;

      case '--help':
      case '-h':
        // Handled by the per-command help short-circuit in main(); ignore here.
        break;

      default:
        // Surface typos instead of silently scaffolding with defaults — a
        // dropped `--jwt` / `--mongokit` would change the whole project. Warn
        // (non-fatal, to stderr) rather than error, since a scaffolder should
        // stay forgiving.
        if (arg.startsWith('-')) {
          console.error(`Warning: unknown flag "${arg}" (ignored). Run "arc init --help".`);
        }
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
  --name, -n <name>        Project name (alternative to the positional argument)
  --mongokit               Use MongoKit adapter (default, recommended)
  --custom                 Use custom / Drizzle-ready adapter template
  --better-auth            Use Better Auth (default, recommended)
  --jwt                    Use Arc built-in JWT auth
  --multi-tenant, --multi  Multi-tenant mode (adds org scoping)
  --single-tenant, --single Single-tenant mode (default)
  --ts, --typescript       Generate TypeScript (default)
  --js, --javascript       Generate JavaScript
  --api-key                Enable Better Auth's apiKey plugin (machine-to-machine)
  --no-api-key             Skip it without being prompted
  --session <mode>         Better Auth session strategy: cookie | bearer | both
  --edge, --serverless     Target Edge/Serverless environments
  --docker                 Emit Dockerfile + docker-compose.yml (opt-in, 2.16)
  --no-docker              Skip Docker scaffolding even in interactive mode
  --force, -f              Overwrite existing directory
  --skip-install           Skip npm install after scaffolding

GENERATE SUBCOMMANDS
  resource, r       Generate resource-first scaffold (model, repo, resource, test)
  controller, c     Generate controller only
  model, m          Generate model only
  repository, repo  Generate repository only
  schemas, s        Generate schemas only
  mcp               Generate MCP tools file only

GENERATE NOTES
  - Auto-detects TypeScript/JavaScript from tsconfig.json
  - Files are created in src/resources/<name>/ directory
  - Uses prefixed filenames: <name>.model.ts, <name>.repository.ts, etc.
  - Use --mcp flag with resource to include MCP tools file: arc g r product --mcp
  - Set "mcp": true in .arcrc to always generate MCP tools

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
