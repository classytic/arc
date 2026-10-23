# defineModule

Use a module when there is engine state to boot and several resources to register as a unit. A package exports one `createXModule(deps)` factory returning an `ArcModule`; the host lists it in `createApp({ modules })`.

```ts
import { defineModule, getModuleExports } from "@classytic/arc/factory";
import { defineErrorMapper } from "@classytic/arc/utils";

export const accountingModule = (deps: AccountingDeps) =>
  defineModule({
    name: "accounting",
    dependsOn: ["ledger"],
    requires: { ports: ["outbox"] },

    plugins: async (f) => {
      await f.register(dbPlugin, { connection: deps.connection });
    },

    bootstrap: async (f, { defer, ports }) => {
      const engine = await createAccountingEngine(deps, getModuleExports<LedgerEngine>(f, "ledger"), ports.outbox);
      defer(() => engine.stop());
      return engine;
    },

    resources: (f) => {
      const engine = getModuleExports<AccountingEngine>(f, "accounting");
      return [accountsResource(engine, deps), entriesResource(engine, deps)];
    },

    eventHandlers: [{ name: "accounting.on-invoice", event: ["invoice:posted"], handler: onInvoicePosted }],
    scheduledJobs: [{ name: "accounting.sweep", every: 3_600_000, handler: () => sweep() }],
    healthChecks: [{ name: "accounting-engine", check: () => engineReady() }],

    errorMappers: [
      defineErrorMapper({
        type: AccountingError,
        toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
      }),
    ],

    onClose: async () => {
      /* stop timers, flush outbox */
    },
  });
```

## Phases

Per phase the module runs before the app-level hook; `onClose` runs in reverse composition order.

```
plugins -> bootstrap -> resources (factory form) -> afterResources -> onClose
```

- `plugins` and `afterResources` are called by arc, not registered. Await `fastify.register(x)` inside; returning a plugin throws, a returned function is a disposer.
- The `bootstrap` return value is the public export at `fastify.arc.modules[name]`. Register teardown with `defer` because the return slot is taken.
- The `resources` factory form runs after every bootstrap, so engines are live.
- Boot is transactional: a failing phase closes every started module in reverse, then rethrows.

## dependsOn orders composition

`dependsOn: ["ledger"]` makes ledger's bootstrap and export live before this module's phases. It does not delay importing: every input, thunks included, is resolved first. The sort is stable, so unrelated modules keep list order. Unknown names, self references and cycles fail at boot. Every hard sibling dependency belongs in `dependsOn`; omit it only for optional integrations read with `getOptionalModuleExports`.

| Field | Use |
|---|---|
| `requires: { ports, optionalPorts, modules }` | what the host must supply; every gap reported in one boot error |
| `kind` | `domain` (default), `bridge` (active only when all its `dependsOn` modules are composed), `platform`, `aggregator` |
| `publishes`, `eventNamespace` | events the module owns, checked by `createApp({ moduleGraph })` |
| `owns: "provided"` | supersede an app resource of the same name |

## Typed cross-module exports

```ts
declare module "@classytic/arc/factory" {
  interface ArcModuleRegistry {
    accounting: AccountingEngine;
    ledger: LedgerEngine;
  }
}
// getModuleExports(f, "accounting") now infers AccountingEngine
```

`getModuleExports` throws when the module is not composed, composes later, or returned nothing. Wiring bugs surface at boot, not as `undefined`.

## Lazy and region packs

```ts
const taxPack = region === "BD"
  ? () => import("@classytic/bd-tax").then((m) => m.createBdTaxModule(deps))
  : () => import("@classytic/us-tax").then((m) => m.createUsTaxModule(deps));

await createApp({ modules: [coreModule(deps), taxPack] });
```

The thunk decides whether to import; `dependsOn` orders what was selected.

## Naming

- Package `@classytic/arc-<domain>`; third parties use their own scope.
- Module `name` is unique across the host (`"accounting"`, `"acme.billing"`); arc rejects duplicates at boot.
- One factory per package. To ship several domains, publish several packages; the host owns the flat `modules` list.
