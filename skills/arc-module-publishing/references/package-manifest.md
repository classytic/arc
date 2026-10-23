# package.json for an arc package

## Manifest

```jsonc
{
  "name": "@classytic/arc-<domain>",
  "version": "0.1.0",
  "description": "<what this contributes to an arc host>",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
    "./contract": { "types": "./dist/contract.d.mts", "default": "./dist/contract.mjs" }
  },
  "main": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "sideEffects": false,
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "test": "vitest run",
    "prepublishOnly": "node ../../scripts/prepublish-gate.mjs"
  },
  "peerDependencies": {
    "@classytic/arc": ">=2.46.0",
    "@classytic/primitives": ">=0.31.0",
    "zod": ">=4.1.0"
  },
  "devDependencies": {
    "zod": "^4.4.0"
  },
  "license": "MIT",
  "author": "Classytic",
  "repository": { "type": "git", "url": "git+https://github.com/classytic/arc-ecosystem.git", "directory": "packages/arc-<domain>" }
}
```

Solo package (no workspace gate): `"prepublishOnly": "npm run typecheck && npm run lint && npm run test && npm run build"`.

## Dependency fields

| Field | Holds | Range |
|---|---|---|
| `dependencies` | nothing, or a private helper the host must never control | `^` |
| `peerDependencies` | `@classytic/arc`, `@classytic/primitives`, `@classytic/repo-core`, kits, `fastify`, `zod` | `>=` floor, no upper bound |
| `peerDependenciesMeta` | `{ "<name>": { "optional": true } }` for peers only some hosts use | none |
| `devDependencies` | the versions the test suite runs against | `^`, floor at or above the peer floor |

## Floor rules

- The arc peer floor is the version of the newest arc feature you import. Adopting a newer helper without raising the floor ships a package that throws on the version it claims to support.
- A peer is a contract, not a pin: `>=` lets hosts upgrade without waiting on your release.
- Never cap `@classytic/primitives` or `@classytic/repo-core` (`<0.14.0`): a cap makes sibling packages uninstallable.
- A floor your suite never runs against is a claim, not a fact. Keep the devDep at or above every peer floor.
- Raising a peer floor narrows the host set: ship it as a minor.

## Optional peers

An optional peer (`ioredis`, a kit) is listed in `peerDependencies` and marked optional in `peerDependenciesMeta`. Keep its types out of the public `.d.mts`: see references/build-and-types.md.

## Subpaths

Add `exports` entries for each public surface (`./contract`, `./events`, `./testing`) and one `entry` per subpath in tsdown. Hosts import only these; everything else is internal.

## Workspace

In an npm workspace, shared devDeps (arc, primitives, repo-core, mongokit, fastify, biome, tsdown, typescript, vitest, mongodb-memory-server, mongoose) live in the root `package.json`; a package lists only its own. The peer-skew gate reads root plus package devDeps together.
