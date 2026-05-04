/**
 * ArcQueryParser + In-Memory Store + defineResource + MCP Integration
 *
 * Proves Arc's built-in query parser works end-to-end with MCP
 * using a pure in-memory store — no MongoDB, no external DB.
 *
 * This is the DB-agnostic path: users with Prisma, Drizzle, SQLite,
 * or custom adapters get the same MCP auto-derive behaviour.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { resourceToTools } from "../../src/integrations/mcp/resourceToTools.js";
import { createTestMcpClient } from "../../src/integrations/mcp/testing.js";
import { allowPublic } from "../../src/permissions/index.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

// ============================================================================
// In-Memory Store — no external DB dependency
// ============================================================================

interface Task {
  _id: string;
  title: string;
  status: "open" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  assignee?: string;
  createdAt: string;
  updatedAt: string;
}

let nextId = 1;
let store: Task[] = [];

function createInMemoryRepository() {
  return {
    async getAll(params?: {
      filters?: Record<string, unknown>;
      filter?: Record<string, unknown>;
      sort?: string | Record<string, 1 | -1>;
      page?: number;
      limit?: number;
    }) {
      let data = [...store];

      // Apply filters — BaseController passes `filters` (plural), raw callers may use `filter`
      const filterObj = params?.filters ?? params?.filter;
      if (filterObj) {
        for (const [key, value] of Object.entries(filterObj)) {
          if (typeof value === "object" && value !== null) {
            // Operator filters: { $eq: 'open' }
            for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
              data = data.filter((d) => {
                const fieldVal = (d as Record<string, unknown>)[key];
                switch (op) {
                  case "$eq":
                    return fieldVal === opVal;
                  case "$ne":
                    return fieldVal !== opVal;
                  case "$in":
                    return Array.isArray(opVal) && opVal.includes(fieldVal);
                  case "$nin":
                    return Array.isArray(opVal) && !opVal.includes(fieldVal);
                  default:
                    return true;
                }
              });
            }
          } else {
            // Direct equality
            data = data.filter((d) => (d as Record<string, unknown>)[key] === value);
          }
        }
      }

      // Apply sort — may be string ("-createdAt,name") or object
      const sortSpec = params?.sort;
      if (sortSpec) {
        let sortObj: Record<string, 1 | -1>;
        if (typeof sortSpec === "string") {
          sortObj = {};
          for (const f of sortSpec.split(",")) {
            const trimmed = f.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("-")) sortObj[trimmed.slice(1)] = -1;
            else sortObj[trimmed] = 1;
          }
        } else {
          sortObj = sortSpec;
        }
        const sortEntries = Object.entries(sortObj);
        data.sort((a, b) => {
          for (const [field, dir] of sortEntries) {
            const aVal = (a as Record<string, unknown>)[field] as string;
            const bVal = (b as Record<string, unknown>)[field] as string;
            if (aVal < bVal) return -1 * dir;
            if (aVal > bVal) return 1 * dir;
          }
          return 0;
        });
      }

      const page = params?.page ?? 1;
      const limit = params?.limit ?? 20;
      const start = (page - 1) * limit;
      const paged = data.slice(start, start + limit);

      return {
        method: "offset",
        data: paged,
        page,
        limit,
        total: data.length,
        pages: Math.ceil(data.length / limit),
        hasNext: start + limit < data.length,
        hasPrev: page > 1,
      };
    },

    async getById(id: string) {
      return store.find((d) => d._id === id) ?? null;
    },

    async create(data: Record<string, unknown>) {
      const now = new Date().toISOString();
      const doc = {
        _id: String(nextId++),
        createdAt: now,
        updatedAt: now,
        ...data,
      } as Task;
      store.push(doc);
      return doc;
    },

    async update(id: string, data: Record<string, unknown>) {
      const idx = store.findIndex((d) => d._id === id);
      if (idx === -1) throw new Error("Not found");
      store[idx] = { ...store[idx], ...data, updatedAt: new Date().toISOString() } as Task;
      return store[idx];
    },

    async delete(id: string) {
      const idx = store.findIndex((d) => d._id === id);
      if (idx === -1) return { success: false };
      store.splice(idx, 1);
      return { success: true, deletedCount: 1 };
    },
  };
}

// ============================================================================
// Setup — ArcQueryParser with whitelists (same pattern users would use)
// ============================================================================

const queryParser = new ArcQueryParser({
  allowedFilterFields: ["status", "priority", "assignee"],
  allowedSortFields: ["title", "createdAt", "priority"],
  allowedOperators: ["eq", "ne", "in"],
});

const inMemoryRepo = createInMemoryRepository();

function createInMemoryAdapter(): DataAdapter<Task> {
  return {
    repository: inMemoryRepo as any,
    type: "custom",
    name: "in-memory",
  };
}

const taskResource = defineResource({
  name: "task",
  displayName: "Tasks",
  adapter: createInMemoryAdapter(),
  controller: new BaseController(inMemoryRepo as any, {
    resourceName: "task",
    queryParser,
    tenantField: false,
  }),
  queryParser,
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  },
  schemaOptions: {
    fieldRules: {
      title: { type: "string", required: true, description: "Task title" },
      status: {
        type: "string",
        enum: ["open", "in_progress", "done"],
        description: "Task status",
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Priority level",
      },
      assignee: { type: "string", description: "Assigned person" },
      createdAt: { type: "date", systemManaged: true },
      updatedAt: { type: "date", systemManaged: true },
    },
    // NOTE: no filterableFields — should auto-derive from ArcQueryParser
  },
});

// ============================================================================
// Lifecycle
// ============================================================================

beforeAll(() => {
  store = [];
  nextId = 1;
});

// ============================================================================
// 1. ArcQueryParser whitelist enforcement
// ============================================================================

describe("ArcQueryParser whitelist enforcement", () => {
  it("accepts allowed filter fields", () => {
    const parsed = queryParser.parse({ status: "open", priority: "high" });
    expect(parsed.filters).toHaveProperty("status", "open");
    expect(parsed.filters).toHaveProperty("priority", "high");
  });

  it("rejects disallowed filter fields", () => {
    const parsed = queryParser.parse({ title: "hello", status: "open" });
    expect(parsed.filters).not.toHaveProperty("title");
    expect(parsed.filters).toHaveProperty("status");
  });

  it("accepts allowed sort fields", () => {
    const parsed = queryParser.parse({ sort: "-createdAt,title" });
    expect(parsed.sort).toEqual({ createdAt: -1, title: 1 });
  });

  it("rejects disallowed sort fields", () => {
    const parsed = queryParser.parse({ sort: "status,-createdAt" });
    // status is NOT in allowedSortFields
    expect(parsed.sort).toEqual({ createdAt: -1 });
    expect(parsed.sort).not.toHaveProperty("status");
  });

  it("accepts allowed operators", () => {
    const parsed = queryParser.parse({ status: { eq: "open" } });
    expect(parsed.filters.status).toEqual({ $eq: "open" });
  });

  it("rejects disallowed operators", () => {
    // 'gte' is not in allowedOperators
    const parsed = queryParser.parse({ priority: { gte: "medium" } });
    expect(parsed.filters).not.toHaveProperty("priority");
  });

  it("exposes whitelist properties for MCP auto-derive", () => {
    expect(queryParser.allowedFilterFields).toEqual(["status", "priority", "assignee"]);
    expect(queryParser.allowedSortFields).toEqual(["title", "createdAt", "priority"]);
    expect(queryParser.allowedOperators).toEqual(["eq", "ne", "in"]);
  });
});

// ============================================================================
// 2. MCP tool schema auto-derive from ArcQueryParser
// ============================================================================

describe("MCP tool schemas from ArcQueryParser", () => {
  let tools: ReturnType<typeof resourceToTools>;

  beforeAll(() => {
    tools = resourceToTools(taskResource);
  });

  it("generates all 5 CRUD tools", () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      "list_tasks",
      "get_task",
      "create_task",
      "update_task",
      "delete_task",
    ]);
  });

  it("list tool has filterable fields from ArcQueryParser in schema", () => {
    const listTool = tools.find((t) => t.name === "list_tasks")!;
    expect(listTool.inputSchema).toHaveProperty("status");
    expect(listTool.inputSchema).toHaveProperty("priority");
    expect(listTool.inputSchema).toHaveProperty("assignee");
    // title is NOT in allowedFilterFields
    expect(listTool.inputSchema).not.toHaveProperty("title");
  });

  it("list tool description includes filterable fields", () => {
    const listTool = tools.find((t) => t.name === "list_tasks")!;
    expect(listTool.description).toContain("status");
    expect(listTool.description).toContain("priority");
    expect(listTool.description).toContain("Filterable fields");
  });

  it("list tool description includes operators", () => {
    const listTool = tools.find((t) => t.name === "list_tasks")!;
    expect(listTool.description).toContain("eq, ne, in");
    expect(listTool.description).toContain("Filter operators");
  });

  it("list tool description includes sortable fields", () => {
    const listTool = tools.find((t) => t.name === "list_tasks")!;
    expect(listTool.description).toContain("title");
    expect(listTool.description).toContain("createdAt");
    expect(listTool.description).toContain("Sortable fields");
  });

  it("create tool excludes systemManaged fields", () => {
    const createTool = tools.find((t) => t.name === "create_task")!;
    expect(createTool.inputSchema).toHaveProperty("title");
    expect(createTool.inputSchema).toHaveProperty("status");
    expect(createTool.inputSchema).not.toHaveProperty("createdAt");
    expect(createTool.inputSchema).not.toHaveProperty("updatedAt");
  });
});

// ============================================================================
// 3. MCP end-to-end — full CRUD via createTestMcpClient + in-memory store
// ============================================================================

describe("MCP end-to-end with ArcQueryParser + in-memory store", () => {
  let client: Awaited<ReturnType<typeof createTestMcpClient>>;

  beforeAll(async () => {
    store = [];
    nextId = 1;

    // Seed data
    await inMemoryRepo.create({
      title: "Write tests",
      status: "open",
      priority: "high",
      assignee: "alice",
    });
    await inMemoryRepo.create({
      title: "Deploy app",
      status: "in_progress",
      priority: "medium",
      assignee: "bob",
    });
    await inMemoryRepo.create({
      title: "Fix bug",
      status: "done",
      priority: "low",
      assignee: "alice",
    });

    client = await createTestMcpClient({
      pluginOptions: {
        resources: [taskResource],
        instructions: "Task management with in-memory store.",
      },
      auth: { userId: "test-user" },
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists all tools", async () => {
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "list_tasks",
        "get_task",
        "create_task",
        "update_task",
        "delete_task",
      ]),
    );
  });

  it("list_tasks returns all items", async () => {
    const result = await client.callTool("list_tasks", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text);
    expect(data.data).toHaveLength(3);
    expect(data.total).toBe(3);
  });

  it("list_tasks filters by status", async () => {
    const result = await client.callTool("list_tasks", { status: "open" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].title).toBe("Write tests");
  });

  it("list_tasks filters by assignee", async () => {
    const result = await client.callTool("list_tasks", { assignee: "alice" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text);
    expect(data.data).toHaveLength(2);
  });

  it("list_tasks filters by priority", async () => {
    const result = await client.callTool("list_tasks", { priority: "high" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].title).toBe("Write tests");
  });

  it("create_task creates via MCP", async () => {
    const result = await client.callTool("create_task", {
      title: "Review PR",
      status: "open",
      priority: "medium",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text);
    expect(data.data?.title || data.title).toBe("Review PR");
    expect(store).toHaveLength(4);
  });

  it("get_task retrieves by ID", async () => {
    const result = await client.callTool("get_task", { id: "1" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text);
    expect(data.data?.title || data.title).toBe("Write tests");
  });

  it("update_task updates via MCP", async () => {
    const result = await client.callTool("update_task", { id: "1", status: "done" });
    expect(result.isError).toBeFalsy();
    expect(store.find((t) => t._id === "1")?.status).toBe("done");
  });

  it("delete_task deletes via MCP", async () => {
    const countBefore = store.length;
    const result = await client.callTool("delete_task", { id: "1" });
    expect(result.isError).toBeFalsy();
    expect(store).toHaveLength(countBefore - 1);
    expect(store.find((t) => t._id === "1")).toBeUndefined();
  });
});
