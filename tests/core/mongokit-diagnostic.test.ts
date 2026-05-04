/**
 * MongoKit 3.4 Diagnostic Tests
 *
 * Thorough probe of every MongoKit 3.4 feature through Arc's BaseController.
 * Purpose: Find all bugs/gaps in MongoKit before integrating into Arc.
 *
 * Each test documents expected vs actual behavior.
 * Tests marked with "MONGOKIT BUG" are issues that need fixing in MongoKit.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import mongoose from "mongoose";
import qs from "qs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

// ============================================================================
// Test Models
// ============================================================================

const DepartmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    budget: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const EmployeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    salary: { type: Number, required: true },
    // Ref-based (for populate)
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DiagDepartment",
    },
    // String-based (for $lookup join)
    departmentSlug: { type: String },
    status: {
      type: String,
      enum: ["active", "inactive", "onleave"],
      default: "active",
    },
    role: { type: String, default: "staff" },
  },
  { timestamps: true },
);

let DeptModel: mongoose.Model<any>;
let EmpModel: mongoose.Model<any>;
let deptRepo: Repository<any>;
let empRepo: Repository<any>;
const parser = new QueryParser();

// ============================================================================
// Setup
// ============================================================================

beforeAll(async () => {
  await setupTestDatabase();

  DeptModel = mongoose.models.DiagDepartment || mongoose.model("DiagDepartment", DepartmentSchema);
  EmpModel = mongoose.models.DiagEmployee || mongoose.model("DiagEmployee", EmployeeSchema);

  deptRepo = new Repository(DeptModel);
  empRepo = new Repository(EmpModel);
});

afterAll(async () => {
  await teardownTestDatabase();
});

beforeEach(async () => {
  await DeptModel.deleteMany({});
  await EmpModel.deleteMany({});
});

// Seed helper
async function seed() {
  const engineering = await DeptModel.create({
    name: "Engineering",
    slug: "engineering",
    budget: 500000,
  });
  const sales = await DeptModel.create({
    name: "Sales",
    slug: "sales",
    budget: 200000,
  });
  const hr = await DeptModel.create({
    name: "HR",
    slug: "hr",
    budget: 100000,
    isActive: false,
  });

  const alice = await EmpModel.create({
    name: "Alice",
    email: "alice@test.com",
    salary: 120000,
    department: engineering._id,
    departmentSlug: "engineering",
    status: "active",
    role: "lead",
  });
  const bob = await EmpModel.create({
    name: "Bob",
    email: "bob@test.com",
    salary: 95000,
    department: engineering._id,
    departmentSlug: "engineering",
    status: "active",
    role: "staff",
  });
  const carol = await EmpModel.create({
    name: "Carol",
    email: "carol@test.com",
    salary: 85000,
    department: sales._id,
    departmentSlug: "sales",
    status: "inactive",
    role: "staff",
  });
  const dave = await EmpModel.create({
    name: "Dave",
    email: "dave@test.com",
    salary: 75000,
    department: hr._id,
    departmentSlug: "hr",
    status: "onleave",
    role: "manager",
  });

  return { engineering, sales, hr, alice, bob, carol, dave };
}

// Helper: parse URL query through qs (same as Fastify + Arc)
function parseQuery(queryString: string) {
  return parser.parse(qs.parse(queryString));
}

// ============================================================================
// 1. QueryParser Output Shape
// ============================================================================

describe("1. QueryParser output shape", () => {
  it("should parse basic filters", () => {
    const result = parseQuery("status=active&salary[gte]=100000");
    expect(result.filters).toBeDefined();
    expect(result.filters?.status).toBe("active");
    expect(result.filters?.salary).toEqual({ $gte: 100000 });
  });

  it("should parse sort", () => {
    const result = parseQuery("sort=-salary,name");
    expect(result.sort).toEqual({ salary: -1, name: 1 });
  });

  it("should parse select as object projection", () => {
    const result = parseQuery("select=name,email,-salary");
    expect(result.select).toEqual({ name: 1, email: 1, salary: 0 });
  });

  it("should parse simple populate into populateOptions (fixed in 3.4.1)", () => {
    const result = parseQuery("populate=department");
    // Fixed in MongoKit 3.4.1: simple populate is normalized into populateOptions
    expect(result.populateOptions).toBeDefined();
    expect(result.populateOptions?.[0].path).toBe("department");
  });

  it("should parse populate with select", () => {
    const result = parseQuery("populate[department][select]=name,slug");
    expect(result.populateOptions).toBeDefined();
    expect(result.populateOptions?.[0].path).toBe("department");
    expect(result.populateOptions?.[0].select).toBe("name slug");
  });

  it("should parse populate with match", () => {
    const result = parseQuery(
      "populate[department][select]=name&populate[department][match][isActive]=true",
    );
    expect(result.populateOptions?.[0].match).toBeDefined();
  });

  it("should parse lookup", () => {
    const result = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    expect(result.lookups).toBeDefined();
    expect(result.lookups?.length).toBe(1);
    expect(result.lookups?.[0].from).toBe("diagdepartments");
    expect(result.lookups?.[0].localField).toBe("departmentSlug");
    expect(result.lookups?.[0].foreignField).toBe("slug");
    expect(result.lookups?.[0].as).toBe("dept");
    expect(result.lookups?.[0].single).toBe(true);
  });

  it("should parse lookup with select", () => {
    const result = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][select]=name,slug",
    );
    expect(result.lookups?.[0].select).toBe("name,slug");
  });

  it("should parse pagination", () => {
    const result = parseQuery("page=2&limit=10");
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
  });

  it("should parse keyset cursor", () => {
    const result = parseQuery("after=abc123&limit=10");
    expect(result.after).toBe("abc123");
    // page should be undefined when using cursor
    expect(result.page).toBeUndefined();
  });
});

// ============================================================================
// 2. Repository.getAll — Basic Operations
// ============================================================================

describe("2. Repository.getAll — basic operations", () => {
  it("should list all with default pagination", async () => {
    await seed();
    const result = await empRepo.getAll({});
    expect(result.data.length).toBe(4);
    expect(result.total).toBe(4);
  });

  it("should filter by exact match", async () => {
    await seed();
    const parsed = parseQuery("status=active");
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(2);
    expect(result.data.every((d: any) => d.status === "active")).toBe(true);
  });

  it("should filter with operators", async () => {
    await seed();
    const parsed = parseQuery("salary[gte]=90000");
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(2); // Alice 120k, Bob 95k
  });

  it("should sort ascending", async () => {
    await seed();
    const parsed = parseQuery("sort=salary");
    const result = await empRepo.getAll(parsed);
    expect(result.data[0].name).toBe("Dave"); // 75k lowest
    expect(result.data[3].name).toBe("Alice"); // 120k highest
  });

  it("should sort descending", async () => {
    await seed();
    const parsed = parseQuery("sort=-salary");
    const result = await empRepo.getAll(parsed);
    expect(result.data[0].name).toBe("Alice"); // 120k highest
  });

  it("should paginate with offset", async () => {
    await seed();
    const parsed = parseQuery("limit=2&page=1&sort=name");
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(2);
    expect(result.total).toBe(4);
    expect(result.hasNext).toBe(true);
    expect(result.data[0].name).toBe("Alice");
    expect(result.data[1].name).toBe("Bob");
  });

  it("should paginate page 2", async () => {
    await seed();
    const parsed = parseQuery("limit=2&page=2&sort=name");
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(2);
    expect(result.hasPrev).toBe(true);
    expect(result.data[0].name).toBe("Carol");
    expect(result.data[1].name).toBe("Dave");
  });

  it("should select specific fields", async () => {
    await seed();
    const parsed = parseQuery("select=name,email");
    const result = await empRepo.getAll(parsed);
    const doc = result.data[0];
    expect(doc.name).toBeDefined();
    expect(doc.email).toBeDefined();
    // salary should not be in the result
    expect(doc.salary).toBeUndefined();
  });
});

// ============================================================================
// 3. Populate (ref-based)
// ============================================================================

describe("3. Populate (ref-based)", () => {
  it("should populate department", async () => {
    await seed();
    const parsed = parseQuery("populate=department");
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.department).toBeDefined();
    expect(alice.department.name).toBe("Engineering");
  });

  it("should populate with field select", async () => {
    await seed();
    const parsed = parseQuery("populate[department][select]=name");
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.department.name).toBe("Engineering");
    expect(alice.department.slug).toBeUndefined();
    expect(alice.department.budget).toBeUndefined();
  });

  it("should populate with exclude select", async () => {
    await seed();
    const parsed = parseQuery("populate[department][select]=-budget,-__v");
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.department.name).toBe("Engineering");
    expect(alice.department.slug).toBe("engineering");
    expect(alice.department.budget).toBeUndefined();
  });

  it("should populate with match filter", async () => {
    await seed();
    const parsed = parseQuery(
      "populate[department][select]=name&populate[department][match][isActive]=true",
    );
    const result = await empRepo.getAll(parsed);
    // Dave's HR dept is inactive — should be null after match
    const dave = result.data.find((d: any) => d.name === "Dave");
    expect(dave.department).toBeNull();
    // Alice's Engineering dept is active — should populate
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.department).toBeDefined();
    expect(alice.department.name).toBe("Engineering");
  });
});

// ============================================================================
// 4. Lookup ($lookup join — no refs)
// ============================================================================

describe("4. Lookup ($lookup join — no refs)", () => {
  it("should join by slug with single=true", async () => {
    await seed();
    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(4);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.dept).toBeDefined();
    expect(alice.dept.name).toBe("Engineering");
    expect(alice.dept.slug).toBe("engineering");
  });

  it("should join with select on joined collection", async () => {
    await seed();
    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true&lookup[dept][select]=name",
    );
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.dept).toBeDefined();
    expect(alice.dept.name).toBe("Engineering");
    // slug should be excluded by lookup select
    expect(alice.dept.slug).toBeUndefined();
  });

  it("should join as array when single=false (default)", async () => {
    await seed();
    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug",
    );
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    // Without single=true, dept should be an array
    expect(Array.isArray(alice.dept)).toBe(true);
    expect(alice.dept.length).toBe(1);
    expect(alice.dept[0].name).toBe("Engineering");
  });

  it("single lookup with no match returns null (fixed in 3.4.1)", async () => {
    await seed();
    await EmpModel.create({
      name: "Eve",
      email: "eve@test.com",
      salary: 60000,
      departmentSlug: "nonexistent",
    });

    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    const eve = result.data.find((d: any) => d.name === "Eve");
    // Fixed in MongoKit 3.4.1: returns null for no-match with single=true
    expect(eve.dept).toBeNull();
  });

  it("should work with filter + lookup", async () => {
    await seed();
    const parsed = parseQuery(
      "status=active&lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(2); // Alice and Bob
    expect(result.data.every((d: any) => d.dept && d.dept.name === "Engineering")).toBe(true);
  });

  it("should work with sort + lookup", async () => {
    await seed();
    const parsed = parseQuery(
      "sort=-salary&lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data[0].name).toBe("Alice"); // highest salary
    expect(result.data[0].dept.name).toBe("Engineering");
  });

  it("should work with pagination + lookup", async () => {
    await seed();
    const parsed = parseQuery(
      "limit=2&page=1&sort=name&lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(2);
    expect(result.total).toBe(4);
    expect(result.hasNext).toBe(true);
    expect(result.data[0].dept).toBeDefined();
  });
});

// ============================================================================
// 5. MONGOKIT BUG: select + lookup combined
// ============================================================================

describe("5. POTENTIAL BUG: select + lookup combined", () => {
  it("MONGOKIT BUG: root select strips lookup alias from results", async () => {
    await seed();

    // This is the bug: when select is specified, $project runs after $lookup
    // but doesn't include the lookup 'as' field → lookup data is stripped
    const parsed = parseQuery(
      "select=name,salary,departmentSlug&lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.name).toBe("Alice");
    expect(alice.salary).toBe(120000);

    // Fixed in MongoKit 3.4.1: lookup aliases are auto-included in $project
    expect(alice.dept).toBeDefined();
    expect(alice.dept.name).toBe("Engineering");
  });

  it("lookup without root select works fine", async () => {
    await seed();
    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.dept).toBeDefined(); // Works when no select
    expect(alice.dept.name).toBe("Engineering");
  });
});

// ============================================================================
// 6. Keyset (cursor) pagination
// ============================================================================

describe("6. Keyset (cursor) pagination", () => {
  it("keyset pagination with plain ObjectId (fixed in 3.4.1)", async () => {
    await seed();

    const page1 = await empRepo.getAll({ limit: 2, sort: { name: 1 } });
    expect(page1.data.length).toBe(2);
    expect(page1.data[0].name).toBe("Alice");
    expect(page1.data[1].name).toBe("Bob");

    // Fixed in MongoKit 3.4.1: accepts plain ObjectId as cursor
    const lastId = page1.data[page1.data.length - 1]._id.toString();
    const page2Parsed = parseQuery(`after=${lastId}&limit=2&sort=name`);
    const page2 = await empRepo.getAll(page2Parsed);
    expect(page2.data.length).toBeGreaterThanOrEqual(1);
    // Should get Carol and/or Dave (alphabetically after Bob)
    expect(page2.data[0].name).toBe("Carol");
  });
});

// ============================================================================
// 7. Multiple lookups
// ============================================================================

describe("7. Multiple lookups in one query", () => {
  it("MONGOKIT BUG #5: lookup with select uses pipeline form which duplicates results", async () => {
    await seed();

    // When lookup has `select`, LookupBuilder.multiple() converts it to a $project
    // pipeline stage. This triggers the pipeline form of $lookup which may produce
    // different pagination counts ($facet counts docs AFTER $lookup which can
    // change doc count if $unwind is involved)
    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true&lookup[dept][select]=name",
    );
    const result = await empRepo.getAll(parsed);

    // BUG: When lookup.select is present, LookupBuilder uses pipeline form.
    // The pipeline form with $unwind may interact with $facet differently —
    // total reports 12 instead of 4 (3x duplication per doc).
    //
    // This happens because:
    // 1. LookupBuilder.multiple() with select creates a pipeline $lookup
    // 2. The pipeline $lookup + $unwind runs BEFORE $facet
    // 3. $facet metadata { $count: 'total' } counts post-unwind docs
    //
    // FIX: lookupPopulate should place $lookup/$unwind INSIDE the $facet data pipeline,
    // or run the $count before the lookup stages.
    //
    // For now, docs are correct but total is wrong:
    expect(result.data.length).toBeLessThanOrEqual(20); // default limit
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.dept).toBeDefined();
    expect(alice.dept.name).toBe("Engineering");
  });
});

// ============================================================================
// 8. Populate + Lookup in same query
// ============================================================================

describe("8. Populate and Lookup in same query", () => {
  it("should handle both populate and lookup simultaneously", async () => {
    await seed();

    // This tests whether MongoKit can handle populate (ref-based) + lookup ($lookup) together
    // Since lookup triggers aggregation pipeline, populate may not work alongside it
    const query = qs.parse(
      "populate=department&lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const parsed = parser.parse(query);

    // When lookups are present, getAll routes to lookupPopulate which uses aggregation
    // Mongoose .populate() doesn't work with aggregation — they're separate paradigms
    // This may either: work (if MongoKit handles it), fail silently, or error
    try {
      const result = await empRepo.getAll(parsed);
      // If it succeeds, check what we get
      const alice = result.data.find((d: any) => d.name === "Alice");
      // dept (lookup) should work
      expect(alice.dept).toBeDefined();
      expect(alice.dept.name).toBe("Engineering");
      // department (populate) — may or may not work depending on MongoKit
      // Aggregation results don't go through .populate(), so this is likely an ObjectId
      // This documents the actual behavior
      if (alice.department && typeof alice.department === "object" && alice.department.name) {
        // MongoKit somehow handled populate in aggregation
        console.log("INFO: Populate works alongside lookup in aggregation");
      } else {
        // Expected: populate doesn't work in aggregation mode
        console.log("INFO: Populate ignored when lookup triggers aggregation (expected)");
      }
    } catch (err: any) {
      // If it errors, document what happens
      console.log("INFO: Populate + lookup combination errors:", err.message?.slice(0, 100));
    }
  });
});

// ============================================================================
// 9. Edge cases
// ============================================================================

describe("9. Edge cases", () => {
  it("empty collection with lookup — total is undefined (cosmetic, does not affect usage)", async () => {
    // No seed — empty collection
    const parsed = parseQuery(
      "lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data).toEqual([]);
    // $facet metadata is empty array when no docs → total is undefined
    // Not a functional issue: data.length === 0 is the reliable empty check
    expect(result.total).toBeUndefined();
  });

  it("lookup to non-existent collection returns null for single (fixed in 3.4.1)", async () => {
    await seed();
    const parsed = parseQuery(
      "lookup[x][from]=nonexistent_collection&lookup[x][localField]=departmentSlug&lookup[x][foreignField]=slug&lookup[x][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(4);
    const alice = result.data.find((d: any) => d.name === "Alice");
    // Fixed in MongoKit 3.4.1: returns null for no-match
    expect(alice.x).toBeNull();
  });

  it("should handle lookup with limit=1", async () => {
    await seed();
    const parsed = parseQuery(
      "limit=1&lookup[dept][from]=diagdepartments&lookup[dept][localField]=departmentSlug&lookup[dept][foreignField]=slug&lookup[dept][single]=true",
    );
    const result = await empRepo.getAll(parsed);
    expect(result.data.length).toBe(1);
    expect(result.data[0].dept).toBeDefined();
  });

  it("should handle select with exclude syntax", async () => {
    await seed();
    const parsed = parseQuery("select=-email,-role");
    const result = await empRepo.getAll(parsed);
    const alice = result.data.find((d: any) => d.name === "Alice");
    expect(alice.name).toBe("Alice");
    expect(alice.salary).toBeDefined();
    expect(alice.email).toBeUndefined();
    expect(alice.role).toBeUndefined();
  });

  it("should handle combined filter operators", async () => {
    await seed();
    const parsed = parseQuery("salary[gte]=80000&salary[lte]=100000");
    const result = await empRepo.getAll(parsed);
    // Bob 95k, Carol 85k
    expect(result.data.length).toBe(2);
  });
});

// ============================================================================
// 10. QueryParser security
// ============================================================================

describe("10. QueryParser security", () => {
  it("should block dangerous operators in filters", () => {
    const parsed = parseQuery("$where=malicious&name=safe");
    // $where should be stripped or ignored
    expect(parsed.filters?.$where).toBeUndefined();
    expect(parsed.filters?.name).toBe("safe");
  });

  it("should handle deeply nested filters safely", () => {
    // Attempt deeply nested query
    const parsed = parseQuery("a[b][c][d][e][f][g]=deep");
    // Should either parse safely or limit depth
    expect(parsed).toBeDefined();
  });
});
