# Publishing workflow

## Workspace layout (npm workspaces)

One workspace holds many small packages that release together and share tooling.

```
arc-ecosystem/
  package.json            workspaces: ["packages/*"], shared devDeps, verify script
  scripts/
    check-peer-skew.mjs         every peer floor covered by a devDep floor
    check-identity-sources.mjs  identity read only through request.scope
    prepublish-gate.mjs         per-package prepublishOnly, runs root verify
  packages/arc-<domain>/{package.json,tsdown.config.ts,src/,tests/}
```

Root scripts:

```jsonc
{
  "scripts": {
    "build": "npm run build --workspaces",
    "typecheck": "npm run typecheck --workspaces",
    "lint": "biome check packages/",
    "test": "vitest run",
    "check:peer-skew": "node scripts/check-peer-skew.mjs",
    "verify": "npm run check:peer-skew && npm run check:identity && npm run typecheck && npm run lint && npm run test && npm run build",
    "push": "classytic-push",
    "release:<pkg>": "npm run verify && npm publish -w @classytic/arc-<pkg>"
  }
}
```

The arc devDep is a registry range, so packages resolve the published tarball. To co-develop arc locally, temporarily point the root devDep at `file:../arc`; the peer-skew gate treats `file:` as covering any floor.

## Gates

| Gate | Fails when |
|---|---|
| peer-skew | a peer floor is above the devDep floor the suite runs |
| identity | code reads `req.user.*` or `x-user-id` instead of `request.scope` accessors |
| typecheck, lint, test, build | any; build also runs publint and attw |
| `prepublishOnly` | runs the full workspace `verify`; never bypass |

A solo package puts `npm run typecheck && npm run lint && npm run test && npm run build` in `prepublishOnly`.

## Release (classytic packages)

Commits are authored as `classytic-bot[bot]` with per-invocation environment variables. Never run `git config --global`, never add `Co-Authored-By`.

```bash
GIT_AUTHOR_NAME="classytic-bot[bot]" \
GIT_AUTHOR_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
GIT_COMMITTER_NAME="classytic-bot[bot]" \
GIT_COMMITTER_EMAIL="278929599+classytic-bot[bot]@users.noreply.github.com" \
git commit -m "feat(arc-x): add flag action"

npm run push -- main              # classytic-push: short-lived app token, never persisted
npm run release:<pkg>             # verify, then npm publish -w (public access)
```

Third-party packages use their own git identity; the gates and public npm publish are the same.

## Versioning the public export

SemVer the contract, not the internals: exported signatures, the `ArcModule` you return, and the action and schema surface.

| Change | Bump |
|---|---|
| New optional config field, helper or action | minor |
| Raise a peer floor | minor |
| Change or remove an export, rename an action or field | major |
| Internal refactor, dep bump inside range, docs or tests | patch |

## Common publish failures

| Symptom | Fix |
|---|---|
| Peer written `^` | `>=` floor |
| arc or fastify in `dependencies` | move to `peerDependencies` |
| Optional-peer type in `dist/*.d.mts` | structural type at the boundary |
| Deep import of arc internals | public subpath, or request the export |
| arc depends on the package | move the port or hook into arc |
| devDep below peer floor | raise the devDep, reinstall, rerun peer-skew |
| Uses a newer arc helper than the floor | raise the peer floor |
| Hand-rolled helper that repo-core or arc already ships | search `@classytic/repo-core` and `@classytic/arc` first |
