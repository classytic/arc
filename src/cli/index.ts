/**
 * CLI Module - Programmatic API
 *
 * @example
 * import { generate } from '@classytic/arc/cli';
 *
 * await generate('resource', 'product', {
 *   module: 'catalog',
 *   presets: ['softDelete', 'slugLookup'],
 * });
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface GenerateOptions {
  module?: string;
  presets?: string[];
  parentField?: string;
  withTests?: boolean;
  dryRun?: boolean;
  force?: boolean;
  outputDir?: string;
  /** Generate TypeScript (default: true) or JavaScript */
  typescript?: boolean;
}

export interface GeneratedFile {
  name: string;
  content: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  dirPath: string;
}

// ============================================================================
// Main Generate Function
// ============================================================================

/**
 * Generate resource files
 *
 * @param type - 'resource', 'controller', or 'model'
 * @param name - Resource name (e.g., 'product', 'order-item')
 * @param options - Generation options
 */
export async function generate(
  type: string,
  name: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const validTypes = ['resource', 'controller', 'model'];
  if (!validTypes.includes(type)) {
    throw new Error(`Unknown generation type: ${type}. Valid types: ${validTypes.join(', ')}`);
  }

  const {
    module: moduleName,
    presets = [],
    parentField = 'parent',
    withTests = true,
    dryRun = false,
    force = false,
    outputDir = process.cwd(),
    typescript = true,
  } = options;

  // Security: Validate resource name to prevent path traversal
  const SAFE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;
  if (!SAFE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid resource name: "${name}". Use only letters, numbers, and hyphens (must start with letter).`);
  }

  // Security: Validate module name to prevent path traversal
  if (moduleName && !SAFE_NAME_PATTERN.test(moduleName)) {
    throw new Error(`Invalid module name: "${moduleName}". Use only letters, numbers, and hyphens (must start with letter).`);
  }

  const ext = typescript ? 'ts' : 'js';
  const kebab = kebabCase(name);
  const dirPath = moduleName
    ? path.join(outputDir, 'modules', moduleName, kebab)
    : path.join(outputDir, 'modules', kebab);

  // Generate files based on type
  let files: GeneratedFile[];

  switch (type) {
    case 'resource':
      files = generateResourceFiles(name, { presets, parentField, module: moduleName, withTests, typescript });
      break;
    case 'controller':
      files = [{ name: `${kebab}.controller.${ext}`, content: controllerTemplate(name, { presets, parentField, typescript }) }];
      break;
    case 'model':
      files = [{ name: `${kebab}.model.${ext}`, content: modelTemplate(name, { presets, parentField, typescript }) }];
      break;
    default:
      throw new Error(`Unknown type: ${type}`);
  }

  // Log generation info
  console.log(`\n📦 Generating ${type}: ${pascalCase(name)}`);
  console.log(`📁 Directory: ${dirPath}`);
  console.log(`🔧 Presets: ${presets.length ? presets.join(', ') : 'none'}`);
  console.log(`📝 Language: ${typescript ? 'TypeScript' : 'JavaScript'}`);

  if (dryRun) {
    console.log('\n🏃 DRY RUN - No files created\n');
    for (const file of files) {
      console.log(`  Would create: ${file.name}`);
    }
    return { files, dirPath };
  }

  // Create directory
  await fs.mkdir(dirPath, { recursive: true });

  // Write files
  let created = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(dirPath, file.name);

    try {
      await fs.access(filePath);
      if (!force) {
        console.log(`  ⏭️  Skipped: ${file.name} (exists)`);
        skipped++;
        continue;
      }
    } catch {
      // File doesn't exist - proceed
    }

    await fs.writeFile(filePath, file.content);
    console.log(`  ✅ Created: ${file.name}`);
    created++;
  }

  // Summary
  console.log(`\n🎉 Done! Created ${created} file(s), skipped ${skipped}\n`);

  // Next steps
  if (type === 'resource') {
    printNextSteps(name, moduleName);
  }

  return { files, dirPath };
}

// ============================================================================
// File Generation
// ============================================================================

interface TemplateOptions {
  presets: string[];
  parentField: string;
  module?: string;
  withTests: boolean;
  typescript: boolean;
}

function generateResourceFiles(name: string, options: TemplateOptions): GeneratedFile[] {
  const { presets, parentField, module: moduleName, withTests, typescript } = options;
  const kebab = kebabCase(name);
  const ext = typescript ? 'ts' : 'js';

  const files: GeneratedFile[] = [
    { name: `${kebab}.model.${ext}`, content: modelTemplate(name, { presets, parentField, typescript }) },
    { name: `${kebab}.repository.${ext}`, content: repositoryTemplate(name, { presets, parentField, typescript }) },
    { name: `${kebab}.controller.${ext}`, content: controllerTemplate(name, { presets, parentField, typescript }) },
    { name: `${kebab}.resource.${ext}`, content: resourceTemplate(name, { presets, parentField, module: moduleName, typescript }) },
    { name: `routes.${ext}`, content: routesTemplate(name, { typescript }) },
  ];

  if (withTests) {
    files.push({ name: `${kebab}.test.${ext}`, content: testTemplate(name, { presets, typescript }) });
  }

  return files;
}

// ============================================================================
// Templates
// ============================================================================

interface BaseTemplateOpts {
  presets: string[];
  parentField: string;
  typescript?: boolean;
}

function modelTemplate(name: string, opts: BaseTemplateOpts): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const { presets = [], parentField = 'parent', typescript = true } = opts;

  const hasSlug = presets.includes('slugLookup');
  const hasSoftDelete = presets.includes('softDelete');
  const hasTree = presets.includes('tree');
  const hasMultiTenant = presets.includes('multiTenant');
  const hasOwned = presets.includes('ownedByUser');
  const hasAudited = presets.includes('audited');

  const typeAnnotation = typescript ? `: mongoose.InferSchemaType<typeof ${camel}Schema>` : '';

  return `/**
 * ${pascal} Model
 * @generated by Arc CLI
 */

import mongoose from 'mongoose';
${hasSlug ? "import slugPlugin from '@classytic/mongoose-slug-plugin';\n" : ''}
const ${camel}Schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
${hasSlug ? '    slug: { type: String, unique: true, sparse: true, index: true },\n' : ''}${
    hasTree
      ? `    ${parentField}: { type: mongoose.Schema.Types.ObjectId, ref: '${pascal}', default: null, index: true },
    displayOrder: { type: Number, default: 0 },
`
      : ''
  }${
    hasMultiTenant
      ? "    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },\n"
      : ''
  }${
    hasOwned
      ? "    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },\n"
      : ''
  }    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
${hasSoftDelete ? '    deletedAt: { type: Date, default: null, index: true },\n' : ''}${
    hasAudited
      ? `    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
`
      : ''
  }  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
${camel}Schema.index({ name: 1 });
${hasSoftDelete ? `${camel}Schema.index({ deletedAt: 1, isActive: 1 });\n` : ''}${hasSlug ? `\n${camel}Schema.plugin(slugPlugin, { sourceField: 'name' });\n` : ''}
${typescript ? `export type ${pascal}Document = mongoose.InferSchemaType<typeof ${camel}Schema>;\n` : ''}
export const ${pascal} = mongoose.model${typescript ? `<${pascal}Document>` : ''}('${pascal}', ${camel}Schema);
export default ${pascal};
`;
}

function repositoryTemplate(name: string, opts: BaseTemplateOpts): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);
  const { presets = [], parentField = 'parent', typescript = true } = opts;

  const hasSoftDelete = presets.includes('softDelete');
  const hasSlug = presets.includes('slugLookup');
  const hasTree = presets.includes('tree');

  const typeImport = typescript ? `\nimport type { ${pascal}Document } from './${kebab}.model.js';` : '';
  const repoGeneric = typescript ? `<${pascal}Document>` : '';
  const returnType = (t: string) => (typescript ? `: Promise<${t}>` : '');

  return `/**
 * ${pascal} Repository
 * @generated by Arc CLI
 */

import { Repository${hasSoftDelete ? ', softDeletePlugin' : ''} } from '@classytic/mongokit';
import { ${pascal} } from './${kebab}.model.js';${typeImport}

class ${pascal}Repository extends Repository${repoGeneric} {
  constructor() {
    super(${pascal}${hasSoftDelete ? ', [softDeletePlugin()]' : ''});
  }

  /** Find all active records */
  async findActive()${returnType(`${pascal}Document[]`)} {
    return this.Model.find({ isActive: true${hasSoftDelete ? ', deletedAt: null' : ''} }).lean();
  }
${
  hasSlug
    ? `
  /** Find by slug */
  async getBySlug(slug${typescript ? ': string' : ''})${returnType(`${pascal}Document | null`)} {
    return this.Model.findOne({ slug: slug.toLowerCase()${hasSoftDelete ? ', deletedAt: null' : ''} }).lean();
  }
`
    : ''
}${
    hasSoftDelete
      ? `
  /** Get soft-deleted records */
  async getDeleted()${returnType(`${pascal}Document[]`)} {
    return this.Model.find({ deletedAt: { $ne: null } }).sort({ deletedAt: -1 }).lean();
  }

  /** Restore a soft-deleted record */
  async restore(id${typescript ? ': string' : ''})${returnType(`${pascal}Document | null`)} {
    return this.Model.findByIdAndUpdate(id, { deletedAt: null }, { new: true }).lean();
  }
`
      : ''
  }${
    hasTree
      ? `
  /** Get hierarchical tree structure */
  async getTree()${returnType(`${pascal}Document[]`)} {
    const all = await this.Model.find({ isActive: true${hasSoftDelete ? ', deletedAt: null' : ''} })
      .sort({ displayOrder: 1 })
      .lean();

    const map = new Map${typescript ? `<string, ${pascal}Document & { children: ${pascal}Document[] }>` : ''}();
    const roots${typescript ? `: (${pascal}Document & { children: ${pascal}Document[] })[]` : ''} = [];

    for (const item of all) {
      map.set(item._id.toString(), { ...item, children: [] });
    }

    for (const item of all) {
      const node = map.get(item._id.toString())!;
      const parentId = (item${typescript ? ' as any' : ''}).${parentField};
      if (parentId && map.has(parentId.toString())) {
        map.get(parentId.toString())!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /** Get direct children of a parent */
  async getChildren(parentId${typescript ? ': string' : ''})${returnType(`${pascal}Document[]`)} {
    return this.Model.find({
      ${parentField}: parentId,
      isActive: true${hasSoftDelete ? ',\n      deletedAt: null' : ''},
    }).sort({ displayOrder: 1 }).lean();
  }
`
      : ''
  }}

export const ${camel}Repository = new ${pascal}Repository();
export default ${camel}Repository;
`;
}

function controllerTemplate(name: string, opts: BaseTemplateOpts): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);
  const { presets = [], typescript = true } = opts;

  const hasSoftDelete = presets.includes('softDelete');
  const hasSlug = presets.includes('slugLookup');
  const hasTree = presets.includes('tree');

  return `/**
 * ${pascal} Controller
 * @generated by Arc CLI
 *
 * Extends BaseController for built-in security:
 * - Organization scoping (multi-tenant isolation)
 * - Ownership checks (user data protection)
 * - Policy-based filtering
 */

import { BaseController } from '@classytic/arc';
${typescript ? "import type { IRequestContext, IControllerResponse } from '@classytic/arc';\n" : ''}import { ${camel}Repository } from './${kebab}.repository.js';

class ${pascal}Controller extends BaseController {
  constructor() {
    super(${camel}Repository);

    // Bind methods (required for route handler context)
${hasSlug ? '    this.getBySlug = this.getBySlug.bind(this);\n' : ''}${
    hasSoftDelete
      ? `    this.getDeleted = this.getDeleted.bind(this);
    this.restore = this.restore.bind(this);
`
      : ''
  }${
    hasTree
      ? `    this.getTree = this.getTree.bind(this);
    this.getChildren = this.getChildren.bind(this);
`
      : ''
  }  }

  // ========================================
  // Custom Methods (add your own below)
  // ========================================

  // Example: Custom search endpoint
  // async search(ctx${typescript ? ': IRequestContext' : ''})${typescript ? ': Promise<IControllerResponse>' : ''} {
  //   const { query } = ctx.query${typescript ? ' as { query: string }' : ''};
  //   const results = await this.repository.Model.find({
  //     name: { $regex: query, $options: 'i' },
  //   }).lean();
  //   return { success: true, data: results, status: 200 };
  // }
}

export const ${camel}Controller = new ${pascal}Controller();
export default ${camel}Controller;
`;
}

function resourceTemplate(
  name: string,
  opts: BaseTemplateOpts & { module?: string; typescript?: boolean }
): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);
  const { presets = [], parentField = 'parent', module: moduleName, typescript = true } = opts;

  const presetsStr =
    presets.length > 0
      ? presets
          .map((p) => {
            if (p === 'tree' && parentField !== 'parent') {
              return `{ name: 'tree', parentField: '${parentField}' }`;
            }
            return `'${p}'`;
          })
          .join(',\n      ')
      : '';

  return `/**
 * ${pascal} Resource Definition
 * @generated by Arc CLI
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { ${pascal} } from './${kebab}.model.js';
import { ${camel}Repository } from './${kebab}.repository.js';

export default defineResource({
  name: '${kebab}',
  displayName: '${pascal}s',
${moduleName ? `  module: '${moduleName}',\n` : ''}
  adapter: createMongooseAdapter({
    model: ${pascal},
    repository: ${camel}Repository,
  }),
${presetsStr ? `\n  presets: [\n      ${presetsStr},\n    ],\n` : ''}
  permissions: {
    list: [],
    get: [],
    create: ['admin'],
    update: ['admin'],
    delete: ['admin'],
  },

  additionalRoutes: [],

  events: {
    created: { description: '${pascal} created' },
    updated: { description: '${pascal} updated' },
    deleted: { description: '${pascal} deleted' },
  },
});
`;
}

function routesTemplate(name: string, opts: { typescript?: boolean }): string {
  const camel = camelCase(name);
  const kebab = kebabCase(name);

  return `/**
 * ${pascalCase(name)} Routes
 * @generated by Arc CLI
 *
 * Register this plugin in your app:
 *   await fastify.register(${camel}Routes);
 */

import ${camel}Resource from './${kebab}.resource.js';

export default ${camel}Resource.toPlugin();
`;
}

function testTemplate(name: string, opts: { presets: string[]; typescript?: boolean }): string {
  const pascal = pascalCase(name);
  const kebab = kebabCase(name);
  const { presets = [], typescript = true } = opts;

  const hasSoftDelete = presets.includes('softDelete');
  const hasSlug = presets.includes('slugLookup');

  return `/**
 * ${pascal} Tests
 * @generated by Arc CLI
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
${typescript ? "import type { FastifyInstance } from 'fastify';\n" : ''}import { createTestApp } from '@classytic/arc/testing';

describe('${pascal} API', () => {
  let app${typescript ? ': FastifyInstance' : ''};

  beforeAll(async () => {
    app = await createTestApp({
      auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('CRUD Operations', () => {
    let createdId${typescript ? ': string' : ''};

    it('should create a ${kebab}', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/${kebab}s',
        payload: { name: 'Test ${pascal}' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Test ${pascal}');
      createdId = body.data._id;
    });

    it('should list ${kebab}s', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/${kebab}s',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.docs || body.data)).toBe(true);
    });

    it('should get ${kebab} by id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: \`/${kebab}s/\${createdId}\`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data._id).toBe(createdId);
    });

    it('should update ${kebab}', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: \`/${kebab}s/\${createdId}\`,
        payload: { name: 'Updated ${pascal}' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.name).toBe('Updated ${pascal}');
    });

    it('should delete ${kebab}', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: \`/${kebab}s/\${createdId}\`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });
${
  hasSlug
    ? `
  describe('Slug Lookup', () => {
    it('should get by slug', async () => {
      // Create with auto-generated slug
      const createRes = await app.inject({
        method: 'POST',
        url: '/${kebab}s',
        payload: { name: 'Slug Test Item' },
      });
      const slug = createRes.json().data.slug;

      const response = await app.inject({
        method: 'GET',
        url: \`/${kebab}s/slug/\${slug}\`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.slug).toBe(slug);
    });
  });
`
    : ''
}${
    hasSoftDelete
      ? `
  describe('Soft Delete', () => {
    it('should soft delete and restore', async () => {
      // Create
      const createRes = await app.inject({
        method: 'POST',
        url: '/${kebab}s',
        payload: { name: 'Soft Delete Test' },
      });
      const id = createRes.json().data._id;

      // Delete (soft)
      await app.inject({
        method: 'DELETE',
        url: \`/${kebab}s/\${id}\`,
      });

      // Verify in deleted list
      const deletedRes = await app.inject({
        method: 'GET',
        url: '/${kebab}s/deleted',
      });
      expect(deletedRes.json().data.some((d${typescript ? ': any' : ''}) => d._id === id)).toBe(true);

      // Restore
      const restoreRes = await app.inject({
        method: 'POST',
        url: \`/${kebab}s/\${id}/restore\`,
      });
      expect(restoreRes.statusCode).toBe(200);
    });
  });
`
      : ''
  }});
`;
}

// ============================================================================
// Helpers
// ============================================================================

function printNextSteps(name: string, moduleName?: string): void {
  const kebab = kebabCase(name);
  const camel = camelCase(name);
  const modulePath = moduleName ? `${moduleName}/${kebab}` : kebab;

  console.log(`📋 Next Steps:

1. Register the route in your app:
   ${`import ${camel}Routes from '#modules/${modulePath}/routes.js';
   await fastify.register(${camel}Routes);`}

2. Run tests:
   npm test -- ${kebab}

3. Access your API:
   GET    /${kebab}s          List all
   GET    /${kebab}s/:id      Get by ID
   POST   /${kebab}s          Create
   PATCH  /${kebab}s/:id      Update
   DELETE /${kebab}s/:id      Delete
`);
}

function pascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join('');
}

function camelCase(str: string): string {
  const pascal = pascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

export default { generate };
