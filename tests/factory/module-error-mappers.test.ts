/**
 * Module-shipped error mappers (2.21) — `defineModule({ errorMappers })`.
 *
 * Pins the decoupling contract: a domain module carries its OWN error
 * mapper, and composing the module is sufficient for its domain errors to
 * cross the wire as mapped contracts — the host's composition root no
 * longer has to know every domain package's error classes. Host-declared
 * mappers keep priority (they run first).
 */

import { describe, expect, it } from "vitest";
import { createApp, defineModule } from "../../src/factory/index.js";
import { defineErrorMapper } from "../../src/utils/defineErrorMapper.js";

class ShippingError extends Error {
  constructor(
    message: string,
    readonly carrierCode: string,
  ) {
    super(message);
    this.name = "ShippingError";
  }
}

const shippingMapper = defineErrorMapper<ShippingError>({
  type: ShippingError,
  toResponse: (err) => ({
    status: 422,
    code: `shipping.${err.carrierCode}`,
    message: err.message,
  }),
});

describe("defineModule — errorMappers", () => {
  it("a module-shipped mapper maps domain errors without host wiring", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "shipping",
          errorMappers: [shippingMapper],
          resources: [
            {
              name: "label",
              toPlugin: () => async (f: import("fastify").FastifyInstance) => {
                f.get("/labels/boom", async () => {
                  throw new ShippingError("carrier rejected the parcel", "carrier_reject");
                });
              },
            },
          ],
        }),
      ],
    });

    const res = await app.inject({ method: "GET", url: "/labels/boom" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe("shipping.carrier_reject");
    expect(body.message).toBe("carrier rejected the parcel");

    await app.close();
  });

  it("host-declared mappers keep priority over module mappers for the same error", async () => {
    const hostMapper = defineErrorMapper<ShippingError>({
      type: ShippingError,
      toResponse: () => ({ status: 400, code: "host.override", message: "host wins" }),
    });

    const app = await createApp({
      auth: false,
      logger: false,
      errorHandler: { errorMappers: [hostMapper] },
      modules: [
        defineModule({
          name: "shipping",
          errorMappers: [shippingMapper],
          resources: [
            {
              name: "label",
              toPlugin: () => async (f: import("fastify").FastifyInstance) => {
                f.get("/labels/boom", async () => {
                  throw new ShippingError("carrier rejected the parcel", "carrier_reject");
                });
              },
            },
          ],
        }),
      ],
    });

    const res = await app.inject({ method: "GET", url: "/labels/boom" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("host.override");

    await app.close();
  });
});
