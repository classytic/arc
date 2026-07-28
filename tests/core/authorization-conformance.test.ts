/**
 * Cross-surface authorization conformance (arc 2.30) — the regression wall.
 *
 * Proves, in ONE reusable call, that a single permission enforces IDENTICALLY on
 * the CRUD list surface and the aggregation surface: a policy-bearing permission
 * scopes both queries, and a deny fails both closed. This is what kept
 * regressing (aggregation ignoring policy / bespoke evaluation drift) — now it
 * can't without turning this red.
 */

import { describe, expect, it } from "vitest";
import { allow, deny } from "../../src/permissions/index.js";
import { runAuthorizationConformance } from "../../src/testing/authorizationConformance.js";

describe("authorization conformance — CRUD list vs aggregation parity", () => {
  it("a policy-bearing allow scopes BOTH surfaces with the SAME policy", async () => {
    const c = await runAuthorizationConformance({
      permission: () => allow({ policy: { ownerId: "u1" } }),
    });
    try {
      expect(c.list.status).toBe(200);
      expect(c.aggregation.status).toBe(200);
      // The row policy reached the repository on BOTH surfaces, identically.
      expect(JSON.stringify(c.list.filter ?? {})).toContain("ownerId");
      expect(JSON.stringify(c.aggregation.filter ?? {})).toContain("ownerId");
      expect(JSON.stringify(c.list.filter ?? {})).toContain("u1");
      expect(JSON.stringify(c.aggregation.filter ?? {})).toContain("u1");
    } finally {
      await c.close();
    }
  });

  it("an OPERATOR policy reaches both surfaces in the SAME dialect", async () => {
    // The drift this suite exists to catch is not only "did the policy arrive"
    // but "in what dialect". Arc's helpers emit a Mongo-style record (`$or` from
    // `requireGrant`, `$and` from a conjoined conflict); every kit consumes the
    // portable repo-core Filter IR. List normalized at the repository boundary
    // and aggregation did not, so the two handed the kit DIFFERENT shapes — and a
    // flat-equality policy could never reveal it, because flat records pass
    // through the normalizer unchanged.
    //
    // On MongoKit both compiled, so nothing showed. On SQLiteKit / PGKit the raw
    // record's `$or` reads as a literal column name.
    const c = await runAuthorizationConformance({
      permission: () => allow({ policy: { $or: [{ ownerId: "u1" }, { shared: true }] } }),
    });
    try {
      expect(c.list.status).toBe(200);
      expect(c.aggregation.status).toBe(200);
      // Byte-identical, not merely "both mention ownerId".
      expect(c.aggregation.filter).toEqual(c.list.filter);
      // ...and it is the portable IR, not the raw `$` record.
      expect(c.list.filter).toMatchObject({ op: "or" });
      expect(JSON.stringify(c.list.filter)).not.toContain("$or");
    } finally {
      await c.close();
    }
  });

  it("a deny fails BOTH surfaces closed with the same status (repo never reached)", async () => {
    const c = await runAuthorizationConformance({ permission: () => deny("nope") });
    try {
      expect(c.list.status).toBe(c.aggregation.status);
      expect([401, 403]).toContain(c.list.status);
      // Denied → the query filter was never captured (repo not reached).
      expect(c.list.filter).toBeUndefined();
      expect(c.aggregation.filter).toBeUndefined();
    } finally {
      await c.close();
    }
  });
});
