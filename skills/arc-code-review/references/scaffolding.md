# Arc CLI & Scaffolding — what `arc init` and `arc generate` produce

When auditing a project, look for divergence between what `arc generate resource` would have created and what the team actually built. Hand-created files often:
- Skip the `*.repository.ts` layer entirely (Mongoose calls inline in routes).
- Misname files (`product-routes.ts`, `productController.ts` instead of `product.resource.ts`).
- Co-mingle resources in one file, killing tree-shake and `loadResources()` discovery.

---

## `arc init [name] [options]`

```bash
arc init my-api --mongokit --jwt --ts
arc init billing --custom --better-auth --multi
arc init edge-svc --mongokit --jwt --ts --edge
```

| Flag | Meaning | Default if omitted |
|---|---|---|
| `--mongokit` | MongoDB + mongokit repository | (required choice) |
| `--custom` | Custom adapter — template points at the `RepositoryLike` contract from `@classytic/repo-core/adapter`; pick any kit (mongokit, sqlitekit, prismakit, custom) | (required choice) |
| `--jwt` | Arc JWT auth strategy | (required choice) |
| `--better-auth` | Better Auth integration | (required choice) |
| `--single` | Single-tenant template | `--single` |
| `--multi` | Multi-tenant template (org context) | — |
| `--ts` | TypeScript | `--ts` |
| `--js` | JavaScript | — |
| `--edge` | Serverless/edge runtime optimizations | — |
| `--skip-install` | Don't run `npm install` | — |
| `--force` | Overwrite existing dir | — |

**Output structure:**
```
my-api/
├── .arcrc                       # project config for arc generate
├── package.json                 # full deps + devDeps wired (npm install just works)
├── tsconfig.json
├── biome.json
├── .gitignore
├── .env.example
└── src/
    ├── app.ts                   # createApp() entry
    ├── server.ts                # listen()
    ├── resources/               # empty, populated by `arc generate resource`
    └── models/                  # Mongoose schemas (--mongokit only)
```

The scaffold seeds full `dependencies` + `devDependencies` so `npm install` works without the CLI's pre-pass. Audit signal: a project missing `.arcrc` but using arc was likely *not* scaffolded — every file was hand-created and may diverge.

---

## `arc generate resource [name] [options]`

```bash
arc generate resource product
arc generate resource product --mcp --soft-delete
arc generate resource org-profile --bulk --tree
```

Options:
- `--mcp` — emit `{name}.mcp.ts` for custom MCP tools alongside the resource
- `--tree` — wire `tree` preset (parent-child)
- `--soft-delete` — wire `softDelete` preset
- `--bulk` — wire `bulk` preset

**Generated files (mongokit template):**
```
src/resources/product/
├── product.model.ts             # Mongoose schema (with required imports)
├── product.repository.ts        # mongokit Repository or extends Repository<ProductDoc>
├── product.resource.ts          # defineResource() with adapter wired
└── product.mcp.ts               # (--mcp only) extraTools / bridge stubs
```

**Naming convention:**
- Input: kebab-case (`org-profile`).
- File names: `org-profile.model.ts`, `org-profile.repository.ts`, `org-profile.resource.ts`, `org-profile.mcp.ts`.
- Class names: PascalCase (`OrgProfile`, `OrgProfileRepository`).
- Variable names: camelCase (`orgProfile`, `orgProfileRepo`, `orgProfileResource`).

**Audit signal:** files like `productRoutes.ts`, `product-controller.ts`, `productHandlers.js`, `models/Product.js` (no resource file) → not scaffolded; team is fighting arc's conventions.

---

## `.arcrc` — project config

```json
{
  "adapter": "mongokit",
  "auth": "jwt",
  "tenancy": "multi",
  "language": "ts",
  "mcp": true,
  "templates": {
    "resourceDir": "src/resources",
    "modelDir": "src/models"
  }
}
```

Fields:
- `adapter`: `'mongokit' | 'custom'` — controls which template `arc generate resource` uses.
- `auth`: `'jwt' | 'better-auth'` — auth example wiring in templates.
- `tenancy`: `'single' | 'multi'` — multi-tenant adds `multiTenant` preset and scope wiring by default.
- `language`: `'ts' | 'js'`.
- `mcp`: `true | false` — when true, `arc generate resource` always emits `.mcp.ts` (equivalent to `--mcp`).
- `templates.resourceDir` / `modelDir` — override default locations.

