/**
 * Arc CLI - Dev Command
 *
 * Spins up a development server with MCP enabled for AI agent testing.
 * Uses MongoDB localhost with auto-seeded sample data.
 *
 * Usage:
 *   arc dev                           # Default: port 3456, db arc_dev
 *   arc dev --port 4000               # Custom port
 *   arc dev --db my_project           # Custom database name
 *   arc dev --mcp                     # MCP only (no REST, default: both)
 *   arc dev --seed                    # Seed sample data (default: true)
 *   arc dev --no-seed                 # Skip seeding
 *
 * Then connect Claude CLI:
 *   claude mcp add arc-dev --url http://localhost:3456/mcp
 */

import mongoose from "mongoose";

// ============================================================================
// Types
// ============================================================================

export interface DevOptions {
  port?: number;
  db?: string;
  mcp?: boolean;
  seed?: boolean;
  mongoUri?: string;
}

// ============================================================================
// Models — Sample resources for AI testing
// ============================================================================

function defineModels() {
  const ProductSchema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      description: String,
      price: { type: Number, required: true },
      category: {
        type: String,
        enum: ["electronics", "clothing", "food", "books", "other"],
      },
      inStock: { type: Boolean, default: true },
      tags: [String],
      sku: String,
    },
    { timestamps: true },
  );

  const TaskSchema = new mongoose.Schema(
    {
      title: { type: String, required: true },
      description: String,
      status: {
        type: String,
        enum: ["todo", "in_progress", "done"],
        default: "todo",
      },
      priority: {
        type: String,
        enum: ["low", "medium", "high"],
        default: "medium",
      },
      assignee: String,
      dueDate: Date,
    },
    { timestamps: true },
  );

  const ProductModel = mongoose.models.DevProduct || mongoose.model("DevProduct", ProductSchema);
  const TaskModel = mongoose.models.DevTask || mongoose.model("DevTask", TaskSchema);

  return { ProductModel, TaskModel };
}

// ============================================================================
// Seed Data
// ============================================================================

async function seedData(ProductModel: mongoose.Model<unknown>, TaskModel: mongoose.Model<unknown>) {
  const productCount = await ProductModel.countDocuments();
  const taskCount = await TaskModel.countDocuments();

  if (productCount === 0) {
    await ProductModel.create([
      {
        name: "MacBook Pro",
        description: "Apple laptop with M4 chip",
        price: 2499,
        category: "electronics",
        inStock: true,
        sku: "MBP-001",
        tags: ["apple", "laptop"],
      },
      {
        name: "TypeScript Handbook",
        description: "Comprehensive guide to TypeScript",
        price: 39.99,
        category: "books",
        inStock: true,
        sku: "TSH-001",
        tags: ["typescript", "programming"],
      },
      {
        name: "Running Shoes",
        description: "Lightweight running shoes",
        price: 129.99,
        category: "clothing",
        inStock: false,
        sku: "RS-001",
        tags: ["sport", "running"],
      },
    ]);
    console.log("  ✓ Seeded 3 products");
  } else {
    console.log(`  ✓ Products already seeded (${productCount} found)`);
  }

  if (taskCount === 0) {
    await TaskModel.create([
      {
        title: "Set up CI/CD",
        description: "Configure GitHub Actions pipeline",
        status: "in_progress",
        priority: "high",
        assignee: "alice",
      },
      {
        title: "Write unit tests",
        description: "Cover core modules with tests",
        status: "todo",
        priority: "medium",
        assignee: "bob",
      },
      {
        title: "Deploy to staging",
        description: "Push latest build to staging env",
        status: "todo",
        priority: "low",
      },
    ]);
    console.log("  ✓ Seeded 3 tasks");
  } else {
    console.log(`  ✓ Tasks already seeded (${taskCount} found)`);
  }
}

// ============================================================================
// Main
// ============================================================================

