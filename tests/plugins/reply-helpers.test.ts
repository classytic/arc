/**
 * Reply Helpers + Error Mappers + Streaming Tests
 */

import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── Domain error for mapper tests ──
class AccountingError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "AccountingError";
    this.status = status;
    this.code = code;
  }
}

class ValidationError extends Error {
  fields: string[];
  constructor(fields: string[]) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

describe("reply helpers", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { replyHelpersPlugin } = await import("../../src/plugins/replyHelpers.js");

    app = Fastify({ logger: false });
    await app.register(replyHelpersPlugin);

    // Test routes
    app.get("/ok", async (_req, reply) => reply.ok({ name: "MacBook", price: 2499 }));
    app.get("/ok-201", async (_req, reply) => reply.ok({ id: "new-1" }, 201));
    app.get("/fail", async (_req, reply) => reply.fail("Not found", 404));
    app.get("/fail-array", async (_req, reply) => reply.fail(["Name required", "Price invalid"], 422));
    app.get("/fail-default", async (_req, reply) => reply.fail("Bad request"));
    app.get("/paginated", async (_req, reply) =>
      reply.paginated({
        docs: [{ id: "1" }, { id: "2" }],
        total: 50,
        page: 1,
        limit: 20,
        hasNext: true,
      }),
    );
    app.get("/stream-buffer", async (_req, reply) =>
      reply.stream(Buffer.from("id,name\n1,MacBook\n2,iPad"), {
        contentType: "text/csv",
        filename: "export.csv",
      }),
    );
    app.get("/stream-readable", async (_req, reply) => {
      const readable = new Readable({
        read() {
          this.push("line 1\n");
          this.push("line 2\n");
          this.push(null);
        },
      });
      return reply.stream(readable, {
        contentType: "text/plain",
        filename: "log.txt",
      });
    });
    app.get("/stream-no-filename", async (_req, reply) =>
      reply.stream(Buffer.from("raw data"), { contentType: "application/octet-stream" }),
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── reply.ok() ──

  it("reply.ok() sends success envelope with 200", async () => {
    const res = await app.inject({ method: "GET", url: "/ok" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ name: "MacBook", price: 2499 });
  });

  it("reply.ok() accepts custom status code", async () => {
    const res = await app.inject({ method: "GET", url: "/ok-201" });
    expect(res.statusCode).toBe(201);
    expect(res.json().success).toBe(true);
    expect(res.json().data.id).toBe("new-1");
  });

  // ── reply.fail() ──

  it("reply.fail() sends error envelope with custom status", async () => {
    const res = await app.inject({ method: "GET", url: "/fail" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Not found");
  });

  it("reply.fail() with array sends errors field", async () => {
    const res = await app.inject({ method: "GET", url: "/fail-array" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.errors).toEqual(["Name required", "Price invalid"]);
    expect(body.error).toBeUndefined();
  });

  it("reply.fail() defaults to 400", async () => {
    const res = await app.inject({ method: "GET", url: "/fail-default" });
    expect(res.statusCode).toBe(400);
  });

  // ── reply.paginated() ──

  it("reply.paginated() sends flat list envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/paginated" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.docs).toHaveLength(2);
    expect(body.total).toBe(50);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.hasNext).toBe(true);
  });

  // ── reply.stream() ──

  it("reply.stream() sends buffer with content-disposition", async () => {
    const res = await app.inject({ method: "GET", url: "/stream-buffer" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="export.csv"');
    expect(res.body).toContain("id,name");
    expect(res.body).toContain("MacBook");
  });

  it("reply.stream() sends readable stream", async () => {
    const res = await app.inject({ method: "GET", url: "/stream-readable" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="log.txt"');
    expect(res.body).toContain("line 1");
    expect(res.body).toContain("line 2");
  });

  it("reply.stream() without filename omits content-disposition", async () => {
    const res = await app.inject({ method: "GET", url: "/stream-no-filename" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBeUndefined();
  });
});

describe("error mappers", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { errorHandlerPlugin } = await import("../../src/plugins/errorHandler.js");

    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin, {
      errorMappers: [
        {
          type: AccountingError,
          toResponse: (err) => ({
            status: err.status,
            code: err.code,
            message: err.message,
          }),
        },
        {
          type: ValidationError,
          toResponse: (err) => ({
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Validation failed",
            details: { fields: err.fields },
          }),
        },
      ],
    });

    // Routes that throw domain errors
    app.get("/accounting-error", async () => {
      throw new AccountingError("Journal already posted", 409, "ALREADY_POSTED");
    });
    app.get("/validation-error", async () => {
      throw new ValidationError(["amount", "currency"]);
    });
    app.get("/generic-error", async () => {
      throw new Error("Something unexpected");
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("maps AccountingError to proper HTTP response", async () => {
    const res = await app.inject({ method: "GET", url: "/accounting-error" });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("ALREADY_POSTED");
    expect(body.error).toBe("Journal already posted");
  });

  it("maps ValidationError with details", async () => {
    const res = await app.inject({ method: "GET", url: "/validation-error" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.fields).toEqual(["amount", "currency"]);
  });

  it("unmapped errors still get generic handling", async () => {
    const res = await app.inject({ method: "GET", url: "/generic-error" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});

describe("BullMQ jobs integration (#8)", () => {
  it("Arc exports defineJob and jobsPlugin", async () => {
    const { defineJob, jobsPlugin } = await import("../../src/integrations/jobs.js");
    expect(typeof defineJob).toBe("function");
    expect(typeof jobsPlugin).toBe("function");
  });

  it("defineJob creates a typed job definition", async () => {
    const { defineJob } = await import("../../src/integrations/jobs.js");
    const emailJob = defineJob({
      name: "send-email",
      handler: async (data: { to: string; subject: string }) => {
        return { sent: true, to: data.to };
      },
    });
    expect(emailJob.name).toBe("send-email");
    expect(typeof emailJob.handler).toBe("function");
  });
});

describe("streaming responses (#9)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Fastify natively supports readable streams — no plugin needed
    app.get("/stream-native", async (_req, reply) => {
      const readable = new Readable({
        read() {
          this.push("chunk1,");
          this.push("chunk2,");
          this.push("chunk3");
          this.push(null);
        },
      });
      reply.header("content-type", "text/csv");
      reply.header("content-disposition", 'attachment; filename="data.csv"');
      return reply.send(readable);
    });

    app.get("/stream-async-iterable", async (_req, reply) => {
      async function* generate() {
        yield "row1\n";
        yield "row2\n";
        yield "row3\n";
      }
      const readable = Readable.from(generate());
      reply.header("content-type", "text/plain");
      return reply.send(readable);
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("Fastify streams readable responses natively", async () => {
    const res = await app.inject({ method: "GET", url: "/stream-native" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv");
    expect(res.body).toBe("chunk1,chunk2,chunk3");
  });

  it("async iterables stream via Readable.from()", async () => {
    const res = await app.inject({ method: "GET", url: "/stream-async-iterable" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("row1\nrow2\nrow3\n");
  });
});
