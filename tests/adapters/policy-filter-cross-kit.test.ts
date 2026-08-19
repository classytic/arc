/**
 * Cross-kit EXECUTION of composed policy filters (the coverage the previous
 * review flagged as missing).
 *
 * Arc's policy-filter dialect is `$`-shaped (`$or` from requireGrant, `$and`
 * from conjoinPolicyFilters, `$gte` from the Mongo-dialect parser). MongoKit
 * compiles those natively, but the SQLiteKit / PGKit query path runs incoming
 * records through repo-core's BARE-operator `recordToFilter`, which treats
 * `$and`/`$or`/`$in` as literal field names. Without normalization, a composed
 * policy either throws ("no column `$and`") or silently matches nothing.
 *
 * `toRepositoryFilter` routes `$`-operator filters through repo-core's
 * `policyRecordToFilter` → portable Filter IR, which EVERY kit compiles. These
 * tests actually EXECUTE the converted filter against a real better-sqlite3
 * repository and assert row-correct results.
 */

import { recordToFilter } from "@classytic/repo-core/filter";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativePolicyFilter, toRepositoryFilter } from "../../src/core/repositoryFilter.js";

type Doc = { id: string; organizationId: string; title: string };

const docs = sqliteTable("docs", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId").notNull(),
  title: text("title").notNull(),
});

describe("policy filters execute portably on sqlitekit", () => {
  let db: Database.Database;
  let repo: SqliteRepository<Doc>;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        organizationId TEXT NOT NULL,
        title TEXT NOT NULL
      );
    `);
    repo = new SqliteRepository<Doc>({ db: drizzle(db), table: docs });
    await repo.create({ id: "1", organizationId: "org-a", title: "A1" });
    await repo.create({ id: "2", organizationId: "org-a", title: "A2" });
    await repo.create({ id: "3", organizationId: "org-b", title: "B1" });
  });

  afterEach(() => {
    db?.close();
  });

  async function count(filters: unknown): Promise<number> {
    const res = (await repo.getAll({ filters } as never)) as { data: Doc[] } | Doc[];
    const rows = Array.isArray(res) ? res : res.data;
    return rows.length;
  }

  it("flat equality passes through unchanged and matches", async () => {
    expect(await count(toRepositoryFilter({ organizationId: "org-a" }))).toBe(2);
  });

  it("a $and CONFLICT (org-a AND org-b) executes to ZERO rows — no throw", async () => {
    // conjoinPolicyFilters output for two contradictory equality constraints.
    const conflict = toRepositoryFilter({
      $and: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
    });
    expect(await count(conflict)).toBe(0);
  });

  it("a $and with a compatible sibling narrows correctly", async () => {
    const composed = toRepositoryFilter({
      $and: [{ organizationId: "org-a" }, { title: "A2" }],
    });
    expect(await count(composed)).toBe(1);
  });

  it("a $or (requireGrant-style) returns the union", async () => {
    const grant = toRepositoryFilter({ $or: [{ id: "1" }, { id: "3" }] });
    expect(await count(grant)).toBe(2);
  });

  it("BASELINE: the raw $and record (pre-fix) is NOT portable on sqlitekit", async () => {
    // Proves the regression the conversion prevents: handing a raw `$and`
    // record straight to recordToFilter mis-handles it (throws, or resolves a
    // bogus `$and` column) rather than executing the conjunction. The exact
    // failure mode is kit-internal; what matters is it does NOT return the
    // correct 0-row conjunction the way the converted IR does.
    let rawMatched: number | "threw";
    try {
      rawMatched = await count(
        recordToFilter({ $and: [{ organizationId: "org-a" }, { organizationId: "org-b" }] }),
      );
    } catch {
      rawMatched = "threw";
    }
    // Converted path is correct (0); raw path is either a throw or a wrong count.
    expect(rawMatched).not.toBe(0);
  });
});

describe("Mongo array policy normalization", () => {
  it("preserves an explicitly native $elemMatch record without involving repo-core IR", () => {
    const native = nativePolicyFilter("mongodb", {
      assignments: {
        $elemMatch: { actorRef: "worker-1", unassignedAt: { $exists: false } },
      },
    });
    expect(toRepositoryFilter({ organizationId: "office-1", $and: [native] })).toEqual({
      organizationId: "office-1",
      $and: [{
        assignments: {
          $elemMatch: { actorRef: "worker-1", unassignedAt: { $exists: false } },
        },
      }],
    });
  });
});
