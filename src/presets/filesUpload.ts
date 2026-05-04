/**
 * Files Upload Preset — backend-agnostic file uploads for arc resources.
 *
 * Consumes the `Storage` interface from `@classytic/arc/types/storage` and
 * registers three routes on the owning resource:
 *
 *   POST   /upload   → multipartBody → storage.upload → envelope
 *   GET    /:id      → storage.read → stream/buffer (with HTTP Range support)
 *   DELETE /:id      → storage.delete → 204 / 404
 *
 * Arc ships **zero** reference `Storage` adapters on purpose — storage is the
 * single most app-specific decision in an upload pipeline (dedup, multi-tenancy
 * policy, CDN integration, soft-delete TTL). Write a 50-line adapter in your
 * app source and pass it here.
 *
 * @example
 * ```typescript
 * import { defineResource } from '@classytic/arc';
 * import { filesUploadPreset } from '@classytic/arc/presets/files-upload';
 * import { s3Storage } from './storage/s3-storage.js';
 *
 * export const fileResource = defineResource({
 *   name: 'file',
 *   prefix: '/files',
 *   disableDefaultRoutes: true, // preset owns every route
 *   presets: [
 *     filesUploadPreset({
 *       storage: s3Storage({ bucket: 'my-app', ... }),
 *       allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf'],
 *       maxFileSize: 5 * 1024 * 1024,
 *     }),
 *   ],
 * });
 * ```
 */

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { multipartBody } from "../middleware/multipartBody.js";
import { allowPublic, requireAuth } from "../permissions/index.js";
import type { RequestScope } from "../scope/types.js";
import { getOrgId, getUserId } from "../scope/types.js";
import type {
  PermissionCheck,
  PresetResult,
  ResourcePermissions,
  RouteDefinition,
} from "../types/index.js";
import type {
  Storage,
  StorageContext,
  StorageFile,
  StorageReadRange,
  StorageReadResult,
} from "../types/storage.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";

// ============================================================================
// Options
// ============================================================================

export interface FilesUploadPresetRoutes {
  upload?: boolean;
  read?: boolean;
  delete?: boolean;
}

export interface FilesUploadPresetPermissions {
  upload?: PermissionCheck;
  read?: PermissionCheck;
  delete?: PermissionCheck;
}

/**
 * Filename policy — controls how user-supplied filenames are validated before
 * reaching the `Storage.upload()` adapter.
 *
 * - `true` (default): strict — rejects path separators, NULs, `.`/`..`, empty,
 *   and names >255 chars. Safe default for disk/S3/prefix-joining adapters.
 * - `false` | `'*'`: accept any filename verbatim. Use when the filename is a
 *   user-supplied *label* and the adapter generates the storage key itself —
 *   typical for microservice ingress, API-server proxies, or content stores
 *   that use `id` for the path and treat `filename` as metadata.
 * - function: custom policy. Return a string to *transform* the filename,
 *   `false` to reject (triggers `ValidationError`), or `true`/`void` to accept.
 */
export type FilenamePolicy = boolean | "*" | ((filename: string) => string | boolean | undefined);

export interface FilesUploadPresetOptions {
  /** Any implementation of the `Storage` interface. App owns it. */
  storage: Storage;

  /** Multipart form field name. Default: `'file'`. */
  fieldName?: string;

  /** Max bytes per file. Forwarded to `multipartBody`. Default: 10 MB. */
  maxFileSize?: number;

  /**
   * IANA MIME allow-list. Forwarded to `multipartBody`. Default: no filter.
   * Pass `['*']` to explicitly allow any type (equivalent to omitting).
   */
  allowedMimeTypes?: string[];

  /**
   * Filename validation policy. Default: `true` (strict).
   * See {@link FilenamePolicy}.
   */
  sanitizeFilename?: FilenamePolicy;

  /**
   * Per-route permissions.
   * Defaults: upload → `requireAuth()`, read → `allowPublic()`, delete → `requireAuth()`.
   */
  permissions?: FilesUploadPresetPermissions;