Audit: a stale `.arcrc` (e.g., points at deleted dirs) is a sign the team has drifted from CLI scaffolding. Either update or remove.

---

## Other CLI commands

```bash
arc docs ./openapi.json --entry ./dist/index.js
```
Boots the app in introspect mode and emits OpenAPI 3.x to the output path. Wire into `prebuild` or a CI artifact step. Use this in audits to diff against any hand-maintained `swagger.yaml` — discrepancies are bugs in either side.

```bash
arc introspect --entry ./dist/index.js
```
Lists every registered resource: name, route count, presets, permissions summary. Good first command when auditing an unfamiliar codebase.

```bash
arc describe product --entry ./dist/index.js
```
Detail one resource: routes, actions, permissions, field rules, presets, cache config, events. Shows what arc *thinks* the resource is — compare against hand-rolled equivalents.

```bash
arc doctor
```
Diagnose env (Node version, TS version, peer dep versions). Run before audit to confirm environment is sane.

---

## Resource file structure (canonical)

`src/resources/{name}/{name}.resource.ts`:

```typescript
import { defineResource, requireRoles, allowPublic, fields } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';   // arc 2.12+
import { Repository, buildCrudSchemasFromModel } from '@classytic/mongokit';
import { Product } from './product.model.js';

const productRepo = new Repository(Product);

export const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  module: 'catalog',
  adapter: createMongooseAdapter({ model: Product, repository: productRepo, schemaGenerator: buildCrudSchemasFromModel }),
  presets: ['softDelete'],
  permissions: {
    list:   allowPublic(),
    get:    allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  schemaOptions: {
    fieldRules: {
      name:  { type: 'string', minLength: 1, required: true },
      price: { type: 'number', minimum: 0, required: true },
      slug:  { type: 'string', readonly: true },
      deletedAt: { type: 'date', nullable: true, hidden: true },
    },
  },
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },
});

export default productResource;
```

`loadResources(import.meta.url)` discovers:
- `default` export (`export default productResource`)
- `export const resource`
- Any named export with `.toPlugin()`

Works with relative imports + Node `#` subpath imports — **NOT** tsconfig path aliases (`@/*`). See [anti-patterns.md §30](anti-patterns.md).

---

## Audit checks against scaffolding output

When you walk a client repo, compare against this baseline:

| Expected | Found | Implication |
|---|---|---|
| `.arcrc` at project root | missing | Team didn't scaffold — likely diverged conventions |
| `src/resources/{name}/{name}.resource.ts` | `src/routes/{name}.ts` | Hand-rolled — flag for §3 (manual CRUD) |
| `src/resources/{name}/{name}.repository.ts` extends `Repository` | `class FooRepository` with `Model.find` directly | Mongokit not adopted — flag for §28 |
| `src/app.ts` calls `createApp({ resources: [...] })` | manual `app.register(productPlugin)` per resource | Not using arc factory — possible boot-order issues |
| `src/resources/{name}/{name}.mcp.ts` (if `.arcrc` has `mcp: true`) | missing | MCP feature mentioned but not wired |
| `package.json` script `"docs:openapi": "arc docs ..."` | hand-maintained `openapi.yaml` | Out-of-band spec — flag for §6 |
| `npm run smoke` (CLI + subpath imports) | missing | No release gate — recommend wiring |

---

## Smoke commands worth running during audit

```bash
# Confirm arc + mongokit + sqlitekit + repo-core versions
npm ls @classytic/arc @classytic/mongokit @classytic/sqlitekit @classytic/repo-core

# List all defineResource calls
grep -rn "defineResource(" src/

# List all manual fastify routes
grep -rnE "fastify\\.(get|post|patch|put|delete)\\(" src/

# Find driver imports outside adapter dirs
grep -rln "from 'mongoose'\\|from '@prisma/client'\\|from 'drizzle-orm'" src/ \
  | grep -v 'adapter\\|\\.model\\.'

# Check for hand-rolled toJSON
grep -rn "schema.set('toJSON'\\|toJSON = function" src/

# Count manual permission checks
grep -rcE "user\\.role|roles\\.includes|throw.*(Unauthorized|Forbidden)" src/

# Verify OpenAPI source of truth
ls -la openapi.* swagger.* api-spec.* 2>/dev/null

# Check arc CLI is wired
grep -E "arc (init|generate|docs)" package.json
```

Use the counts to fill in the per-resource scorecard in the SKILL.md report template.
