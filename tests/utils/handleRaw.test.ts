/**
 * handleRaw — envelope wrapper for raw route handlers
 *
 * Tests:
 * 1. Wraps return value in { success: true, data }
 * 2. null/undefined → { success: true } (no data field)
 * 3. ArcError → statusCode + toJSON()
 * 4. Error with .statusCode → uses that status
 * 5. Generic Error → 500
 * 6. Skips if reply already sent (streaming)
 * 7. Custom success status code
 * 8. End-to-end with Fastify inject
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "../../src/utils/errors.js";
import { handleRaw } from "../../src/utils/handleRaw.js";

// ============================================================================
// Unit tests — mock reply
// ============================================================================

function mockReply() {
  let _code = 200;
  let _body: unknown;
  let _sent = false;

  return {
    get sent() {
      return _sent;
    },
    code(c: number) {
      _code = c;
      return this;
    },
    send(body: unknown) {
      _body = body;
      _sent = true;
      return this;
    },
    get _code() {
      return _code;
    },
    get _body() {
      return _body;
    },
  };
}

const mockReq = {} as import("fastify").FastifyRequest;

describe("handleRaw — unit", () => {
  it("sends return value raw — no envelope (HTTP status is the discriminator)", async () => {
    const handler = handleRaw(async () => ({ orderId: "abc", total: 42 }));
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(200);
    expect(reply._body).toEqual({ orderId: "abc", total: 42 });
  });

  it("null return → empty body (HTTP status only)", async () => {
    const handler = handleRaw(async () => null);
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(200);
    expect(reply._body).toBeUndefined();
  });

  it("undefined return → empty body", async () => {
    const handler = handleRaw(async () => undefined);
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._body).toBeUndefined();
  });

  it("custom status code", async () => {
    const handler = handleRaw(async () => ({ id: "new" }), 201);
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(201);
    expect(reply._body).toEqual({ id: "new" });
  });

  it("ArcError → statusCode + canonical error envelope { error, code, details? }", async () => {
    const handler = handleRaw(async () => {
      throw new ForbiddenError("Admin only");
    });
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(403);
    const body = reply._body as Record<string, unknown>;
    expect(body.error).toBe("Admin only");
    expect(body.code).toBe("arc.forbidden");
  });

  it("NotFoundError → 404", async () => {
    const handler = handleRaw(async () => {
      throw new NotFoundError("Order", "xyz");
    });
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(404);
    const body = reply._body as Record<string, unknown>;
    expect(body.code).toBe("arc.not_found");
  });

  it("ValidationError → 400 with errors array in details", async () => {
    const handler = handleRaw(async () => {
      throw new ValidationError("Invalid input", [{ field: "name", message: "required" }]);
    });
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(400);
    const body = reply._body as Record<string, unknown>;
    expect(body.code).toBe("arc.validation_error");
  });

  it("Error with .statusCode → uses that code", async () => {
    const handler = handleRaw(async () => {
      const err = new Error("Payment required") as Error & { statusCode: number };
      err.statusCode = 402;
      throw err;
    });
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(402);
    expect((reply._body as Record<string, unknown>).error).toBe("Payment required");
  });

  it("generic Error → 500", async () => {
    const handler = handleRaw(async () => {
      throw new Error("kaboom");
    });
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    expect(reply._code).toBe(500);
    expect((reply._body as Record<string, unknown>).error).toBe("kaboom");
  });

  it("skips if reply already sent", async () => {
    const handler = handleRaw(async (_req, reply) => {
      // Simulate streaming — handler sends directly
      reply.send("streaming data");
      return "this should be ignored";
    });
    const reply = mockReply();
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);

    // First send wins
    expect(reply._body).toBe("streaming data");
  });

  it("skips error send if reply was sent before throw", async () => {
    const handler = handleRaw(async (_req, reply) => {
      reply.send("partial");
      throw new Error("late error");
    });
    const reply = mockReply();
    // Should not throw — error is swallowed because reply is sent
    await handler(mockReq, reply as unknown as import("fastify").FastifyReply);
    expect(reply._body).toBe("partial");
  });
});

// ============================================================================
// End-to-end with Fastify inject
// ============================================================================

describe("handleRaw — e2e with Fastify", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    app.get(
      "/report",
      handleRaw(async () => ({
        totalOrders: 150,
        revenue: 45000,
      })),
    );

    app.post(
      "/create",
      handleRaw(async (req) => {
        const body = req.body as Record<string, unknown>;
        if (!body?.name)
          throw new ValidationError("Missing name", [{ field: "name", message: "required" }]);
        return { id: "new-1", name: body.name };
      }, 201),
    );

    app.get(
      "/forbidden",
      handleRaw(async () => {
        throw new ForbiddenError("Nope");
      }),
    );

    app.get(
      "/crash",
      handleRaw(async () => {
        throw new Error("unexpected");
      }),
    );

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /report → 200 with envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/report" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totalOrders).toBe(150);
  });

  it("POST /create → 201 with envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/create",
      payload: { name: "Widget" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).name).toBe("Widget");
  });

  it("POST /create without name → 400 ValidationError", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/create",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("arc.validation_error");
  });

  it("GET /forbidden → 403 ForbiddenError", async () => {
    const res = await app.inject({ method: "GET", url: "/forbidden" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("arc.forbidden");
  });

  it("GET /crash → 500 generic error", async () => {
    const res = await app.inject({ method: "GET", url: "/crash" });
    expect(res.statusCode).toBe(500);
    // Error envelope: `{ error, code? }` — generic Errors carry `error`,
    // ArcErrors also include `code`. No `success` wrapper.
    expect(JSON.parse(res.body).error).toBeDefined();
  });
});