  /** Opt out of individual routes. Default: all three enabled. */
  includeRoutes?: FilesUploadPresetRoutes;

  /**
   * Map arc's `RequestScope` to `StorageContext.scope`.
   * Default: `{ userId, organizationId }` extracted via `getUserId` / `getOrgId`.
   * Adapters ignore keys they don't care about.
   */
  contextFrom?: (scope: RequestScope | undefined) => Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FIELD_NAME = "file";
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ============================================================================
// Helpers
// ============================================================================

function defaultContextFrom(scope: RequestScope | undefined): Record<string, unknown> {
  if (!scope) return {};
  const userId = getUserId(scope);
  const organizationId = getOrgId(scope);
  const ctx: Record<string, unknown> = {};
  if (userId !== undefined) ctx.userId = userId;
  if (organizationId !== undefined) ctx.organizationId = organizationId;
  return ctx;
}

function buildStorageContext(
  request: FastifyRequest,
  contextFrom: (scope: RequestScope | undefined) => Record<string, unknown>,
): StorageContext {
  const scope = (request as unknown as { scope?: RequestScope }).scope;
  return {
    scope: contextFrom(scope),
    requestId: request.id,
  };
}

/**
 * Parse a single-range `Range: bytes=start-end` header.
 *
 * Returns `undefined` when the header is missing or unparseable. Only
 * satisfiable single ranges are supported — multi-range requests fall through
 * to the full-object response (per RFC 7233 §4.1 a server MAY ignore ranges).
 */
function parseRangeHeader(
  header: string | undefined,
  totalSize: number | undefined,
): StorageReadRange | undefined {
  if (!header?.startsWith("bytes=")) return undefined;
  const spec = header.slice("bytes=".length).split(",")[0]?.trim();
  if (!spec) return undefined;

  const dashIndex = spec.indexOf("-");
  if (dashIndex === -1) return undefined;

  const startRaw = spec.slice(0, dashIndex);
  const endRaw = spec.slice(dashIndex + 1);

  // Suffix range: `-N` → last N bytes. Requires known totalSize.
  if (startRaw === "") {
    if (totalSize === undefined) return undefined;
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return undefined;

  // Open-ended range: `N-` → from N to end. Requires known totalSize.
  if (endRaw === "") {
    if (totalSize === undefined) return undefined;
    return { start, end: totalSize - 1 };
  }

  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < start) return undefined;
  if (totalSize !== undefined && end >= totalSize) {
    return { start, end: totalSize - 1 };
  }
  return { start, end };
}

// ============================================================================
// Route handlers
// ============================================================================

interface HandlerDeps {
  readonly storage: Storage;
  readonly fieldName: string;
  readonly contextFrom: (scope: RequestScope | undefined) => Record<string, unknown>;
  readonly applyFilenamePolicy: (filename: string) => string;
}

/**
 * Strict policy — rejects filenames that could escape a storage root or
 * confuse a filesystem. Safe default for disk/S3 adapters that compose
 * `${prefix}/${filename}` or `path.join(root, filename)`.
 */
function strictFilenamePolicy(filename: string): string {
  if (filename.length === 0) {
    throw new ValidationError("Upload filename is empty");
  }
  if (filename.length > 255) {
    throw new ValidationError("Upload filename exceeds 255 characters");
  }
  if (filename.includes("\0")) {
    throw new ValidationError("Upload filename contains a NUL byte");
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new ValidationError("Upload filename contains a path separator");
  }
  if (filename === "." || filename === "..") {
    throw new ValidationError("Upload filename is a path traversal component");
  }
  return filename;
}

/** Resolve the user-supplied policy option into a concrete validator. */
function resolveFilenamePolicy(policy: FilenamePolicy | undefined): (filename: string) => string {
  if (policy === undefined || policy === true) return strictFilenamePolicy;
  if (policy === false || policy === "*") return (f) => f;
  if (typeof policy === "function") {
    return (filename: string): string => {
      const result = policy(filename);
      if (result === false) {
        throw new ValidationError(`Upload filename rejected: ${filename}`);
      }
      if (typeof result === "string") return result;
      return filename;
    };
  }
  return strictFilenamePolicy;
}

function makeUploadHandler(deps: HandlerDeps): RouteHandlerMethod {
  return async function uploadHandler(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as Record<string, unknown> | null | undefined;
    const filesContainer = body?._files as Record<string, unknown> | undefined;
    const file = filesContainer?.[deps.fieldName] as
      | { buffer: Buffer; filename: string; mimetype: string; size: number }
      | undefined;

    if (!file) {
      throw new ValidationError(`Missing file field '${deps.fieldName}' in multipart body`);
    }

    const filename = deps.applyFilenamePolicy(file.filename);

    const ctx = buildStorageContext(request, deps.contextFrom);
    const result = await deps.storage.upload(
      {
        buffer: file.buffer,
        filename,
        mimeType: file.mimetype,
        size: file.size,
      },
      ctx,
    );

    // No-envelope contract: emit the file payload raw.
    return reply.code(201).send(toResponseFile(result));
  };
}

function toResponseFile(file: StorageFile): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: file.id,
    url: file.url,
    pathname: file.pathname,
    contentType: file.contentType,
    bytes: file.bytes,
  };
  if (file.metadata !== undefined) payload.metadata = file.metadata;
  return payload;
}

