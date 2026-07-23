# Governance — API stability, support, and release policy

This document is the compatibility contract consumers can plan against.
It describes the policy that is actually enforced by tooling, not an
aspiration.

## API stability tiers

Every package subpath carries a stability label in `package.json` under
`arc.subpathStability`, enforced by a contract test (exact coverage — an
unlabelled subpath fails CI) and by the public API surface gate:

| Tier | Meaning | Enforcement |
|---|---|---|
| `stable` | The exported surface only grows within a major-policy window. **Removing or renaming an export — or changing declaration content (signatures, optionality, generics) — fails `check:api-surface`** unless the snapshot is updated intentionally in the same change with a ⚠ changelog entry and migration note. | `scripts/check-api-surface.mjs`: independent runtime/type name diffs + a declaration content hash, against the committed `api-surface.json` (runs in `prepublishOnly` and CI). |
| `beta` | Usable in production; surface may change between minors with a changelog entry. Removals are reported but do not fail the gate. | Surface diff reported as informational. |
| `experimental` | No compatibility promise. May change or disappear in any release. | Labelled; excluded from breaking-gate failures. |

The authoritative tier of any subpath is the label in `package.json`, not
this table. Current experimental subpaths: `./sync`, `./usage`,
`./integrations/event-gateway`.

## Versioning policy (pre-3.0)

- Arc is pre-3.0 with a deliberately small consumer base. **Breaking
  changes may land in MINOR releases**, always with:
  - a ⚠-marked changelog entry in `changelog/v2.md` including a concrete
    migration note;
  - an intentional `api-surface.json` update in the same change (for
    surface removals on stable subpaths);
  - a deprecation window of at least one minor release where feasible —
    hard security fixes may skip it (the changelog says so when they do).
- Patch releases are fixes only — never surface removals.
- The declared wire contracts (`ErrorContract`, `IControllerResponse`,
  the webhook v1 signing contract, the repo-core repository/cache/lock
  contracts) change only with a ⚠ entry and a migration path.

## Type behavior is public API

Types are enforced in their own compile lane: `npm run typecheck` runs
both `typecheck:src` (source) and `typecheck:types`
(`tsconfig.types.json` — the type-assertion suites in `tests/types/` and
`*.test-d.ts` contract files, compiled by `tsc`, not transpiled by the
test runner). Narrowing a public type is a breaking change and follows
the same policy as a surface removal.

## Supported versions

- **Runtime:** Node.js ≥ 22 (`engines`), ESM only. No CJS entry points —
  CommonJS consumers use dynamic `import()`.
- **Peers:** minimum supported versions are the `peerDependencies`
  floors; `check:peer-skew` keeps devDependencies honest against them.
- **Releases:** the latest published minor receives fixes. Older minors
  receive security fixes only when upgrading is non-trivial for known
  consumers.

## Release gate

`npm publish` runs `prepublishOnly`: peer-skew → docs-drift →
dependency-boundary graph → both typecheck lanes → lint → build → public
API surface diff → package-standard checks (`publint` +
`@arethetypeswrong/cli`, esm-only profile) → full test suite + isolated
perf lane → clean external consumer install-and-run smoke. No
`--no-verify`, ever.

## Ownership

Arc is maintained by the classytic org; maintenance commits are authored
by the org's bot identity and land through the gated push flow. Security
reports: see [SECURITY.md](SECURITY.md). Contributions: see
[CONTRIBUTING.md](CONTRIBUTING.md).
