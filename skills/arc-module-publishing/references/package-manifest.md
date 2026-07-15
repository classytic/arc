# package.json + tsdown reference

Copy-paste manifest for an arc ecosystem package, plus the dependency-field rules and the
optional-peer typing pattern. Values below are the real shapes shipped by
`@classytic/arc-approval` — adapt names, keep the structure.

---

## package.json

```jsonc
{
  "name": "@classytic/arc-<domain>",
  "version": "0.1.0",
  "description": "<one line — what this contributes to an arc host>",
  "type": "module",

  // Public entry. Add subpaths ("./adapter", "./testing") the same way if you split surfaces.
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "default": "./dist/index.mjs"
    }
  },
  "main": "./dist/index.mjs",
  "types": "./dist/index.d.mts",

  "sideEffects": false,       // pure ESM, tree-shakable — no import-for-effect modules
  "files": ["dist"],          // ship only build output; never src/, tests/, configs
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=22" },

  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "prepublishOnly": "npm run typecheck && npm run lint && npm run test && npm run build"
  },

  // CONTRACTS — what the host must provide. `>=`, never `^`.
  // Floor >=2.21.0 if you use ResourceSeams / mergeResourceConfig / permissionMatrix /
  // schedulesPlugin / errorMappers — declare the floor that matches the APIs you import.
  "peerDependencies": {
    "@classytic/arc": ">=2.21.0",
    "@classytic/primitives": ">=0.9.0"
  },

  // Optional peers: declared here AND marked optional below. Host installs only if used.
  // "peerDependencies": { ..., "zod": ">=3.23.0", "ioredis": ">=5.0.0" },
  // "peerDependenciesMeta": {
  //   "zod": { "optional": true },
  //   "ioredis": { "optional": true }
  // },

  // TEST versions — pin with ^, floor >= each peer floor. Not shipped.
  "devDependencies": {
    "@classytic/arc": "^2.21.0",
    "@classytic/primitives": "^0.9.1",
    "@biomejs/biome": "^2.5.2",
    "@types/node": "^22.19.21",
    "tsdown": "^0.22.5",
    "typescript": "^7.0.2",
    "vitest": "^4.1.9"
  },

  "keywords": ["arc", "fastify", "<domain>", "classytic"],
  "license": "MIT",
  "author": "Classytic",
  "repository": { "type": "git", "url": "https://github.com/classytic/arc-ecosystem.git", "directory": "packages/arc-<domain>" }
}
```

In an **npm workspace**, devDeps common to all packages hoist to the root `package.json`; a
package only lists devDeps unique to it. The peer-skew gate reads root + package devDeps
together (see publishing-workflow.md).

---

## Dependency-field cheat sheet

| Field | What goes here | Range style | Why |
|---|---|---|---|
| `dependencies` | (usually nothing) truly-private bundled helpers only | `^` | Ships with you; host can't override. Almost never needed. |
| `peerDependencies` | arc, fastify, primitives, kits, zod, ioredis | **`>=`** | A contract/floor. Host resolves the real version; don't block their upgrades. |
| `peerDependenciesMeta` | mark optional peers `{ optional: true }` | — | Host installs only if they use that path. |
| `devDependencies` | concrete versions your tests run against | `^` | The version you actually exercise; floor must be `>=` peer floor. |

**The trap:** putting `@classytic/arc` or `fastify` in `dependencies`, or writing a peer as
`^2.20.0`. Both force the host into *your* version choice. A published arc package makes as
few decisions for the host as possible — it states floors and gets out of the way.

---

## tsdown.config.ts

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],   // add entries for extra subpaths: ["src/index.ts", "src/adapter.ts"]
  format: ["esm"],           // ESM only — arc is ESM only
  dts: true,                 // emit .d.mts
  sourcemap: false,
  clean: true,
  treeshake: true,
  target: "node22",
  outDir: "dist",
  deps: {
    // Bundle NOTHING — same never-bundle contract as arc's own tsdown config.
    skipNodeModulesBundle: true,
    neverBundle: [/^@classytic\//],
  },
});
```

Why bundle nothing: if you inline `@classytic/arc` (or primitives, or a kit), the host ends up
with two copies — yours frozen in `dist/`, theirs in `node_modules`. Arc's plugin registry,
event transport, and scope decorators are identity-sensitive; two copies register twice and
diverge. `neverBundle: [/^@classytic\//]` guarantees the host's single installed copy is the
only one at runtime.

---

## Optional peers: keep their types out of your public surface

If a peer is optional (a host might not install it), its types **must not** appear in your
published `.d.mts` — otherwise a host without it gets a compile error importing your package.
Use structural typing: describe the shape you need with a local interface, don't import the
dependency's types into the public boundary.

```ts
// ❌ leaks zod into dist/index.d.mts — breaks hosts that didn't install zod
import type { ZodType } from "zod";
export function withValidation(schema: ZodType) { /* ... */ }

// ✅ structural: the public signature owes nothing to zod's package
export interface StandardSchemaLike<T> {
  readonly "~standard": { validate: (v: unknown) => { value: T } | { issues: unknown[] } };
}
export function withValidation<T>(schema: StandardSchemaLike<T>) { /* ... */ }
```

For **shipped action/route schemas, use JSON Schema**, not zod objects. Arc converts JSON
Schema natively; zod stays an *optional* convenience peer for hosts that prefer it. A package
that hard-requires zod for its schemas has made zod a non-optional dependency by the back door.

```ts
schema: {
  type: "object",
  required: ["stepId", "decision"],
  properties: {
    stepId: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["approved", "rejected"] },
  },
  additionalProperties: false,
}
```
