/**
 * Port typing: `requires.ports` names are registry keys (a typo is a compile error), the setup
 * context's `ports` is typed from the declaration with no casts, and `createApp({ ports })` /
 * `bootModuleApp({ ports })` are checked against the same registry. Compile-time: `tsc -p
 * tsconfig.types.json` is the gate.
 */
import { describe, expectTypeOf, it } from "vitest";
import { type ArcModule, createApp, defineModule, extendModule } from "../../src/factory/index.js";
import { bootModuleApp } from "../../src/testing/bootModuleApp.js";

interface OutboxStore {
  append(event: string): Promise<void>;
}
interface BusinessCalendar {
  today(): string;
}

declare module "../../src/factory/index.js" {
  interface ArcPortRegistry {
    outbox: OutboxStore;
    calendar: BusinessCalendar;
  }
}

describe("module ports — types", () => {
  it("types required ports as present and optional ports as T | undefined, inferred", () => {
    defineModule({
      name: "order",
      requires: { ports: ["outbox"], optionalPorts: ["calendar"] },
      bootstrap: (_f, { ports }) => {
        expectTypeOf(ports.outbox).toEqualTypeOf<OutboxStore>();
        expectTypeOf(ports.calendar).toEqualTypeOf<BusinessCalendar | undefined>();
        return { ok: true };
      },
    });
  });

  it("hides ports the module did not declare", () => {
    defineModule({
      name: "catalog",
      requires: { ports: ["outbox"] },
      bootstrap: (_f, { ports }) => {
        // @ts-expect-error — calendar was not declared by this module
        void ports.calendar;
      },
    });
  });

  it("rejects a misspelt port name at compile time", () => {
    defineModule({
      name: "order",
      // @ts-expect-error — "outbx" is not a key of ArcPortRegistry
      requires: { ports: ["outbx"] },
    });
  });

  it("types createApp({ ports }) and bootModuleApp({ ports }) against the registry", () => {
    const outbox: OutboxStore = { append: async () => {} };
    const typed: ArcModule = defineModule({ name: "order", requires: { ports: ["outbox"] } });
    void (() => createApp({ modules: [typed], ports: { outbox } }));
    void (() => bootModuleApp([typed], { ports: { outbox } }));
    // @ts-expect-error — the value must be an OutboxStore
    void (() => createApp({ ports: { outbox: 42 } }));
    // @ts-expect-error — "outbx" is not a registered port
    void (() => createApp({ ports: { outbx: outbox } }));
  });

  it("keeps a typed module assignable to the erased ArcModule and to extendModule", () => {
    const typed = defineModule({
      name: "order",
      requires: { ports: ["outbox"], optionalPorts: ["calendar"] },
      bootstrap: (_f, { ports }) => ports.outbox,
    });
    const erased: ArcModule = typed;
    extendModule(typed, { kind: "platform" });
    void erased;
  });
});

describe("module names — no strictModuleNames (the default)", () => {
  it("accepts any string, so hosts with unregistered modules keep compiling", () => {
    defineModule({
      name: "pos",
      dependsOn: ["anything-at-all"],
      requires: { modules: ["devices"] },
    });
  });
});
