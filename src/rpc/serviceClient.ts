/**
 * Service Client — Resource-Oriented RPC
 *
 * Typed HTTP client that speaks Arc's resource protocol.
 * Built for microservice-to-microservice communication with:
 * - correlationId propagation (distributed tracing)
 * - Retry with exponential backoff (transient failure recovery)
 * - Circuit breaker integration (cascading failure prevention)
 * - Error normalization (consistent error handling)
 * - Lifecycle hooks (observability)
 *
 * Zero external dependencies — uses native fetch + Arc's CircuitBreaker.
 *
 * @example
 * ```typescript
 * import { createServiceClient } from '@classytic/arc/rpc';
 *
 * const catalog = createServiceClient({
 *   baseUrl: 'http://catalog-service:3000',
 *   token: () => getServiceToken(),
 *   correlationId: () => request.id, // propagate trace context
 *   organizationId: req.scope.organizationId,
 *   retry: { maxRetries: 2, backoffMs: 200 },
 *   circuitBreaker: { failureThreshold: 5, resetTimeout: 30000 },
 *   onResponse: ({ method, url, status, durationMs }) => {
 *     metrics.histogram('rpc_duration', durationMs, { method, url, status });
 *   },
 * });
 *
 * const products = await catalog.resource('product').list({ filters: { active: true } });
 * ```
 */

import { CircuitBreaker, type CircuitBreakerOptions } from "../utils/circuitBreaker.js";

// ============================================================================
// Types
// ============================================================================

export interface RetryConfig {
  /** Max retry attempts (not counting initial attempt). Default: 2 */
  maxRetries?: number;
  /** Initial backoff delay in ms. Doubles on each retry. Default: 200 */
  backoffMs?: number;
  /** Max backoff cap in ms. Default: 5000 */
  maxBackoffMs?: number;
  /**
   * HTTP status codes to retry on. Default: [502, 503, 504, 408, 429]
   * 4xx errors (except 408, 429) are NOT retried — they are client errors.
   */
  retryableStatuses?: number[];
}

export interface RequestInfo {
  method: string;
  url: string;
  headers?: Record<string, string>;
}

export interface ResponseInfo {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  retries: number;
}

export interface ServiceClientOptions {
  /** Base URL of the remote Arc service (e.g., 'http://catalog-service:3000') */
  baseUrl: string;
  /** Static bearer token, or function that returns one (for rotation) */
  token?: string | (() => string);
  /** Organization ID — sent as x-organization-id header */
  organizationId?: string;
  /**
   * Correlation ID for distributed tracing — sent as x-request-id header.
   * Static string or function (e.g., () => request.id from current request context).
   */
  correlationId?: string | (() => string);
  /** Schema version — sent as x-arc-schema-version header for contract compatibility */
  schemaVersion?: string;
  /** Additional headers sent with every request */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
  /** Retry config for transient failures (default: disabled) */
  retry?: RetryConfig;
  /** Circuit breaker config (default: disabled) */
  circuitBreaker?: Pick<
    CircuitBreakerOptions,
    "failureThreshold" | "resetTimeout" | "timeout" | "successThreshold"
  >;
  /** Health check path (default: '/_health/live' — matches Arc's health plugin) */
  healthPath?: string;
  /** Called before each request (for logging, metrics, tracing) */
  onRequest?: (info: RequestInfo) => void;
  /** Called after each response (for logging, metrics, tracing) */
  onResponse?: (info: ResponseInfo) => void;
}

export interface ResourceClient {
  /** GET /{resource}s?...query */
  list(query?: Record<string, unknown>): Promise<ServiceResponse>;
  /** GET /{resource}s/:id */
  get(id: string): Promise<ServiceResponse>;
  /** POST /{resource}s */
  create(data: Record<string, unknown>): Promise<ServiceResponse>;
  /** PATCH /{resource}s/:id */
  update(id: string, data: Record<string, unknown>): Promise<ServiceResponse>;
  /** DELETE /{resource}s/:id */
  delete(id: string): Promise<ServiceResponse>;
  /** POST /{resource}s/:id/action */
  action(id: string, actionName: string, data?: Record<string, unknown>): Promise<ServiceResponse>;
}