function makeReadHandler(deps: HandlerDeps): RouteHandlerMethod {
  return async function readHandler(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const ctx = buildStorageContext(request, deps.contextFrom);

    // Advertise range support on every GET so clients know they can ask.
    reply.header("Accept-Ranges", "bytes");

    const rangeHeader = request.headers.range;

    let result: StorageReadResult;
    try {
      // First attempt: pass the requested range through to the adapter. Pass `undefined`
      // when there's no Range header so adapters without range support aren't forced to parse.
      const parsed = rangeHeader ? parseRangeHeader(rangeHeader, undefined) : undefined;
      result = await deps.storage.read(id, ctx, parsed);
    } catch (err) {
      throw toNotFound(err, "File", id);
    }

    if (result.kind === "buffer") {
      return sendBuffer(reply, result, rangeHeader);
    }
    return sendStream(reply, result, rangeHeader);
  };
}

function sendBuffer(
  reply: FastifyReply,
  result: Extract<StorageReadResult, { kind: "buffer" }>,
  rangeHeader: string | undefined,
): FastifyReply {
  reply.type(result.contentType);

  const total = result.totalBytes ?? result.buffer.length;

  // Adapter already honored the range → echo Content-Range and stop.
  if (result.range) {
    const { start, end } = result.range;
    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
    reply.header("Content-Length", String(result.buffer.length));
    return reply.send(result.buffer);
  }

  // Client asked for a range but the adapter returned the full buffer → slice here.
  if (rangeHeader) {
    const parsed = parseRangeHeader(rangeHeader, total);
    if (parsed) {
      const slice = result.buffer.subarray(parsed.start, parsed.end + 1);
      reply.code(206);
      reply.header("Content-Range", `bytes ${parsed.start}-${parsed.end}/${total}`);
      reply.header("Content-Length", String(slice.length));
      return reply.send(slice);
    }
  }

  reply.header("Content-Length", String(result.buffer.length));
  return reply.send(result.buffer);
}

