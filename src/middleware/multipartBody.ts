/**
 * Multipart Body Middleware — Opt-in multipart/form-data parsing for CRUD routes.
 *
 * Parses multipart form fields into `req.body` and attaches files to `req.body._files`.
 * Use with a `before:create` or `before:update` hook to process files (upload to S3, etc.)
 * before BaseController persists the record.
 *
 * Requires `@fastify/multipart` to be registered on the Fastify instance
 * (Arc registers it by default via `createApp()` unless `multipart: false`).
 *
 * @example
 * ```typescript
 * import { defineResource } from '@classytic/arc';
 * import { multipartBody } from '@classytic/arc/middleware';
 *
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter,
 *   middlewares: {
 *     create: [multipartBody()],
 *     update: [multipartBody()],
 *   },
 *   hooks: {
 *     'before:create': async (data) => {
 *       if (data._files?.image) {
 *         data.imageUrl = await uploadToS3(data._files.image);
 *         delete data._files;
 *       }
 *       return data;
 *     },
 *   },
 * });
 * ```
 */

import type { RouteHandlerMethod } from "fastify";

/** Parsed file from multipart form-data */
export interface ParsedFile {
  /** Original filename */
  filename: string;
  /** MIME type */
  mimetype: string;
  /** File contents as Buffer */
  buffer: Buffer;
  /** File size in bytes */
  size: number;
  /** Form field name */
  fieldname: string;
}

