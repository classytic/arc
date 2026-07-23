/**
 * Health Check Plugin
 *
 * Kubernetes-ready health endpoints:
 * - /health/live  - Liveness probe (is the process alive?)
 * - /health/ready - Readiness probe (can we serve traffic?)
 * - /health/metrics - Prometheus metrics (optional)
 *
 * @example
 * import { healthPlugin } from '@classytic/arc';
 *
 * await fastify.register(healthPlugin, {
 *   prefix: '/_health',
 *   checks: [
 *     { name: 'mongodb', check: async () => mongoose.connection.readyState === 1 },
 *     { name: 'redis', check: async () => redis.ping() === 'PONG' },
 *   ],
 * });
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface HealthCheck {
  /** Name of the dependency */
  name: string;
  /**
   * Function that returns true if healthy, false otherwise.
   *
   * Receives an `AbortSignal` aborted when the check's timeout elapses —
   * pass it to fetch/driver calls so a stalled dependency probe actually
   * STOPS instead of accumulating an abandoned operation per readiness
   * poll. Ignoring the parameter is fine (back-compat): the timeout still
   * bounds how long the PROBE waits, just not the underlying work.
   */
  check: (signal?: AbortSignal) => Promise<boolean> | boolean;
  /** Optional timeout in ms (default: 5000) */
  timeout?: number;
  /** Whether this check is critical for readiness (default: true) */
  critical?: boolean;
}

export interface HealthOptions {
  /** Route prefix (default: '/_health') */
  prefix?: string;
  /** Health check dependencies */
  checks?: readonly HealthCheck[];
  /** Enable metrics endpoint (default: false) */
  metrics?: boolean;
  /** Custom metrics collector function */
  metricsCollector?: () => Promise<string> | string;
  /** Version info to include in responses */
  version?: string;
  /** Collect HTTP request metrics (default: true if metrics enabled) */
  collectHttpMetrics?: boolean;
}

/** A named source of readiness checks, used for collision diagnostics. */
export interface HealthCheckGroup {
  owner: string;
  checks?: readonly HealthCheck[];
}

/**
 * Merge health checks without losing ownership information.
 *
 * Check names are the identity used in readiness responses and criticality
 * lookup, so duplicates are ambiguous and fail at boot instead of silently
 * picking the first declaration. Input order is preserved.
 */
export function mergeHealthChecks(groups: readonly HealthCheckGroup[]): HealthCheck[] {
  const owners = new Map<string, string>();
  const merged: HealthCheck[] = [];

  for (const group of groups) {
    for (const check of group.checks ?? []) {
      const prior = owners.get(check.name);
      if (prior !== undefined) {
        throw new Error(
          `[arc] duplicate health-check name "${check.name}" — declared by ${prior} and ${group.owner}. Health-check names must be unique.`,
        );
      }
      owners.set(check.name, group.owner);
      merged.push(check);
    }
  }

  return merged;
}

interface CheckResult {
  name: string;
  healthy: boolean;
  duration: number;
  error?: string;
}

// Metrics storage (instance-scoped to avoid contamination between app instances)

/**
 * Fixed histogram bucket upper bounds (ms). Recording is O(#buckets) per
 * request; the scrape derives quantile UPPER BOUNDS from cumulative counts
 * in O(#buckets) — no sample retention, no per-scrape sort (the previous
 * 10k-sample ring buffer copied + sorted on EVERY scrape), and bucket
 * counts aggregate correctly across instances.
 */
const DURATION_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

interface HttpMetrics {
  requestsTotal: Record<string, number>;
  /** Count per DURATION_BUCKETS_MS bound, plus one overflow slot at the end. */
  durationBuckets: number[];
  durationCount: number;
  durationSumMs: number;
  startTime: number;
}

function createHttpMetrics(): HttpMetrics {
  return {
    requestsTotal: {},
    durationBuckets: new Array(DURATION_BUCKETS_MS.length + 1).fill(0),
    durationCount: 0,
    durationSumMs: 0,
    startTime: Date.now(),
  };
}

/** Smallest bucket upper bound whose cumulative count reaches `q × total`. */
function bucketQuantile(metrics: HttpMetrics, q: number): number {
  const target = Math.ceil(metrics.durationCount * q);
  let cumulative = 0;
  for (let i = 0; i < metrics.durationBuckets.length; i++) {
    cumulative += metrics.durationBuckets[i] ?? 0;
    if (cumulative >= target) {
      return DURATION_BUCKETS_MS[i] ?? DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1] ?? 0;
    }
  }
  return DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1] ?? 0;
}

