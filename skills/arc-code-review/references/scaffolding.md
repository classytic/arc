# Arc CLI and scaffolding

A project scaffolded by `arc init` and extended by `arc generate` has a recognizable shape. Divergence from it is an audit signal.

## Commands

```bash
arc init my-api --mongokit --jwt --single --ts
arc init billing --mongokit --better-auth --multi
arc generate resource product --mcp
arc g r invoice
arc introspect ./dist/index.js
arc describe ./dist/index.js --json
arc docs ./dist/index.js openapi.json
arc doctor
```

| Command | Use in an audit |
|---|---|
| `arc introspect <entry>` | list every registered resource, first command on an unfamiliar repo |
| `arc describe <entry> --json` | per resource: routes, actions, permissions, field rules, presets, cache, events; compare with hand-rolled equivalents |
| `arc docs <entry> [out.json]` | OpenAPI from the registered resources; diff against a hand-kept spec |
| `arc doctor` | environment and peer checks; exits 1 on hard failures |

`arc init` flags: `--mongokit` or `--custom` (adapter), `--jwt` or `--better-auth` (auth), `--single` or `--multi` (tenancy), `--ts` or `--js`, `--edge`, `--api-key`, `--session cookie|bearer|both`, `--docker`, `--skip-install`, `--force`.

`arc generate <resource|controller|model|repository|schemas|mcp> <name>`: aliases `g`, `r`, `c`, `m`, `repo`, `s`. The name is kebab-case; `--mcp` also emits the MCP file.

## Generated layout

```
src/resources/<name>/
  <name>.model.ts
  <name>.repository.ts
  <name>.resource.ts
  <name>.mcp.ts          (with --mcp)
```

`arc init` also writes `.arcrc` (`adapter`, `auth`, `tenant`, `typescript`), `src/app.ts`, `src/index.ts`, and an agent guidance `CLAUDE.md`. Names: `org-profile` becomes class `OrgProfile`, variable `orgProfile`, files `org-profile.*.ts`.

## Canonical resource file

```ts
import { allowPublic, defineResource, requireRoles } from "@classytic/arc";
import { createRepository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { Product } from "./product.model.js";

const productRepo = createRepository(Product, { softDelete: true, timestamps: true });

export const productResource = defineResource({
  name: "product",
  displayName: "Products",
  module: "catalog",
  adapter: createMongooseAdapter(Product, productRepo),
  presets: ["softDelete"],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(["admin"]),
    update: requireRoles(["admin"]),
    delete: requireRoles(["admin"]),
  },
  cache: { staleTime: 30, gcTime: 300, tags: ["catalog"] },
});
```

`loadResources(import.meta.url)` discovers the default export, `export const resource`, or any named export with `.toPlugin()`. Discovery uses Node's resolver: relative imports and `#` subpath imports work, tsconfig path aliases do not.

## Audit checks against the scaffold

| Expected | Found | Meaning |
|---|---|---|
| `.arcrc` in the root | missing | not scaffolded; conventions may have diverged |
| `src/resources/<n>/<n>.resource.ts` | `src/routes/<n>.ts`, `*Controller.ts` | hand-rolled CRUD (R1) |
| `<n>.repository.ts` built with `createRepository` | `class FooRepository` over `Model.find` | mongokit not adopted (D2) |
| `createApp({ resources })` | `app.register(productPlugin)` per resource | arc factory bypassed; boot order risk |
| `.mcp.ts` when MCP is enabled | missing | MCP claimed but not wired |
| script running `arc docs` | hand-kept `openapi.yaml` | out-of-band spec (R7) |

## Smoke commands

```bash
npm ls @classytic/arc @classytic/mongokit @classytic/repo-core
grep -rn "defineResource(" src/
grep -rnE "fastify\.(get|post|patch|put|delete)\(" src/
grep -rln "from 'mongoose'\|from \"mongoose\"" src/ | grep -v "model\|repository\|adapter"
grep -rn "schema.set('toJSON'" src/
grep -rcE "user\.role|roles\.includes|throw.*(Unauthorized|Forbidden)" src/
ls openapi.* swagger.* 2>/dev/null
```

Use the counts for the report summary.