export async function dev(options: DevOptions = {}): Promise<void> {
  const port = options.port ?? 3456;
  const dbName = options.db ?? "arc_dev";
  const mongoUri = options.mongoUri ?? `mongodb://localhost:27017/${dbName}`;
  const shouldSeed = options.seed !== false;

  // Dynamic imports — these are framework internals
  const { Repository, QueryParser } = await import("@classytic/mongokit");
  const { createApp } = await import("../../factory/createApp.js");
  const { defineResource } = await import("../../core/defineResource.js");
  const { createMongooseAdapter } = await import("@classytic/mongokit/adapter");
  const { BaseController } = await import("../../core/BaseController.js");
  const { allowPublic } = await import("../../permissions/index.js");
  const { mcpPlugin } = await import("../../integrations/mcp/index.js");

  // ── 1. Connect to MongoDB ──
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log(`  ✓ Connected to ${mongoUri}`);

  // ── 2. Define models ──
  const { ProductModel, TaskModel } = defineModels();

  // ── 3. Define resources ──
  const productRepo = new Repository(ProductModel);
  const productParser = new QueryParser();
  const productResource = defineResource({
    name: "product",
    displayName: "Product",
    adapter: createMongooseAdapter({
      model: ProductModel,
      repository: productRepo,
    }),
    controller: new BaseController(productRepo, {
      resourceName: "product",
      queryParser: productParser,
      tenantField: false,
    }),
    queryParser: productParser,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    schemaOptions: {
      fieldRules: {
        name: {
          type: "string",
          required: true,
          maxLength: 200,
          description: "Product name",
        },
        description: {
          type: "string",
          maxLength: 2000,
          description: "Product description",
        },
        price: {
          type: "number",
          required: true,
          min: 0,
          description: "Price in USD",
        },
        category: {
          type: "string",
          enum: ["electronics", "clothing", "food", "books", "other"],
          description: "Product category",
        },
        inStock: {
          type: "boolean",
          description: "Whether the product is in stock",
        },
        tags: { type: "array", description: "Product tags" },
        sku: { type: "string", description: "Stock keeping unit code" },
        createdAt: { type: "date", systemManaged: true },
        updatedAt: { type: "date", systemManaged: true },
      },
      filterableFields: ["category", "inStock"],
      readonlyFields: ["sku"],
    },
  });

  const taskRepo = new Repository(TaskModel);
  const taskParser = new QueryParser();
  const taskResource = defineResource({
    name: "task",
    displayName: "Task",
    adapter: createMongooseAdapter({
      model: TaskModel,
      repository: taskRepo,
    }),
    controller: new BaseController(taskRepo, {
      resourceName: "task",
      queryParser: taskParser,
      tenantField: false,
    }),
    queryParser: taskParser,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    schemaOptions: {
      fieldRules: {
        title: {
          type: "string",
          required: true,
          maxLength: 500,
          description: "Task title",
        },
        description: {
          type: "string",
          maxLength: 5000,
          description: "Task description",
        },
        status: {
          type: "string",
          enum: ["todo", "in_progress", "done"],
          description: "Task status",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Task priority level",
        },
        assignee: {
          type: "string",
          description: "Person assigned to this task",
        },
        dueDate: {
          type: "date",
          description: "Due date for the task",
        },
        createdAt: { type: "date", systemManaged: true },
        updatedAt: { type: "date", systemManaged: true },
      },
      filterableFields: ["status", "priority", "assignee"],
    },
  });

  // ── 4. Create app ──
  console.log("\n🏗️  Creating Arc app...");
  const resources = [productResource, taskResource];

  const app = await createApp({
    preset: "development",
    auth: false,
    logger: { level: "info" },
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    plugins: async (fastify) => {
      // Register REST routes
      for (const resource of resources) {
        await fastify.register(resource.toPlugin());
      }

      // Register MCP
      await fastify.register(mcpPlugin, {
        resources,
        auth: false,
        serverName: "arc-dev",
        serverVersion: "1.0.0",
        instructions: `Arc development server with two resources:

**Products** — CRUD for products
  Tools: list_products, get_product, create_product, update_product, delete_product
  Fields: name (required), description, price (required, number), category (electronics/clothing/food/books/other), inStock (boolean), tags (array), sku

**Tasks** — CRUD for tasks
  Tools: list_tasks, get_task, create_task, update_task, delete_task
  Fields: title (required), description, status (todo/in_progress/done), priority (low/medium/high), assignee, dueDate

Start by listing items to see what's in the database, then create/update/delete as needed.`,
      });
    },
  });

  // ── 5. Seed data ──
  if (shouldSeed) {
    console.log("\n🌱 Seeding data...");
    await seedData(ProductModel as mongoose.Model<unknown>, TaskModel as mongoose.Model<unknown>);
  }

  // ── 6. Start server ──
  await app.listen({ port, host: "0.0.0.0" });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Arc Dev Server                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  REST:  http://localhost:${String(port).padEnd(5)}/products                   ║
║         http://localhost:${String(port).padEnd(5)}/tasks                      ║
║                                                              ║
║  MCP:   http://localhost:${String(port).padEnd(5)}/mcp                        ║
║                                                              ║
║  Claude CLI:                                                 ║
║    claude mcp add arc-dev --url http://localhost:${String(port).padEnd(5)}/mcp ║
║                                                              ║
║  Tools: list_products, get_product, create_product,          ║
║         update_product, delete_product                       ║
║         list_tasks, get_task, create_task,                   ║
║         update_task, delete_task                             ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── 7. Graceful shutdown ──
  const shutdown = async () => {
    console.log("\nShutting down...");
    await app.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
