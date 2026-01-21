/**
 * Arc CLI - Generate Command
 *
 * Scaffolds resources, controllers, and models
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Templates
const templates = {
  resource: (name: string) => `/**
 * ${name} Resource Definition
 */

import { defineResource } from '@classytic/arc';
import { ${name}Controller } from './${name.toLowerCase()}.controller.js';
import { ${name}Model } from './${name.toLowerCase()}.model.js';
import { ${name}Repository } from './${name.toLowerCase()}.repository.js';
import permissions from '#config/permissions.js';

const ${name.toLowerCase()}Resource = defineResource({
  name: '${name.toLowerCase()}',
  model: ${name}Model,
  repository: new ${name}Repository(${name}Model),
  controller: new ${name}Controller(new ${name}Repository(${name}Model)),

  permissions: {
    list: permissions.${name.toLowerCase()}.view,
    get: permissions.${name.toLowerCase()}.view,
    create: permissions.${name.toLowerCase()}.manage,
    update: permissions.${name.toLowerCase()}.manage,
    delete: permissions.${name.toLowerCase()}.manage,
  },

  presets: [
    'softDelete',
    'slugLookup',
  ],

  additionalRoutes: [],
});

export default ${name.toLowerCase()}Resource;
`,

  controller: (name: string) => `/**
 * ${name} Controller
 */

import { BaseController } from '@classytic/arc';
import type { ${name}Repository } from './${name.toLowerCase()}.repository.js';

export class ${name}Controller extends BaseController {
  constructor(repository: ${name}Repository) {
    super(repository, {
      resourceName: '${name.toLowerCase()}',
    });
  }

  // Add custom methods here
  async customMethod(req: any, reply: any) {
    const { id } = req.params;
    const result = await this.repository.findById(id);
    return reply.send({ success: true, data: result });
  }
}
`,

  model: (name: string) => `/**
 * ${name} Mongoose Model
 */

import mongoose from 'mongoose';

const ${name.toLowerCase()}Schema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      unique: true,
      sparse: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
${name.toLowerCase()}Schema.index({ name: 1 });
${name.toLowerCase()}Schema.index({ slug: 1 });
${name.toLowerCase()}Schema.index({ isActive: 1, isDeleted: 1 });

export const ${name}Model = mongoose.model('${name}', ${name.toLowerCase()}Schema);
`,

  repository: (name: string) => `/**
 * ${name} Repository
 */

import { BaseRepository } from '@classytic/arc';
import type { ${name}Model } from './${name.toLowerCase()}.model.js';

export class ${name}Repository extends BaseRepository {
  constructor(model: typeof ${name}Model) {
    super(model);
  }

  // Add custom query methods here
  async findActive() {
    return this.findAll({ filter: { isActive: true, isDeleted: false } });
  }

  async findBySlug(slug: string) {
    return this.findOne({ slug });
  }
}
`,

  routes: (name: string) => `/**
 * ${name} Routes Plugin
 */

import ${name.toLowerCase()}Resource from './${name.toLowerCase()}.resource.js';

export default ${name.toLowerCase()}Resource.toPlugin();
`,

  test: (name: string) => `/**
 * ${name} Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, request } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

describe('${name} API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp({
      auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
      mongoUri: 'mongodb://localhost:27017/test',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  test('should create ${name.toLowerCase()}', async () => {
    const response = await request(app)
      .post('/${name.toLowerCase()}s')
      .withBody({ name: 'Test ${name}' })
      .send();

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toHaveProperty('name', 'Test ${name}');
  });

  test('should list ${name.toLowerCase()}s', async () => {
    const response = await request(app)
      .get('/${name.toLowerCase()}s')
      .send();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('data');
    expect(Array.isArray(response.json().data)).toBe(true);
  });
});
`,
};

/**
 * Generate command handler
 */
export async function generate(type: string | undefined, args: string[]): Promise<void> {
  if (!type) {
    console.error('Error: Missing type argument');
    console.log('Usage: arc generate <resource|controller|model> <name>');
    process.exit(1);
  }

  const [name] = args;
  if (!name) {
    console.error('Error: Missing name argument');
    console.log('Usage: arc generate <type> <name>');
    console.log('Example: arc generate resource product');
    process.exit(1);
  }

  // Capitalize first letter
  const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1);
  const lowerName = name.toLowerCase();

  // Create module directory
  const modulePath = join(process.cwd(), 'modules', lowerName);

  switch (type) {
    case 'resource':
    case 'r':
      await generateResource(capitalizedName, lowerName, modulePath);
      break;

    case 'controller':
    case 'c':
      await generateController(capitalizedName, lowerName, modulePath);
      break;

    case 'model':
    case 'm':
      await generateModel(capitalizedName, lowerName, modulePath);
      break;

    default:
      console.error(`Unknown type: ${type}`);
      console.log('Available types: resource, controller, model');
      process.exit(1);
  }
}

/**
 * Generate a full resource (controller, model, repository, routes)
 */
async function generateResource(name: string, lowerName: string, modulePath: string): Promise<void> {
  console.log(`Generating resource: ${name}...`);

  // Create directory
  if (!existsSync(modulePath)) {
    mkdirSync(modulePath, { recursive: true });
  }

  // Generate files
  const files: Record<string, string> = {
    [`${lowerName}.resource.ts`]: templates.resource(name),
    [`${lowerName}.controller.ts`]: templates.controller(name),
    [`${lowerName}.model.ts`]: templates.model(name),
    [`${lowerName}.repository.ts`]: templates.repository(name),
    [`routes.ts`]: templates.routes(name),
    [`${lowerName}.test.ts`]: templates.test(name),
  };

  for (const [filename, content] of Object.entries(files)) {
    const filepath = join(modulePath, filename);
    if (existsSync(filepath)) {
      console.warn(`⚠  Skipped: ${filename} (already exists)`);
    } else {
      writeFileSync(filepath, content);
      console.log(`✅ Created: ${filename}`);
    }
  }

  console.log(`
✨ Resource "${name}" generated successfully!

Next steps:
1. Add permissions to config/permissions.js:
   ${lowerName}: {
     view: ['user'],
     manage: ['admin'],
   }

2. Register the route in routes/erp.index.js:
   import ${lowerName}Plugin from '#modules/${lowerName}/routes.js';
   await fastify.register(${lowerName}Plugin);

3. Run tests:
   npm test ${lowerName}
  `);
}

/**
 * Generate a controller only
 */
async function generateController(name: string, lowerName: string, modulePath: string): Promise<void> {
  console.log(`Generating controller: ${name}Controller...`);

  if (!existsSync(modulePath)) {
    mkdirSync(modulePath, { recursive: true });
  }

  const filepath = join(modulePath, `${lowerName}.controller.ts`);
  if (existsSync(filepath)) {
    console.error(`Error: ${filepath} already exists`);
    process.exit(1);
  }

  writeFileSync(filepath, templates.controller(name));
  console.log(`✅ Created: ${lowerName}.controller.ts`);
}

/**
 * Generate a model only
 */
async function generateModel(name: string, lowerName: string, modulePath: string): Promise<void> {
  console.log(`Generating model: ${name}Model...`);

  if (!existsSync(modulePath)) {
    mkdirSync(modulePath, { recursive: true });
  }

  const filepath = join(modulePath, `${lowerName}.model.ts`);
  if (existsSync(filepath)) {
    console.error(`Error: ${filepath} already exists`);
    process.exit(1);
  }

  writeFileSync(filepath, templates.model(name));
  console.log(`✅ Created: ${lowerName}.model.ts`);
}

export default generate;
