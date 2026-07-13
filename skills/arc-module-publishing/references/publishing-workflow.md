# Publishing workflow

Monorepo layout, the release gates, and the classytic bot-identity publish steps.

---

## Monorepo layout (npm workspaces)

Prefer **one workspace holding many small packages** over one repo per package — they release
together and share tooling. The `@classytic/arc-ecosystem` layout:

```
arc-ecosystem/
  package.json                 # workspaces: ["packages/*"], shared devDeps, verify script
  scripts/
    check-peer-skew.mjs        # gate: every peer floor covered by a devDep floor
    prepublish-gate.mjs        # per-package publish gate
  packages/
    arc-approval/              # @classytic/arc-approval — one package, one surface
      package.json
      tsdown.config.ts
      src/index.ts
    arc-involvement/
    arc-notifications/
```

Root `package.json` scripts:

```jsonc
{
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "typecheck": "npm run typecheck --workspaces",
    "lint": "biome check packages/",
    "test": "vitest run",
    "check:peer-skew": "node scripts/check-peer-skew.mjs",
    "verify": "npm run check:peer-skew && npm run typecheck && npm run lint && npm run test && npm run build"
  }
}
```

Shared devDeps (arc, primitives, biome, tsdown, typescript, vitest, fastify, @types/node) live
in the **root** `package.json` so every package tests against one aligned set. During
pre-publish development the root can carry `"@classytic/arc": "file:../arc"` to test against
unreleased arc; **switch it to the published range (`"^2.20.0"`) once arc ships** and reinstall
so packages resolve arc from the registry tarball, not the local symlink.

**pnpm + turborepo + changesets** is the heavier-duty alternative to npm workspaces once the
package count grows: turbo gives cached, topo-ordered builds (`dependsOn: ["^build"]`);
changesets drive versioning + changelogs (`access: "public"`, `updateInternalDependencies:
"patch"`). Wire the peer-skew gate into the release path so it can't be skipped — e.g.
`"release": "pnpm run check:peer-skew && turbo typecheck test build && changeset publish"`.
Local workspace links use `workspace:*` (pnpm) instead of `file:`; the peer-skew gate treats
`workspace:` / `link:` / `file:` as covering any floor (the checked-out source *is* the version
under development).

### Supply-chain hygiene (.npmrc / pnpm-workspace.yaml)

Belt-and-suspenders settings worth adopting for a published ecosystem:

```ini
# .npmrc
auto-install-peers=false     # peers are the HOST's duty — never silently fetch them
save-workspace-protocol=rolled
```

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:       # allowlist packages permitted to run install scripts
  - esbuild
  - mongodb-memory-server
minimumReleaseAgeExclude:    # cooldown on brand-new registry versions, with explicit escapes
  - '@classytic/repo-core@0.7.0'
```

- `auto-install-peers=false` enforces the contract mechanically: if a host forgets a peer, they
  get an error, not a silently-resolved wrong version. It also stops your *dev* environment from
  masking a missing peer declaration.
- `onlyBuiltDependencies` is a lifecycle-script allowlist — nothing runs `postinstall` unless you
  named it. A cheap, real guard against a compromised transitive dep executing on `pnpm install`.
- A `minimumReleaseAge` cooldown blunts the "malicious version published minutes ago" attack;
  the `Exclude` list is your escape hatch for versions you've vetted.

---

## Gate 1 — peer-skew (monorepo)

`scripts/check-peer-skew.mjs` fails the build if any package declares a peer floor higher than
the devDep floor it actually tests against. Without it, a package can claim `">=2.20.0"` while
its suite runs against 2.18 — a lie that ships. The gate reads root + package devDeps together
(`file:` links count as covering any floor, since the link *is* the version under development).

```js
// Core check, per package, per peer:
//   devFloor = floorOf(devDeps[name])         // from root + package devDeps merged
//   peerFloor = floorOf(peers[name])
//   if (devFloor < peerFloor) FAIL            // suite tests below what you promise
// Optional peers (peerDependenciesMeta.optional) with no devDep are allowed to be absent.
```

Run it first in `verify` so a skew fails fast before the slower typecheck/test/build.

---

## Gate 2 — prepublish (per package)

No package publishes without a green gate. No `--no-verify`, ever.

- **Solo package:** `"prepublishOnly": "npm run typecheck && npm run lint && npm run test && npm run build"`.
- **Workspace:** a shared `scripts/prepublish-gate.mjs` invoked from each package's
  `prepublishOnly`, running the full workspace `verify` (peer-skew + typecheck + lint + test +
  build) so no package ships against a skewed or broken tree.

The gate is the contract with consumers: if it's green, the published `dist/` was typechecked,
linted, tested, and built from the source in the same commit.

---

## Release — classytic packages (bot identity)

Every commit in a classytic package is authored as **`classytic-bot[bot]`** — the maintainer
identity, never an individual. **Per-invocation git env vars only; never `git config
--global`; no `Co-Authored-By` trailers.**

```bash
GIT_AUTHOR_NAME="classytic-bot[bot]" \
GIT_AUTHOR_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
GIT_COMMITTER_NAME="classytic-bot[bot]" \
GIT_COMMITTER_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
git commit -m "feat(arc-x): …"
```

Push through `@classytic/dev-tools` so the commit and pusher both carry the `[bot]` badge (it
mints a short-lived GitHub App installation token, pushes, and never persists it):

```bash
npm run push -- main         # push current work to main
```

Publish to **public npm** (`publishConfig.access: "public"` is already set):

```bash
npm publish -w @classytic/arc-<domain>   # prepublishOnly gate runs automatically
```

Third-party (non-classytic) packages: normal git identity, same gates and same
public/scoped-npm publish — only the bot identity and `classytic-push` are classytic-specific.

---

## Versioning a public export

SemVer the **contract**, not the internals:

| Change | Bump |
|---|---|
| New optional config field, new exported helper, new action | **minor** |
| Raising a peer floor (e.g. now requires arc ≥2.21) | **minor** (it narrows the host set) |
| Changing an exported function signature, removing an export, renaming an action/field | **major** |
| Internal refactor, dep bump within range, doc/test-only | **patch** |

The `ArcModule` shape you return, your exported function signatures, and your action/schema
surface are the contract consumers pin against. Internals (private helpers, how the engine is
built) are free to change under a patch.

---

## Common publish failures (and the fix)

- **Peer written as `^` instead of `>=`** → blocks hosts on a newer major that still satisfies
  your API. Fix: `">=X.Y.0"`.
- **arc/fastify in `dependencies`** → host gets a bundled duplicate; plugin registry splits.
  Fix: move to `peerDependencies`.
- **Optional-peer types in `dist/*.d.mts`** → hosts without that peer fail to compile your
  package. Fix: structural typing at the public boundary (see package-manifest.md).
- **Deep import (`@classytic/arc/src/...`)** → breaks on any arc internal reorg. Fix: use a
  public subpath, or file the missing export against arc.
- **A back-edge: arc depending on your package** → un-publishable cycle. Fix: the abstraction
  belongs in arc as a port/hook, not as a dependency on you.
- **Skewed devDep below peer floor** → suite tests a version you claim to support but don't.
  Fix: raise the devDep, reinstall, re-run peer-skew.
