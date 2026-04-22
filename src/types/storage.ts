/**
 * Arc's minimal backend-agnostic storage contract.
 *
 * Implementations live OUTSIDE arc core. This interface is deliberately
 * small — no variants, no hashing, no CDN transforms, no multi-tenancy
 * policy. Those are adapter concerns.
 *
 * Adapter authors should verify their implementation with
 * `runStorageContract()` from `@classytic/arc/testing/storage` —
 * passing the contract guarantees compatibility with every arc preset
 * that consumes `Storage`.
 *
 * @example
 * ```typescript
 * import type { Storage } from '@classytic/arc/types/storage';
 *
 * export function memoryStorage(): Storage {
 *   const rows = new Map<string, { buffer: Buffer; contentType: string }>();
 *   return {
 *     async upload(input) {
 *       const id = crypto.randomUUID();
 *       rows.set(id, { buffer: input.buffer, contentType: input.mimeType });
 *       return { id, url: `memory://${id}`, pathname: id, contentType: input.mimeType, bytes: input.size };
 *     },
 *     async read(id) {
 *       const row = rows.get(id);
 *       if (!row) throw new Error('Not found');
 *       return { kind: 'buffer', buffer: row.buffer, contentType: row.contentType };
 *     },
 *     async delete(id) { return rows.delete(id); },
 *   };
 * }
 * ```
 */

/**
 * Input passed to `Storage.upload()`.
 * The preset populates this from the parsed multipart file.
 */
export interface StorageUploadInput {
  /** File bytes. */
  buffer: Buffer;
  /** Original filename from the client. */
  filename: string;
  /** IANA media type — preset validates via `multipartBody`. */
  mimeType: string;
  /** Size in bytes. Equals `buffer.length`. */
  size: number;
}

/**
 * Context threaded through every storage call.
 * Adapters decide which keys they care about.
 */
export interface StorageContext {
  /**
   * App-defined scope. Arc populates this from `RequestScope` via the preset's
   * `contextFrom` option so adapters can isolate per-tenant / per-user / per-project.
   */
  scope?: Record<string, unknown>;
  /** Optional request correlation id for logging. */
  requestId?: string;
}

/**
 * Handle returned by `Storage.upload()`.
 * The adapter owns the id namespace and URL format.
 */
export interface StorageFile {
  /** Stable ID — the adapter owns the namespace. Used as the route param for GET/DELETE. */
  id: string;
  /** Public or signed URL — what the frontend stores in an `<img src>`. */
  url: string;
  /** Storage-side path / key. Opaque to arc; useful for admin tooling. */
  pathname: string;
  /** IANA media type — usually echoed from `input.mimeType`. */
  contentType: string;
  /** Size in bytes. */
  bytes: number;
  /** Adapter-defined metadata passed through to the response body. */
  metadata?: Record<string, unknown>;
}

/**
 * Optional byte range for partial reads.
 * End-inclusive, matching HTTP `Range: bytes=start-end` semantics and
 * media-kit's `StorageDriver.read()` contract.
 */
export interface StorageReadRange {
  /** First byte offset (inclusive). */
  start: number;
  /** Last byte offset (inclusive). */
  end: number;
}

/**
 * Result of `Storage.read()`.
 * Adapters pick whichever shape is natural; the preset handler branches on `kind`.
 * Large/remote backends should return a stream; small/in-memory backends can
 * return a buffer without wrapping it in a `PassThrough` for no reason.
 */
export type StorageReadResult =
  | {
      kind: "stream";
      stream: NodeJS.ReadableStream;
      contentType: string;
      /** Total size of the full object (NOT the ranged slice). Required for `Content-Range`. */
      bytes?: number;
      /** Actual byte range returned when the caller passed `range`. */
      range?: StorageReadRange;
    }
  | {
      kind: "buffer";
      buffer: Buffer;
      contentType: string;
      /** Total size of the full object. Used for `Content-Range` on partial reads. */
      totalBytes?: number;
      /** Actual byte range returned when the caller passed `range`. */
      range?: StorageReadRange;
    };

/**
 * Minimal storage contract consumed by `filesUploadPreset`.
 *
 * Adapters are ~50–100 LOC wrappers around S3, GCS, local FS, GridFS,
 * media-kit, or a provider Files API. Ship zero reference adapters in
 * arc core — the one you'd pick is always the wrong default.
 */
export interface Storage {
  /** Write bytes, return a stable handle. */
  upload(input: StorageUploadInput, ctx: StorageContext): Promise<StorageFile>;

  /**
   * Read bytes by id. Streaming preferred; Buffer fine for small files.
   *
   * If `range` is provided, implementations SHOULD return only the requested
   * slice and set `range` on the result. Implementations that cannot range
   * (e.g. trivial in-memory adapters) MAY return the full object and let the
   * preset slice it — the preset handles both cases.
   */
  read(id: string, ctx: StorageContext, range?: StorageReadRange): Promise<StorageReadResult>;

  /**
   * Remove bytes by id. MAY be a soft delete — the interface doesn't
   * dictate lifecycle. Return `false` when the id was already absent.
   */
  delete(id: string, ctx: StorageContext): Promise<boolean>;

  /** Optional — fast existence check without a full read. */
  exists?(id: string, ctx: StorageContext): Promise<boolean>;

  /**
   * Optional — return a fresh URL for an existing id. Called by the preset
   * when the stored `url` may have expired (signed URLs, rotated buckets).
   * Default behavior when omitted: the preset falls back to the url stored
   * on the original `upload()` result.
   */
  resolveUrl?(id: string, ctx: StorageContext): Promise<string>;
}