function sendStream(
  reply: FastifyReply,
  result: Extract<StorageReadResult, { kind: "stream" }>,
  rangeHeader: string | undefined,
): FastifyReply {
  reply.type(result.contentType);

  if (result.range && result.bytes !== undefined) {
    const { start, end } = result.range;
    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${result.bytes}`);
    reply.header("Content-Length", String(end - start + 1));
  } else if (result.bytes !== undefined) {
    reply.header("Content-Length", String(result.bytes));
    // If the client asked for a range but the adapter returned an unsliced stream,
    // we can't safely slice it here without buffering the whole thing. RFC 7233 §4.1
    // allows a server to answer a Range request with a full 200 response.
    if (rangeHeader) {
      reply.request.log.debug(
        { url: reply.request.url },
        "filesUploadPreset: adapter returned unsliced stream for a range request — sending full object",
      );
    }
  }

  return reply.send(result.stream);
}

function makeDeleteHandler(deps: HandlerDeps): RouteHandlerMethod {
  return async function deleteHandler(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const ctx = buildStorageContext(request, deps.contextFrom);

    const removed = await deps.storage.delete(id, ctx);
    if (!removed) {
      throw new NotFoundError("File", id);
    }
    return reply.code(204).send();
  };
}

function toNotFound(err: unknown, resource: string, id: string): Error {
  if (err instanceof NotFoundError) return err;
  const maybe = err as { code?: string; statusCode?: number; message?: string };
  if (maybe?.statusCode === 404 || maybe?.code === "NOT_FOUND") {
    return new NotFoundError(resource, id);
  }
  if (typeof maybe?.message === "string" && /not\s*found/i.test(maybe.message)) {
    return new NotFoundError(resource, id);
  }
  return err as Error;
}

// ============================================================================
// Preset factory
// ============================================================================

/**
 * Create a files-upload preset bound to a `Storage` adapter.
 *
 * The preset uses `raw: true` routes so binary responses bypass arc's JSON
 * envelope. Upload still returns the standard `{ success: true, data }`
 * envelope manually because the response is structured metadata, not bytes.
 */
export function filesUploadPreset(options: FilesUploadPresetOptions): PresetResult {
  if (!options?.storage) {
    throw new Error("filesUploadPreset: `storage` is required");
  }

  const deps: HandlerDeps = {
    storage: options.storage,
    fieldName: options.fieldName ?? DEFAULT_FIELD_NAME,
    contextFrom: options.contextFrom ?? defaultContextFrom,
    applyFilenamePolicy: resolveFilenamePolicy(options.sanitizeFilename),
  };

  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const allowedMimeTypes = options.allowedMimeTypes;
  const includeRoutes: Required<FilesUploadPresetRoutes> = {
    upload: options.includeRoutes?.upload ?? true,
    read: options.includeRoutes?.read ?? true,
    delete: options.includeRoutes?.delete ?? true,
  };

  return {
    name: "filesUpload",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => {
      const routes: RouteDefinition[] = [];

      if (includeRoutes.upload) {
        routes.push({
          method: "POST",
          path: "/upload",
          operation: "filesUpload.upload",
          summary: "Upload a file",
          description:
            "Accepts a multipart/form-data request and persists the bytes via the configured Storage adapter.",
          permissions: options.permissions?.upload ?? permissions.create ?? requireAuth(),
          preHandler: [
            multipartBody({
              maxFileSize,
              allowedMimeTypes,
              // Let the middleware emit the 400 for us — handler can assume
              // the file field is present by the time it runs.
              requiredFields: [deps.fieldName],
            }),
          ],
          raw: true,
          handler: makeUploadHandler(deps),
          // No response schema — the envelope shape is stable and Fastify's
          // AJV strict mode would reject the adapter-defined `metadata` bag.
        });
      }

      if (includeRoutes.read) {
        routes.push({
          method: "GET",
          path: "/:id",
          operation: "filesUpload.read",
          summary: "Download a file",
          description: "Streams the stored bytes. Supports single-range `Range: bytes=start-end`.",
          permissions: options.permissions?.read ?? permissions.get ?? allowPublic(),
          raw: true,
          handler: makeReadHandler(deps),
          // MCP tool generation skipped — binary routes aren't useful as MCP tools.
          mcp: false,
        });
      }

      if (includeRoutes.delete) {
        routes.push({
          method: "DELETE",
          path: "/:id",
          operation: "filesUpload.delete",
          summary: "Delete a file",
          permissions: options.permissions?.delete ?? permissions.delete ?? requireAuth(),
          raw: true,
          handler: makeDeleteHandler(deps),
        });
      }

      return routes;
    },
  };
}

// ============================================================================
// Re-exports — convenient one-stop import for preset users
// ============================================================================

export type {
  Storage,
  StorageContext,
  StorageFile,
  StorageReadRange,
  StorageReadResult,
  StorageUploadInput,
} from "../types/storage.js";