export interface MultipartBodyOptions {
  /**
   * Maximum file size in bytes (default: 10MB).
   * Files exceeding this are rejected with 413.
   */
  maxFileSize?: number;
  /**
   * Maximum number of files (default: 5).
   * Extra files are silently ignored.
   */
  maxFiles?: number;
  /**
   * Allowed MIME types (default: all).
   * Files with disallowed types are rejected with 415.
   *
   * Supports three forms in a single list:
   *   - Exact: `image/png`
   *   - Subtype wildcard: `image/\*` — any `image/…`
   *   - Any:   `\*` or `\*\/\*` — equivalent to omitting the option
   *
   * @example ['image/jpeg', 'image/png', 'application/pdf']
   * @example ['image/*', 'application/pdf']
   * @example ['*']   // accept any type explicitly
   */
  allowedMimeTypes?: string[];
  /**
   * Key on `req.body` where parsed files are attached (default: '_files').
   * Set to a custom key if '_files' conflicts with your schema.
   *
   * Note: this is the **destination** key — it controls where parsed files
   * land on `req.body`, not which form fields are required. To enforce that
   * a specific file field must be present in the request, use `requiredFields`.
   */
  filesKey?: string;
  /**
   * Multipart form field names that MUST be present in the request.
   * Returns 400 with `{ success: false, error, code: 'MISSING_FILE_FIELDS' }`
   * when any listed field is absent from the uploaded files.
   *
   * Only enforced when the request IS multipart — JSON requests still pass
   * through as no-ops so the same middleware stays safe to add to shared
   * create/update routes that accept both content types.
   *
   * @example ['file']                  // single-field upload (OCR, classify)
   * @example ['avatar', 'cover']       // multi-field upload (profile editor)
   */
  requiredFields?: string[];
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_FILES_KEY = "_files";

interface MimeMatcher {
  matches(mime: string): boolean;
  describe(): string;
}

/**
 * Build a matcher for MIME allow-lists that supports exact (e.g. `image/png`),
 * subtype wildcards (e.g. `image/\*`), and total wildcards (`\*` or `\*\/\*`).
 *
 * Returns `undefined` when no filter is needed — either because the option
 * was omitted or because a total wildcard was present.
 */
function buildMimeMatcher(allowed: string[] | undefined): MimeMatcher | undefined {
  if (!allowed || allowed.length === 0) return undefined;

  const exact = new Set<string>();
  const prefixes: string[] = []; // stored without trailing `*` (e.g. `image/`)

  for (const entry of allowed) {
    const value = entry.trim().toLowerCase();
    if (!value) continue;
    if (value === "*" || value === "*/*") return undefined; // any — no filter
    if (value.endsWith("/*")) {
      prefixes.push(value.slice(0, -1)); // `image/*` → `image/`
    } else {
      exact.add(value);
    }
  }

  if (exact.size === 0 && prefixes.length === 0) return undefined;

  return {
    matches(mime: string): boolean {
      const m = mime.toLowerCase();
      if (exact.has(m)) return true;
      for (const p of prefixes) if (m.startsWith(p)) return true;
      return false;
    },
    describe(): string {
      return [...exact, ...prefixes.map((p) => `${p}*`)].join(", ");
    },
  };
}

/**
 * Create a multipart body parsing middleware.
 *
 * When a request has `content-type: multipart/form-data`, this middleware:
 * 1. Reads all parts (fields + files)
 * 2. Sets text fields on `req.body` as a plain object
 * 3. Attaches file buffers to `req.body[filesKey]` (default: `req.body._files`)
 *
 * For non-multipart requests (regular JSON), this is a no-op — the request
 * passes through unchanged. This makes it safe to add to create/update
 * middlewares without breaking JSON clients.
 */
export function multipartBody(options: MultipartBodyOptions = {}): RouteHandlerMethod {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const mimeMatcher = buildMimeMatcher(options.allowedMimeTypes);
  const filesKey = options.filesKey ?? DEFAULT_FILES_KEY;
  const requiredFields =
    options.requiredFields && options.requiredFields.length > 0
      ? options.requiredFields
      : undefined;

  return async function parseMultipartBody(request, reply) {
    // Skip non-multipart requests (JSON, urlencoded, etc.) — no-op
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) return;

    // Verify @fastify/multipart is registered
    if (typeof (request as unknown as Record<string, unknown>).parts !== "function") {
      request.log.warn(
        "multipartBody middleware: @fastify/multipart not registered. " +
          "Ensure createApp() has multipart enabled (default) or install @fastify/multipart.",
      );
      return;
    }

    const body: Record<string, unknown> = {};
    const files: Record<string, ParsedFile> = {};
    let fileCount = 0;

    try {
      const parts = (request as unknown as { parts: () => AsyncIterable<MultipartPart> }).parts();

      for await (const part of parts) {
        if (part.type === "file") {
          if (fileCount >= maxFiles) continue;

          // MIME type check — supports exact, `type/*`, and `*` patterns.
          if (mimeMatcher && !mimeMatcher.matches(part.mimetype)) {
            return reply.code(415).send({
              code: "arc.unsupported_media_type",
              message: `File type '${part.mimetype}' not allowed. Accepted: ${mimeMatcher.describe()}`,
              status: 415,
            });
          }

          const buffer = await part.toBuffer();

          // Size check
          if (buffer.length > maxFileSize) {
            return reply.code(413).send({
              code: "arc.payload_too_large",
              message: `File '${part.filename}' exceeds maximum size of ${Math.round(maxFileSize / 1024 / 1024)}MB`,
              status: 413,
            });
          }

          files[part.fieldname] = {
            filename: part.filename,
            mimetype: part.mimetype,
            buffer,
            size: buffer.length,
            fieldname: part.fieldname,
          };
          fileCount++;
        } else {
          // Text field — attempt JSON parse for nested values
          body[part.fieldname] = tryParseValue(part.value as string);
        }
      }
    } catch (err) {
      request.log.error({ err }, "multipartBody: failed to parse multipart form");
      return reply.code(400).send({
        code: "arc.bad_request",
        message: "Failed to parse multipart form data",
        status: 400,
      });
    }

    // Enforce required file fields — only when multipart parsing actually ran.
    // JSON requests short-circuited at the top and never reach here, preserving
    // the "safe to add to shared create/update routes" property.
    if (requiredFields) {
      const missing = requiredFields.filter((name) => !(name in files));
      if (missing.length > 0) {
        // No-envelope contract: emit canonical ErrorContract directly.
        // HTTP status discriminates success vs error.
        return reply.code(400).send({
          code: "MISSING_FILE_FIELDS",
          message: `Missing required file field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
          status: 400,
          details: { missing },
        });
      }
    }

    // Attach files if any were uploaded
    if (fileCount > 0) {
      body[filesKey] = files;
    }

    // Replace req.body with parsed form fields + files
    // biome-ignore lint: intentional mutation of request body for downstream handlers
    (request as unknown as Record<string, unknown>).body = body;
  };
}

/**
 * Try to parse a form field value as JSON, number, or boolean.
 * Falls back to the raw string if parsing fails.
 */
function tryParseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  // Try number (only if it looks like one — avoid parsing UUIDs, slugs, etc.)
  if (/^-?\d+(\.\d+)?$/.test(value) && value.length < 16) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }

  // Try JSON object/array
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      // Not valid JSON — return as string
    }
  }

  return value;
}

/** @internal — Matches @fastify/multipart's part shape */
interface MultipartPart {
  type: "file" | "field";
  fieldname: string;
  filename: string;
  mimetype: string;
  value: unknown;
  toBuffer: () => Promise<Buffer>;
}
