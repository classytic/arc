# Ecosystem extraction — approval + involvement (executed pre-2.20 publish)

Internal record (v3.md precedent). Not shipped in the npm package.

**Status: DONE 2026-07-05, in the 2.20 wave.** `withApprovalChain` and the
involvement scoping helpers were extracted to the `arc-ecosystem` workspace
BEFORE arc 2.20 published. The `./presets/approval` + `./presets/involvement`
subpaths never shipped in any published arc version — no deprecation window,
no `wiki/removed.md` entry, no dual-home period.

## Where things live

| | |
|---|---|
| Workspace | `d:\projects\classytic\arc-ecosystem` (npm workspaces; own verify gate: peer-skew + typecheck + biome + vitest + tsdown) |
| `@classytic/arc-approval` 0.1.0 | `withApprovalChain`, ports, `CanActAsApprover`, `delegateForRoles` (upstreamed from be-prod's `platformAdminMayDelegate`). Peers: `arc >=2.20`, `primitives >=0.9` |
| `@classytic/arc-involvement` 0.1.0 | `resolveInvolvementScope`, `involvementListScope` (header option, base-filter composition). Peer: `arc >=2.20` |

Both packages carry the full 2.20 hardening: actor-derived decision identity
(403 `approval.approver_mismatch` on spoofed `approverId`), `tenancy` /
`provenance` contracts, involvement filter composition (`$and` on key
collision), configurable org header.

## Why extraction landed in 2.20, not 2.21

The earlier plan (ship in core for one release, deprecate in 2.21, drop in
2.22) optimized for not touching be-prod/hotel mid-wave. But 2.20 was still
unpublished — shipping a subpath already scheduled for deletion would have
knowingly published dead API surface. Removing before first publish is
strictly cleaner: consumers swap one import line in the same wave they were
already re-gating for.

## Design rules the workspace enforces

- Packages import arc's PUBLIC subpaths only (`/permissions`, `/scope`,
  `/types`, `/utils`) — `@classytic/arc` resolves via `file:../arc` (dev) or a
  registry range, so arc's `src/` is unreachable by construction.
- arc NEVER depends on arc-\* packages — one-way dependency.
- Bundle nothing: tsdown `skipNodeModulesBundle` + `neverBundle: [/^@classytic\//]`.
- Library-shipped action schemas are plain JSON Schema (zod is an optional arc
  peer); hosts may author zod — arc's Schema IR converts either dialect.
- Domain packs ship as `@classytic/arc-*` ecosystem packages composed via
  modules (wiki/modules.md naming grid) — never as new core subpaths.

## Consumer migration (same wave)

| Old (never published) | New |
|---|---|
| `import { withApprovalChain } from "@classytic/arc/presets/approval"` | `import { withApprovalChain } from "@classytic/arc-approval"` |
| `import { involvementListScope } from "@classytic/arc/presets/involvement"` | `import { involvementListScope } from "@classytic/arc-involvement"` |
| be-prod `platformAdminMayDelegate` shim | `delegateForRoles(["admin", "superadmin"])` from `@classytic/arc-approval` |

## Remaining before the packages hit 1.0

- arc-approval: `ApprovalEvaluationContext` → fully host-defined `TEvalCtx`
  generic (drop `branchId` from the base type; be-prod re-adds it in its own
  context type).
- arc-involvement: non-Mongo `$or` conformance test (sqlitekit devDep — a kit
  must fold the policy filter or REJECT it, never drop it).
- Naming review: "involvement" vs "party-scope".
- Create the `classytic/arc-ecosystem` GitHub repo; first publish rides the
  2.20 wave (packages peer on `arc >=2.20.0`, so publish arc first).
