/**
 * Multipart Body Middleware Tests
 *
 * Verifies that multipart/form-data requests get parsed into req.body
 * with files attached, while JSON requests pass through unchanged.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("multipartBody middleware", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { multipartBody } = await import("../../src/middleware/multipartBody.js");
    const multipartPlugin = await import("@fastify/multipart").then((m) => m.default);

    app = Fastify({ logger: false });
    await app.register(multipartPlugin, { limits: { fileSize: 10 * 1024 * 1024 } });

    // Route with multipartBody middleware
    app.post("/products", { preHandler: [multipartBody()] }, async (request) => {
      return { body: request.body };
    });

    // Route with MIME type restriction
    app.post(
      "/images",
      {
        preHandler: [
          multipartBody({
            allowedMimeTypes: ["image/png", "image/jpeg"],
            maxFileSize: 1024, // 1KB
          }),
        ],
      },
      async (request) => {
        return { body: request.body };
      },
    );

    // Route that requires a single file field (OCR-style endpoint)
    app.post(
      "/ocr",
      {
        preHandler: [multipartBody({ requiredFields: ["file"] })],
      },
      async (request) => {
        return { body: request.body };
      },
    );

    // Route that requires multiple file fields (multi-upload editor)
    app.post(
      "/profile",
      {
        preHandler: [multipartBody({ requiredFields: ["avatar", "cover"] })],
      },
      async (request) => {
        return { body: request.body };
      },
    );

    // Route with custom files key
    app.post("/docs", { preHandler: [multipartBody({ filesKey: "uploads" })] }, async (request) => {
      return { body: request.body };
    });

    // Subtype wildcard: accept any image/*
    app.post(
      "/images-any",
      { preHandler: [multipartBody({ allowedMimeTypes: ["image/*"] })] },
      async (request) => ({ body: request.body }),
    );

    // Total wildcard: accept any type (equivalent to omitting)
    app.post(
      "/any",
      { preHandler: [multipartBody({ allowedMimeTypes: ["*"] })] },
      async (request) => ({ body: request.body }),
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── JSON pass-through ──

  it("should pass through JSON requests unchanged", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/products",
      headers: { "content-type": "application/json" },
      payload: { name: "MacBook", price: 2499 },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body).toEqual({ name: "MacBook", price: 2499 });
  });

  // ── Multipart form fields ──

  it("should parse multipart text fields into req.body", async () => {
    const form = buildMultipart([
      { type: "field", name: "name", value: "MacBook" },
      { type: "field", name: "price", value: "2499" },
      { type: "field", name: "inStock", value: "true" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/products",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body.name).toBe("MacBook");
    expect(result.body.price).toBe(2499); // auto-parsed to number
    expect(result.body.inStock).toBe(true); // auto-parsed to boolean
  });

  // ── File upload ──

  it("should attach files to req.body._files", async () => {
    const fileContent = Buffer.from("fake image data");
    const form = buildMultipart([
      { type: "field", name: "name", value: "Product Photo" },
      {
        type: "file",
        name: "image",
        filename: "photo.png",
        mimetype: "image/png",
        content: fileContent,
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/products",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body.name).toBe("Product Photo");
    expect(result.body._files).toBeDefined();
    expect(result.body._files.image).toBeDefined();
    expect(result.body._files.image.filename).toBe("photo.png");
    expect(result.body._files.image.mimetype).toBe("image/png");
    expect(result.body._files.image.size).toBe(fileContent.length);
  });

  // ── Multiple files ──

  it("should handle multiple files", async () => {
    const form = buildMultipart([
      { type: "field", name: "title", value: "Gallery" },
      {
        type: "file",
        name: "cover",
        filename: "cover.jpg",
        mimetype: "image/jpeg",
        content: Buffer.from("cover"),
      },
      {
        type: "file",
        name: "thumb",
        filename: "thumb.png",
        mimetype: "image/png",
        content: Buffer.from("thumb"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/products",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(Object.keys(result.body._files)).toHaveLength(2);
    expect(result.body._files.cover.filename).toBe("cover.jpg");
    expect(result.body._files.thumb.filename).toBe("thumb.png");
  });

  // ── No files = no _files key ──

  it("should not add _files key when no files uploaded", async () => {
    const form = buildMultipart([{ type: "field", name: "name", value: "NoFile" }]);

    const response = await app.inject({
      method: "POST",
      url: "/products",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body.name).toBe("NoFile");
    expect(result.body._files).toBeUndefined();
  });

  // ── MIME type restriction ──

  it("should reject disallowed MIME types with 415", async () => {
    const form = buildMultipart([
      {
        type: "file",
        name: "doc",
        filename: "test.pdf",
        mimetype: "application/pdf",
        content: Buffer.from("pdf"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/images",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(415);
    const result = response.json();
    expect(result.message).toContain("not allowed");
  });

  it("should accept allowed MIME types", async () => {
    const form = buildMultipart([
      {
        type: "file",
        name: "photo",
        filename: "pic.png",
        mimetype: "image/png",
        content: Buffer.from("img"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/images",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
  });

  // ── File size limit ──

  it("should reject oversized files with 413", async () => {
    const bigFile = Buffer.alloc(2048, "x"); // 2KB, limit is 1KB on /images
    const form = buildMultipart([
      { type: "file", name: "photo", filename: "big.png", mimetype: "image/png", content: bigFile },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/images",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(413);
    const result = response.json();
    expect(result.message).toContain("exceeds maximum size");
  });

  // ── Custom files key ──

  it("should use custom filesKey", async () => {
    const form = buildMultipart([
      { type: "field", name: "title", value: "Doc" },
      {
        type: "file",
        name: "file",
        filename: "test.pdf",
        mimetype: "application/pdf",
        content: Buffer.from("pdf"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/docs",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body.uploads).toBeDefined();
    expect(result.body.uploads.file.filename).toBe("test.pdf");
    expect(result.body._files).toBeUndefined();
  });

  // ── requiredFields enforcement ──

  it("requiredFields: accepts a request when every listed field is present", async () => {
    const form = buildMultipart([
      {
        type: "file",
        name: "file",
        filename: "scan.pdf",
        mimetype: "application/pdf",
        content: Buffer.from("%PDF-1.4 fake"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/ocr",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body._files.file.filename).toBe("scan.pdf");
  });

  it("requiredFields: returns 400 with MISSING_FILE_FIELDS when the field is absent", async () => {
    // Multipart request with NO files — just a text field.
    const form = buildMultipart([{ type: "field", name: "note", value: "oops" }]);

    const response = await app.inject({
      method: "POST",
      url: "/ocr",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("MISSING_FILE_FIELDS");
    expect(body.message).toMatch(/Missing required file field/);
    expect(body.details.missing).toEqual(["file"]);
  });

  it("requiredFields: lists every missing field and uses plural wording", async () => {
    // Only `avatar` uploaded — `cover` is missing.
    const form = buildMultipart([
      {
        type: "file",
        name: "avatar",
        filename: "me.png",
        mimetype: "image/png",
        content: Buffer.from("a"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/profile",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("MISSING_FILE_FIELDS");
    expect(body.details.missing).toEqual(["cover"]);
    // Single missing field → singular wording.
    expect(body.message).toBe("Missing required file field: cover");
  });

  it("requiredFields: lists multiple missing fields with plural wording", async () => {
    // Send zero files — both avatar AND cover are missing.
    const form = buildMultipart([{ type: "field", name: "bio", value: "hi" }]);

    const response = await app.inject({
      method: "POST",
      url: "/profile",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.details.missing).toEqual(["avatar", "cover"]);
    expect(body.message).toBe("Missing required file fields: avatar, cover");
  });

  it("requiredFields: stays a no-op for JSON requests (safe on shared routes)", async () => {
    // Non-multipart content-type → middleware short-circuits and the JSON body
    // passes through unchanged, even though `requiredFields: ['file']` is set.
    const response = await app.inject({
      method: "POST",
      url: "/ocr",
      headers: { "content-type": "application/json" },
      payload: { plain: "json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().body).toEqual({ plain: "json" });
  });

  // ── JSON field parsing ──

  it("should parse JSON objects in form fields", async () => {
    const form = buildMultipart([
      { type: "field", name: "name", value: "Product" },
      { type: "field", name: "tags", value: '["electronics","sale"]' },
      { type: "field", name: "meta", value: '{"color":"red"}' },
      { type: "field", name: "isNull", value: "null" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/products",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.body.tags).toEqual(["electronics", "sale"]);
    expect(result.body.meta).toEqual({ color: "red" });
    expect(result.body.isNull).toBeNull();
  });

  // ── MIME wildcards ──

  it("accepts any subtype with `image/*`", async () => {
    const form = buildMultipart([
      {
        type: "file",
        name: "photo",
        filename: "pic.webp",
        mimetype: "image/webp",
        content: Buffer.from("img"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/images-any",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects other families when `image/*` is set", async () => {
    const form = buildMultipart([
      {
        type: "file",
        name: "doc",
        filename: "test.pdf",
        mimetype: "application/pdf",
        content: Buffer.from("pdf"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/images-any",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(415);
  });

  it("accepts any type when `*` is set", async () => {
    const form = buildMultipart([
      {
        type: "file",
        name: "anything",
        filename: "data.bin",
        mimetype: "application/octet-stream",
        content: Buffer.from("x"),
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/any",
      headers: form.headers,
      payload: form.payload,
    });

    expect(response.statusCode).toBe(200);
  });
});

// ============================================================================
// Helper: Build multipart/form-data payload for app.inject()
// ============================================================================

type FormPart =
  | { type: "field"; name: string; value: string }
  | { type: "file"; name: string; filename: string; mimetype: string; content: Buffer };

function buildMultipart(parts: FormPart[]): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----ArcTestBoundary${Date.now()}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.type === "field") {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(`${part.value}\r\n`));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.mimetype}\r\n\r\n`,
        ),
      );
      chunks.push(part.content);
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}
