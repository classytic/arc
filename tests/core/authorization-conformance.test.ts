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
  it("a policy-bearing allow scopes ALL surfaces (list, get-by-id, aggregation) with the SAME policy", async () => {
    const c = await runAuthorizationConformance({
      permission: () => allow({ policy: { ownerId: "u1" } }),
    });
    try {
      expect(c.list.status).toBe(200);
      expect(c.get.status).toBe(200);
      expect(c.aggregation.status).toBe(200);
      // The row policy reached the repository on EVERY surface, identically.
      for (const surface of [c.list, c.get, c.aggregation]) {
        expect(JSON.stringify(surface.filter ?? {})).toContain("ownerId");
        expect(JSON.stringify(surface.filter ?? {})).toContain("u1");
      }
    } finally {
      await c.close();
    }
  });

  it("observes the get surface on the POLICY-FREE path too (plain by-id read)", async () => {
    /**
     * The single-record read has two paths: `fetchDetailed` compounds a filter and calls `getOne`
     * only when there IS something to compound (policy, tenant field, non-default id field), and
     * takes a plain `getById` otherwise. Every other case in this file carries a policy, so the
     * plain path went unexercised — and the harness's mock left `getById` returning null, which made
     * the `get` surface report **404 for any policy-free allow** while list and aggregation said 200.
     *
     * That is indistinguishable from partial enforcement, which is precisely what this suite exists
     * to detect, so the harness was manufacturing the signal it is meant to measure. Reported from a
     * host (be-prod) pairing its deny-parity suite with the obvious falsification case: assert an
     * `allowPublic()` gate reaches all three surfaces.
     */
    const c = await runAuthorizationConformance({ permission: () => allow() });
    try {
      expect(c.list.status).toBe(200);
      expect(c.get.status).toBe(200);
      expect(c.aggregation.status).toBe(200);
      // No policy to compound, so the compound path was never taken — documented, not a defect.
      expect(c.get.filter).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  it("get-by-id CONJOINS the policy with the route id — a policy can't redirect the target", async () => {
    // The single-record surface where the filter-overwrite class lived: a policy
    // pinning a DIFFERENT id must not replace the route's `/confs/1`. Both survive
    // (conjunction), so the compound carries id "1" AND the policy's "A".
    const c = await runAuthorizationConformance({
      permission: () => allow({ policy: { _id: "A" } }),
    });
    try {
      expect(c.get.status).toBe(200);
      const serialized = JSON.stringify(c.get.filter ?? {});
      expect(serialized).toContain("1"); // the route id survives
      expect(serialized).toContain("A"); // the policy is conjoined, not dropped
      expect(c.get.filter).not.toEqual({ _id: "A" }); // did NOT overwrite the route id
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
      expect(c.get.status).toBe(c.aggregation.status);
      expect([401, 403]).toContain(c.list.status);
      // Denied → the query filter was never captured on ANY surface (repo not reached).
      expect(c.list.filter).toBeUndefined();
      expect(c.get.filter).toBeUndefined();
      expect(c.aggregation.filter).toBeUndefined();
    } finally {
      await c.close();
    }
  });
});