export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  status?: number;
  meta?: Record<string, unknown>;
}

export interface ServiceClient {
  /** Get a typed resource client for CRUD + actions */
  resource(name: string): ResourceClient;
  /** Raw call to any path (for non-resource endpoints) */
  call(method: string, path: string, body?: unknown): Promise<ServiceResponse>;
  /** Health check — returns true if service is reachable */
  health(): Promise<boolean>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RETRYABLE_STATUSES = [502, 503, 504, 408, 429];

// ============================================================================
// Implementation
// ============================================================================

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  const {
    baseUrl,
    token,
    organizationId,
    correlationId,
    schemaVersion,
    headers: extraHeaders = {},
    timeout = 10000,
    retry: retryConfig,
    circuitBreaker: cbOpts,
    healthPath = "/_health/live",
    onRequest,
    onResponse,
  } = options;

  const base = baseUrl.replace(/\/+$/, "");

  // Circuit breaker (optional)
  let breaker: CircuitBreaker<typeof singleFetch> | undefined;
  if (cbOpts) {
    breaker = new CircuitBreaker(singleFetch, {
      name: `service-client:${base}`,
      failureThreshold: cbOpts.failureThreshold ?? 5,
      resetTimeout: cbOpts.resetTimeout ?? 60000,
      timeout: cbOpts.timeout ?? timeout,
      successThreshold: cbOpts.successThreshold ?? 1,
    });
  }

  // -----------------------------------------------------------------------
  // Headers
  // -----------------------------------------------------------------------

