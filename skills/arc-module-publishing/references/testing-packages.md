# Testing a package

If the module boots green in `bootModuleApp`, it composes in any host. The harness lives in `@classytic/arc/testing`.

## Boot a real app around the module

```ts
import { bootModuleApp } from "@classytic/arc/testing";
import { afterAll, beforeAll, expect, it } from "vitest";

let t: Awaited<ReturnType<typeof bootModuleApp>>;

beforeAll(async () => {
  t = await bootModuleApp(({ connection }) => [accountingModule({ connection, permissions })], {
    actor: { userId: "u1", roles: ["admin"], organizationId: "org-1", orgRoles: ["admin"] },
  });
});
afterAll(() => t.close());

it("lists accounts", async () => {
  const res = await t.app.inject({ method: "GET", url: "/accounting/accounts" });
  expect(res.statusCode).toBe(200);
});

it("exposes the engine", () => {
  const engine = t.exports<AccountingEngine>("accounting");
  expect(engine).toBeDefined();
});
```

| Option | Meaning |
|---|---|
| first argument | a module, an array, or a factory `({ connection, uri }) => modules` (a bare function is always the factory) |
| `actor` | default `TestActor` (`userId`, `roles`, `organizationId`, `orgRoles`, `teamId`, `context`, `elevated`) for requests without an `x-test-actor` header |
| `replset: true` | single-node replica set for transactional engines |
| `database` | a `TestDatabaseFactory` for a non-Mongo store; default `mongoMemoryDatabase` |
| `app` | extra `createApp` options over the testing defaults (`preset: "testing"`, `auth: false`) |
| `ports` | host ports, checked exactly as `createApp({ ports })` |

The harness boots with `auth: false`. Without `actor`, every request is a public scope and role-gated routes answer 401.

Install contract: mongoose, `mongodb-memory-server` and your kit are devDependencies. Without `mongodb-memory-server` the default database throws at boot.

## Prove a module has no hidden edge

```ts
import { assertModuleBootsAlone } from "@classytic/arc/testing";

it("order boots alone", () =>
  assertModuleBootsAlone(allModules, "order", { probe: async (t) => { /* drive its ports */ } }));
```

It boots the module's `dependsOn` and `requires.modules` closure plus platform modules and bridges, and fails naming the module.

## Use a real store, not a Map

A `Map`-backed repository does not reproduce ObjectId versus string ids, projection, operator translation, cursor encoding, unique indexes or strict-mode field dropping. Boot the module on the same adapter as production.

## Store conformance

A package that implements a shared contract runs its suite.

```ts
import { runOutboxStoreContract } from "@classytic/arc/testing/outbox";

runOutboxStoreContract("MongoOutboxStore", async () => ({
  store: new MongoOutboxStore(model),
  reset: async () => { await model.deleteMany({}); },
  teardown: async () => { await model.deleteMany({}); },
}));
```

Siblings: `runStorageContract` from `@classytic/arc/testing/storage`, `runCleanupRunStoreContract` from `@classytic/arc/testing/cleanup`.

## Cases to cover

- Both tenancy modes (`required` and `off`) when the package supports both.
- A protected-field write answers 403 under the default `onFieldWriteDenied: "reject"`.
- Zod refinements fail as 400 `arc.validation_error` with `details`.
- No filter field named `page`, `limit`, `cursor`, `after`, `sort`, `search`, `select` or `populate`: boot reports `filter-field-reserved-name`.
- Daily jobs use `createMemoryDailyLedger()` from `@classytic/arc/plugins` and an injected `clock`.
- Pin devDeps at or above every peer floor so the suite runs the version you promise.