const healthPlugin: FastifyPluginAsync<HealthOptions> = async (
  fastify: FastifyInstance,
  opts: HealthOptions = {},
) => {
  const {
    prefix = "/_health",
    checks = [],
    metrics = false,
    metricsCollector,
    version,
    collectHttpMetrics = metrics,
  } = opts;
  const readinessChecks = mergeHealthChecks([{ owner: "healthPlugin options", checks }]);

  // Instance-scoped metrics — each Fastify instance gets its own counters
  const httpMetrics = createHttpMetrics();

  // ========================================
  // Bare Prefix — convenience alias for `${prefix}/live`
  // ========================================
  // Many uptime checkers + load balancers default to `GET /<prefix>`
  // (no sub-path) and treat 200 as "alive". Without this alias the
  // plugin "registered at /_health" but a bare GET 404'd — surfacing
  // as a confusing log/route mismatch.

  fastify.get(
    prefix,
    {
      schema: {
        tags: ["Health"],
        summary: "Liveness probe (alias for /live)",
        description: "Returns 200 if the process is alive",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              timestamp: { type: "string" },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      ...(version ? { version } : {}),
    }),
  );

  // ========================================
  // Liveness Probe
  // ========================================

  fastify.get(
    `${prefix}/live`,
    {
      schema: {
        tags: ["Health"],
        summary: "Liveness probe",
        description: "Returns 200 if the process is alive",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              timestamp: { type: "string" },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async () => {
      return {
        status: "ok",
        timestamp: new Date().toISOString(),
        ...(version ? { version } : {}),
      };
    },
  );

  // ========================================
  // Readiness Probe
  // ========================================

  fastify.get(
    `${prefix}/ready`,
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness probe",
        description: "Returns 200 if all dependencies are healthy",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ready", "not_ready"] },
              timestamp: { type: "string" },
              checks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    healthy: { type: "boolean" },
                    duration: { type: "number" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
          503: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["not_ready"] },
              timestamp: { type: "string" },
              checks: { type: "array" },
            },
          },
        },
      },
    },
    async (_, reply) => {
      const results = await runChecks(readinessChecks);
      const criticalFailed = results.some(
        (result, index) => !result.healthy && (readinessChecks[index]?.critical ?? true),
      );

      const response = {
        status: criticalFailed ? "not_ready" : "ready",
        timestamp: new Date().toISOString(),
        checks: results,
      };

      if (criticalFailed) {
        reply.code(503);
      }

      return response;
    },
  );

  // ========================================
  // Metrics Endpoint (Optional)
  // ========================================

  if (metrics) {
    fastify.get(`${prefix}/metrics`, async (_, reply) => {
      reply.type("text/plain; charset=utf-8");

      if (metricsCollector) {
        return await metricsCollector();
      }

      // Default Prometheus metrics
      const uptime = process.uptime();
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();

      const lines = [
        "# HELP process_uptime_seconds Process uptime in seconds",
        "# TYPE process_uptime_seconds gauge",
        `process_uptime_seconds ${uptime.toFixed(2)}`,
        "",
        "# HELP process_memory_heap_bytes Heap memory usage in bytes",
        "# TYPE process_memory_heap_bytes gauge",
        `process_memory_heap_bytes{type="used"} ${memory.heapUsed}`,
        `process_memory_heap_bytes{type="total"} ${memory.heapTotal}`,
        "",
        "# HELP process_memory_rss_bytes RSS memory in bytes",
        "# TYPE process_memory_rss_bytes gauge",
        `process_memory_rss_bytes ${memory.rss}`,
        "",
        "# HELP process_memory_external_bytes External memory in bytes",
        "# TYPE process_memory_external_bytes gauge",
        `process_memory_external_bytes ${memory.external}`,
        "",
        "# HELP process_cpu_user_microseconds User CPU time in microseconds",
        "# TYPE process_cpu_user_microseconds counter",
        `process_cpu_user_microseconds ${cpu.user}`,
        "",
        "# HELP process_cpu_system_microseconds System CPU time in microseconds",
        "# TYPE process_cpu_system_microseconds counter",
        `process_cpu_system_microseconds ${cpu.system}`,
        "",
      ];

      // HTTP request metrics
      if (collectHttpMetrics && Object.keys(httpMetrics.requestsTotal).length > 0) {
        lines.push(
          "# HELP http_requests_total Total HTTP requests by status code",
          "# TYPE http_requests_total counter",
        );
        for (const [status, count] of Object.entries(httpMetrics.requestsTotal)) {
          lines.push(`http_requests_total{status="${status}"} ${count}`);
        }
        lines.push("");

        // Request duration — bucketed histogram quantile bounds, O(#buckets)
        // per scrape (see DURATION_BUCKETS_MS). Quantiles are the bucket
        // UPPER BOUND containing the target rank — conservative, and
        // aggregatable across instances unlike sorted-sample quantiles.
        if (httpMetrics.durationCount > 0) {
          const p50 = bucketQuantile(httpMetrics, 0.5);
          const p95 = bucketQuantile(httpMetrics, 0.95);
          const p99 = bucketQuantile(httpMetrics, 0.99);

          lines.push(
            "# HELP http_request_duration_milliseconds HTTP request duration (bucket upper bounds)",
            "# TYPE http_request_duration_milliseconds summary",
            `http_request_duration_milliseconds{quantile="0.5"} ${p50.toFixed(2)}`,
            `http_request_duration_milliseconds{quantile="0.95"} ${p95.toFixed(2)}`,
            `http_request_duration_milliseconds{quantile="0.99"} ${p99.toFixed(2)}`,
            `http_request_duration_milliseconds_sum ${httpMetrics.durationSumMs.toFixed(2)}`,
            `http_request_duration_milliseconds_count ${httpMetrics.durationCount}`,
            "",
          );
        }
      }

      return lines.join("\n");
    });
  }

  // Collect HTTP metrics. Timing comes from Fastify's own
  // `reply.elapsedTime` — no onRequest hook, no per-request property
  // assignment (an undeclared write on every request mutates the request
  // object's shape on the hottest path; metrics.ts uses the same source).
  if (collectHttpMetrics) {
    fastify.addHook("onResponse", async (_request, reply) => {
      const duration = reply.elapsedTime;

      // Track by status code bucket (2xx, 3xx, 4xx, 5xx)
      const statusBucket = `${Math.floor(reply.statusCode / 100)}xx`;
      httpMetrics.requestsTotal[statusBucket] = (httpMetrics.requestsTotal[statusBucket] || 0) + 1;

      // Bucketed recording — O(#buckets) worst case, no sample retention.
      let bucket: number = DURATION_BUCKETS_MS.length; // overflow slot
      for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
        const bound = DURATION_BUCKETS_MS[i];
        if (bound !== undefined && duration <= bound) {
          bucket = i;
          break;
        }
      }
      httpMetrics.durationBuckets[bucket] = (httpMetrics.durationBuckets[bucket] ?? 0) + 1;
      httpMetrics.durationCount++;
      httpMetrics.durationSumMs += duration;
    });
  }

  fastify.log?.debug?.(
    `Health plugin registered at ${prefix} (alias), ${prefix}/live, ${prefix}/ready${
      metrics ? `, ${prefix}/metrics` : ""
    }`,
  );
};

/**
 * Run all health checks with timeout
 */
async function runChecks(checks: readonly HealthCheck[]): Promise<CheckResult[]> {
  // Checks describe independent dependencies. Run them concurrently so probe
  // latency is bounded by the slowest timeout, not the sum of every module's
  // timeout. Promise.all preserves declaration order in the response.
  return Promise.all(
    checks.map(async (check): Promise<CheckResult> => {
      const start = Date.now();
      const timeout = check.timeout ?? 5000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();

      try {
        const checkPromise = Promise.resolve(check.check(abort.signal));
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error("Health check timeout");
            // Signal the probe to stop its underlying work — the race alone
            // only stops US from waiting (see HealthCheck.check docs).
            abort.abort(err);
            reject(err);
          }, timeout);
        });

        const healthy = await Promise.race([checkPromise, timeoutPromise]);

        return {
          name: check.name,
          healthy: Boolean(healthy),
          duration: Date.now() - start,
        };
      } catch (err) {
        return {
          name: check.name,
          healthy: false,
          duration: Date.now() - start,
          error: (err as Error).message,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}

export default fp(healthPlugin, {
  name: "arc-health",
  fastify: "5.x",
});

export { healthPlugin };