  function buildHeaders(hasBody = false): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      ...extraHeaders,
    };

    if (hasBody) {
      h["content-type"] = "application/json";
    }

    const resolvedToken = typeof token === "function" ? token() : token;
    if (resolvedToken) {
      h.authorization = `Bearer ${resolvedToken}`;
    }

    if (organizationId) {
      h["x-organization-id"] = organizationId;
    }

    if (schemaVersion) {
      h["x-arc-schema-version"] = schemaVersion;
    }

    // Distributed tracing — propagate correlation ID
    const resolvedCorrelationId =
      typeof correlationId === "function" ? correlationId() : correlationId;
    if (resolvedCorrelationId) {
      h["x-request-id"] = resolvedCorrelationId;
    }

    return h;
  }

  // -----------------------------------------------------------------------
  // Single fetch (no retry, used by circuit breaker and retry loop)
  // -----------------------------------------------------------------------

  async function singleFetch(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: ServiceResponse }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const hasBody = !!init.body;
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...buildHeaders(hasBody),
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });

      // Parse response — handle non-JSON gracefully
      let body: ServiceResponse;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        body = (await response.json()) as ServiceResponse;
      } else {
        // Non-JSON response (HTML error page, plain text, etc.)
        const text = await response.text();
        body = {
          success: false,
          error: response.statusText || "Unknown error",
          message: text.slice(0, 200), // Truncate long HTML
          status: response.status,
        };
      }

      // Normalize: ensure status is always present
      if (body.status === undefined) {
        body.status = response.status;
      }

      // Normalize: set success based on HTTP status when not explicitly set
      if (body.success === undefined) {
        body.success = response.ok;
      }

      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------------
  // Execute with retry + circuit breaker + hooks
  // -----------------------------------------------------------------------

  async function execute(method: string, url: string, init: RequestInit): Promise<ServiceResponse> {
    const startTime = performance.now();
    let lastResponse: ServiceResponse | undefined;
    let retries = 0;

    const maxRetries = retryConfig?.maxRetries ?? 0;
    const backoffMs = retryConfig?.backoffMs ?? 200;
    const maxBackoffMs = retryConfig?.maxBackoffMs ?? 5000;
    const retryableStatuses = retryConfig?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

    // Lifecycle: onRequest
    onRequest?.({ method, url });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let result: { response: Response; body: ServiceResponse };

        if (breaker) {
          result = await breaker.call(url, init);
        } else {
          result = await singleFetch(url, init);
        }

        lastResponse = result.body;

        // Success or non-retryable status — return immediately
        if (result.response.ok || !retryableStatuses.includes(result.response.status)) {
          onResponse?.({
            method,
            url,
            status: result.response.status,
            durationMs: performance.now() - startTime,
            retries,
          });
          return result.body;
        }

        // Retryable status — retry if attempts remaining
        if (attempt < maxRetries) {
          retries++;
          const delay = Math.min(backoffMs * 2 ** attempt, maxBackoffMs);
          await sleep(delay);
          continue;
        }

        // Exhausted retries — return last error
        onResponse?.({
          method,
          url,
          status: result.response.status,
          durationMs: performance.now() - startTime,
          retries,
        });
        return result.body;
      } catch (err) {
        // Network error, timeout, or circuit breaker open
        if (attempt < maxRetries) {
          retries++;
          const delay = Math.min(backoffMs * 2 ** attempt, maxBackoffMs);
          await sleep(delay);
          continue;
        }

        // Exhausted retries — normalize error
        const error = err instanceof Error ? err : new Error(String(err));
        lastResponse = {
          success: false,
          error: error.message,
          status: 0, // No HTTP status for network errors
        };

        onResponse?.({
          method,
          url,
          status: 0,
          durationMs: performance.now() - startTime,
          retries,
        });

        // If no retry configured, throw for circuit breaker errors
        if (maxRetries === 0) {
          throw error;
        }

        return lastResponse;
      }
    }

    return lastResponse ?? { success: false, error: "Unknown error", status: 0 };
  }

  // -----------------------------------------------------------------------
  // Query string builder
  // -----------------------------------------------------------------------

  function toQueryString(query?: Record<string, unknown>): string {
    if (!query || Object.keys(query).length === 0) return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        if (typeof value === "object") {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v !== undefined && v !== null) {
              params.set(k, String(v));
            }
          }
        } else {
          params.set(key, String(value));
        }
      }
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  function plural(name: string): string {
    if (name.endsWith("s")) return name;
    if (
      name.endsWith("y") &&
      !name.endsWith("ay") &&
      !name.endsWith("ey") &&
      !name.endsWith("oy") &&
      !name.endsWith("uy")
    ) {
      return `${name.slice(0, -1)}ies`;
    }
    return `${name}s`;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    resource(name: string): ResourceClient {
      const prefix = `${base}/${plural(name)}`;

      return {
        async list(query?: Record<string, unknown>): Promise<ServiceResponse> {
          const qs = toQueryString(
            query?.filters ? (query.filters as Record<string, unknown>) : query,
          );
          return execute("GET", `${prefix}${qs}`, { method: "GET" });
        },

        async get(id: string): Promise<ServiceResponse> {
          return execute("GET", `${prefix}/${id}`, { method: "GET" });
        },

        async create(data: Record<string, unknown>): Promise<ServiceResponse> {
          return execute("POST", prefix, { method: "POST", body: JSON.stringify(data) });
        },

        async update(id: string, data: Record<string, unknown>): Promise<ServiceResponse> {
          return execute("PATCH", `${prefix}/${id}`, {
            method: "PATCH",
            body: JSON.stringify(data),
          });
        },

        async delete(id: string): Promise<ServiceResponse> {
          return execute("DELETE", `${prefix}/${id}`, { method: "DELETE" });
        },

        async action(
          id: string,
          actionName: string,
          data?: Record<string, unknown>,
        ): Promise<ServiceResponse> {
          return execute("POST", `${prefix}/${id}/action`, {
            method: "POST",
            body: JSON.stringify({ action: actionName, ...data }),
          });
        },
      };
    },

    async call(method: string, path: string, body?: unknown): Promise<ServiceResponse> {
      const url = `${base}${path}`;
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return execute(method, url, init);
    },

    async health(): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const res = await fetch(`${base}${healthPath}`, {
            method: "GET",
            signal: controller.signal,
            headers: buildHeaders(),
          });
          return res.ok;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return false;
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
