/**
 * `assertRequiresPorts` — every case pins a way the helper could pass while the module under
 * test no longer fails loud: a dropped or added port, a reordered list, a composition failing for a
 * reason other than the port, a base port shadowing the one under test.
 */
import { describe, expect, it } from "vitest";
import { defineModule } from "../../src/factory/index.js";
import { assertRequiresPorts } from "../../src/testing/requiredPorts.js";

const order = (ports: readonly string[], dependsOn: readonly string[] = []) =>
  defineModule({
    name: "order",
    dependsOn: [...dependsOn],
    ...(ports.length ? { requires: { ports: [...ports] } } : {}),
  });
const catalog = defineModule({ name: "catalog", requires: { ports: ["catalogDb"] } });

describe("assertRequiresPorts", () => {
  it("passes when the module declares exactly the ports and fails loud without each", async () => {
    await expect(
      assertRequiresPorts(order(["connection", "outbox"]), ["connection", "outbox"]),
    ).resolves.toEqual({
      module: "order",
      ports: ["connection", "outbox"],
    });
  });

  it("resolves a thunk input", async () => {
    await expect(
      assertRequiresPorts(async () => order(["outbox"]), ["outbox"]),
    ).resolves.toMatchObject({
      module: "order",
    });
  });

  it("FAILS when the module dropped a port the caller lists", async () => {
    await expect(
      assertRequiresPorts(order(["connection"]), ["connection", "outbox"]),
    ).rejects.toThrow(
      'module "order" declares required ports [connection], expected [connection, outbox]',
    );
  });

  it("FAILS when the module declares a port the caller does not list", async () => {
    await expect(
      assertRequiresPorts(order(["connection", "outbox"]), ["connection"]),
    ).rejects.toThrow("declares required ports [connection, outbox], expected [connection]");
  });

  it("FAILS on a reordered list — the aggregated error names ports in declared order", async () => {
    await expect(
      assertRequiresPorts(order(["connection", "outbox"]), ["outbox", "connection"]),
    ).rejects.toThrow("expected [outbox, connection]");
  });

  it("[] asserts the module declares none and plans with nothing supplied", async () => {
    await expect(assertRequiresPorts(order([]), [])).resolves.toEqual({
      module: "order",
      ports: [],
    });
    await expect(assertRequiresPorts(order(["outbox"]), [])).rejects.toThrow("expected []");
  });

  it("FAILS when the composition breaks for a reason besides the ports — a missing peer", async () => {
    await expect(assertRequiresPorts(order(["outbox"], ["catalog"]), ["outbox"])).rejects.toThrow(
      'module "order" dependsOn "catalog", which is not composed',
    );
  });

  it("composes peers through `with`, with their ports supplied through `ports`", async () => {
    const mod = order(["outbox"], ["catalog"]);
    await expect(
      assertRequiresPorts(mod, ["outbox"], { with: [catalog], ports: { catalogDb: {} } }),
    ).resolves.toMatchObject({ module: "order" });
    await expect(assertRequiresPorts(mod, ["outbox"], { with: [catalog] })).rejects.toThrow(
      'module "catalog" requires port "catalogDb"',
    );
  });

  it("FAILS when `ports` supplies a port under test — that case could never fail", async () => {
    await expect(
      assertRequiresPorts(order(["connection", "outbox"]), ["connection", "outbox"], {
        ports: { outbox: {} },
      }),
    ).rejects.toThrow("options.ports supplies a port under test: outbox");
  });
});
