/**
 * Plugin-specific option shapes for `createApp()` — under-pressure,
 * multipart, and raw-body plugin configuration.
 */

export interface UnderPressureOptions {
  /** Expose `/_status` route for health checks (default: false) */
  exposeStatusRoute?: boolean;
  /** Event loop lag threshold in ms — requests rejected above this (default: 1000) */
  maxEventLoopDelay?: number;
  /** Event loop utilization threshold (0–1) — requests rejected above this */
  maxEventLoopUtilization?: number;
  /** V8 heap usage threshold in bytes — requests rejected above this */
  maxHeapUsedBytes?: number;
  /** RSS memory threshold in bytes — requests rejected above this */
  maxRssBytes?: number;
}

export interface MultipartOptions {
  limits?: {
    /** Max file size in bytes (default: Fastify default ~1MB) */
    fileSize?: number;
    /** Max number of files per request */
    files?: number;
  };
}

export interface RawBodyOptions {
  /** Body field name to store raw body on (default: 'rawBody') */
  field?: string;
  /** Apply to all routes globally (default: false) */
  global?: boolean;
  /** Encoding for raw body string (default: 'utf8') */
  encoding?: string;
  /** Parse raw body before other parsers (default: false) */
  runFirst?: boolean;
}
