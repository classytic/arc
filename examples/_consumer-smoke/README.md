# Arc Consumer Smoke Test

End-to-end test that installs `@classytic/arc` via `file:../..` (the actual built `dist/`)
and verifies the public API works for a real external consumer.

This catches bugs that in-repo vitest tests miss because vitest runs against `src/`
directly (transform layer) instead of the published artifact.

## Run

```bash
# From arc repo root, after `npm run build`:
cd examples/_consumer-smoke
npm install
npm test
```

## What it tests

- `loadResources(import.meta.url)` discovers `*.resource.ts` files
- `default export defineResource(...)` convention
- `createApp({ resourcePrefix, resources, plugins })`
- `skipGlobalPrefix: true` per-resource opt-out
- `audit: true` per-resource opt-in
- Nested query operators (`?price[gte]=10&price[lte]=200`)
- Full CRUD via real HTTP inject

This is part of the prepublish smoke chain — see `scripts/smoke-test.mjs`.
