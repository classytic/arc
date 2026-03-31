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

// Plugin-local augmentation for HTTP metrics timing
declare module "fastify" {
  interface FastifyRequest {
    _startTime?: number;
  }
}

export interface HealthCheck {
  /** Name of the dependency */
  name: string;
  /** Function that returns true if healthy, false otherwise */
  check: () => Promise<boolean> | boolean;
  /** Optional timeout in ms (default: 5000) */
  timeout?: number;
  /** Whether this check is critical for readiness (default: true) */
  critical?: boolean;
}

export interface HealthOptions {
  /** Route prefix (default: '/_health') */
  prefix?: string;
  /** Health check dependencies */
  checks?: HealthCheck[];
  /** Enable metrics endpoint (default: false) */
  metrics?: boolean;
  /** Custom metrics collector function */
  metricsCollector?: () => Promise<string> | string;
  /** Version info to include in responses */
  version?: string;
  /** Collect HTTP request metrics (default: true if metrics enabled) */
  collectHttpMetrics?: boolean;
}

interface CheckResult {
  name: string;
  healthy: boolean;
  duration: number;
  error?: string;
}

// Metrics storage (instance-scoped to avoid contamination between app instances)
interface HttpMetrics {
  requestsTotal: Record<string, number>;
  requestDurations: number[];
  /** Write index for ring buffer — wraps modulo capacity */
  _ringIndex: number;
  startTime: number;
}

function createHttpMetrics(): HttpMetrics {
  return {
    requestsTotal: {},
    requestDurations: [],
    _ringIndex: 0,
    startTime: Date.now(),
  };
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

  // Instance-scoped metrics — each Fastify instance gets its own counters
  const httpMetrics = createHttpMetrics();

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
      const results = await runChecks(checks);
      const criticalFailed = results.some(
        (r) => !r.healthy && (checks.find((c) => c.name === r.name)?.critical ?? true),
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

        // Request duration histogram
        if (httpMetrics.requestDurations.length > 0) {
          const sorted = [...httpMetrics.requestDurations].sort((a, b) => a - b);
          const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
          const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
          const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
          const sum = sorted.reduce((a, b) => a + b, 0);

          lines.push(
            "# HELP http_request_duration_milliseconds HTTP request duration",
            "# TYPE http_request_duration_milliseconds summary",
            `http_request_duration_milliseconds{quantile="0.5"} ${p50.toFixed(2)}`,
            `http_request_duration_milliseconds{quantile="0.95"} ${p95.toFixed(2)}`,
            `http_request_duration_milliseconds{quantile="0.99"} ${p99.toFixed(2)}`,
            `http_request_duration_milliseconds_sum ${sum.toFixed(2)}`,
            `http_request_duration_milliseconds_count ${sorted.length}`,
            "",
          );
        }
      }

      return lines.join("\n");
    });
  }

  // Collect HTTP metrics
  if (collectHttpMetrics) {
    fastify.addHook("onRequest", async (request) => {
      request._startTime = Date.now();
    });

    fastify.addHook("onResponse", async (request, reply) => {
      const duration = Date.now() - (request._startTime ?? Date.now());

      // Track by status code bucket (2xx, 3xx, 4xx, 5xx)
      const statusBucket = `${Math.floor(reply.statusCode / 100)}xx`;
      httpMetrics.requestsTotal[statusBucket] = (httpMetrics.requestsTotal[statusBucket] || 0) + 1;

      // Store duration in ring buffer (O(1) vs O(n) for Array.shift)
      if (httpMetrics.requestDurations.length < 10000) {
        httpMetrics.requestDurations.push(duration);
      } else {
        httpMetrics.requestDurations[httpMetrics._ringIndex % 10000] = duration;
      }
      httpMetrics._ringIndex = httpMetrics._ringIndex + 1;
    });
  }

  fastify.log?.debug?.(`Health plugin registered at ${prefix}`);
};

/**
 * Run all health checks with timeout
 */
async function runChecks(checks: HealthCheck[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    const start = Date.now();
    const timeout = check.timeout ?? 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const checkPromise = Promise.resolve(check.check());
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Health check timeout")), timeout);
      });

      const healthy = await Promise.race([checkPromise, timeoutPromise]);

      results.push({
        name: check.name,
        healthy: Boolean(healthy),
        duration: Date.now() - start,
      });
    } catch (err) {
      results.push({
        name: check.name,
        healthy: false,
        duration: Date.now() - start,
        error: (err as Error).message,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return results;
}

export default fp(healthPlugin, {
  name: "arc-health",
  fastify: "5.x",
});

export { healthPlugin };
