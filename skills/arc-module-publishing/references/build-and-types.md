# Build and public types

## tsdown.config.ts

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/contract.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  treeshake: true,
  target: "node22",
  outDir: "dist",
  publint: { level: "error" },
  attw: { profile: "esm-only" },
  deps: { neverBundle: true },
});
```

| Key | Why |
|---|---|
| `format: ["esm"]` | arc is ESM only |
| `deps.neverBundle: true` | arc, primitives, repo-core and kits stay external, so the host runs one copy |
| `publint`, `attw` with `level: "error"` | a broken exports map or unresolvable declaration fails the build |
| one `entry` per exported subpath | `exports` must point at files that exist |

Two copies of arc mean two plugin registries and two scope decorators: they diverge. Inlining any `@classytic/*` package causes it.

## Public surface only

```ts
import type { PermissionCheck } from "@classytic/arc/permissions";
import { getOrgId, requireOrgId } from "@classytic/arc/scope";
import type { ActionDefinition, RequestWithExtras } from "@classytic/arc/types";
import { createDomainError, NotFoundError } from "@classytic/arc/utils";
```

If a symbol is not on a public subpath, file it against arc. Deep imports break when arc reorganizes internals.

## Optional-peer types stay out of d.mts

A type from an optional peer in your public signature breaks hosts that did not install it. Describe the shape you need with a local interface.

```ts
export interface StandardSchemaLike<T> {
  readonly "~standard": { validate: (v: unknown) => { value: T } | { issues: unknown[] } };
}
export function withValidation<T>(schema: StandardSchemaLike<T>): void { /* ... */ }
```

## Schemas you ship

| Choice | Result |
|---|---|
| JSON Schema object (`type`, `properties`, `additionalProperties: false`) | no zod peer needed; AJV validates |
| zod v4 schema | declare `zod` as a peer (`>=4`) and a `^4` devDep; add `parse: true` so the handler gets the parsed value |
| Empty body | `noPayloadSchema` from `@classytic/arc/core` |

A shipped action `schema` is the body schema itself. `{ body: X }` validates nothing.

## Structural ports

A repository the package calls is an interface listing only the methods used. Any kit repository satisfies it, so the package never imports a kit.

```ts
export interface SubjectRepository<TDoc> {
  getById(id: string, o: { organizationId?: string; throwOnNotFound: false; lean: true }): Promise<TDoc | null>;
  update(id: string, patch: Record<string, unknown>, o: { organizationId?: string; lean: true }): Promise<TDoc | null>;
}
```
