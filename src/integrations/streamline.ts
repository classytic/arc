/**
 * @classytic/arc — Streamline Integration
 *
 * Pluggable adapter that wires @classytic/streamline workflows into Arc's
 * Fastify application. Provides REST endpoints for workflow management,
 * auto-connects to Arc's event bus, and respects Arc's auth/permissions.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 *
 * Requires: @classytic/streamline (peer dependency)
 *
 * @example
 * ```typescript
 * import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 * import { orderWorkflow } from './workflows/order.js';
 *
 * await fastify.register(streamlinePlugin, {
 *   workflows: [orderWorkflow],
 *   prefix: '/api/workflows',
 *   auth: true, // require authentication for workflow endpoints
 * });
 *
 * // Starts the workflow
 * // POST /api/workflows/order/start { input }
 * // GET  /api/workflows/order/runs/:runId
 * // POST /api/workflows/order/runs/:runId/resume { payload }
 * // POST /api/workflows/order/runs/:runId/cancel
 * // GET  /api/workflows/order/runs (list runs)
 * ```
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

// ============================================================================
// Types (defined here so we don't import streamline at module level)
// ============================================================================

/** Minimal workflow interface — matches @classytic/streamline's createWorkflow() return */
export interface WorkflowLike {
  definition: { id: string; name?: string; steps: Record<string, unknown> };
  engine: {
    start(input: unknown, meta?: unknown): Promise<WorkflowRunLike>;
    execute(runId: string): Promise<WorkflowRunLike>;
    resume(runId: string, payload?: unknown): Promise<WorkflowRunLike>;
    cancel(runId: string): Promise<WorkflowRunLike>;
    pause?(runId: string): Promise<WorkflowRunLike>;
    rewindTo?(runId: string, stepId: string): Promise<WorkflowRunLike>;
    get(runId: string): Promise<WorkflowRunLike | null>;
    shutdown?(): void;
  };
  start(input: unknown, meta?: unknown): Promise<WorkflowRunLike>;
  resume(runId: string, payload?: unknown): Promise<WorkflowRunLike>;
  cancel(runId: string): Promise<WorkflowRunLike>;
  get(runId: string): Promise<WorkflowRunLike | null>;
  shutdown?(): void;
}

export interface WorkflowRunLike {
  _id: string;
  workflowId: string;
  status: string;
  context?: unknown;
  input?: unknown;
  steps?: Record<string, unknown>;
  error?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export interface StreamlinePluginOptions {
  /** Array of workflows created with createWorkflow() */
  workflows: WorkflowLike[];
  /** URL prefix for workflow endpoints (default: '/workflows') */
  prefix?: string;
  /** Require authentication for all workflow endpoints (default: true) */
  auth?: boolean;
  /** Connect workflow events to Arc's event bus (default: true) */
  bridgeEvents?: boolean;
  /** Custom permission check for workflow operations */
  permissions?: {
    start?: (request: unknown) => boolean | Promise<boolean>;
    resume?: (request: unknown) => boolean | Promise<boolean>;
    cancel?: (request: unknown) => boolean | Promise<boolean>;
    list?: (request: unknown) => boolean | Promise<boolean>;
    get?: (request: unknown) => boolean | Promise<boolean>;
  };
}

// ============================================================================
// Plugin Implementation
// ============================================================================

const streamlinePluginImpl: FastifyPluginAsync<StreamlinePluginOptions> = async (
  fastify: FastifyInstance,
  options: StreamlinePluginOptions
) => {
  const {
    workflows,
    prefix = '/workflows',
    auth = true,
    bridgeEvents = true,
    permissions: perms,
  } = options;

  // Registry: workflowId → workflow instance
  const registry = new Map<string, WorkflowLike>();

  for (const wf of workflows) {
    const id = wf.definition.id;
    if (registry.has(id)) {
      throw new Error(`Duplicate workflow ID: '${id}'`);
    }
    registry.set(id, wf);
  }

  // Decorate fastify with workflow accessor
  if (!fastify.hasDecorator('workflows')) {
    fastify.decorate('workflows', registry);
  }
  if (!fastify.hasDecorator('getWorkflow')) {
    fastify.decorate('getWorkflow', (id: string) => registry.get(id) ?? null);
  }

  // Build auth preHandler if needed
  const authPreHandler = auth && typeof (fastify as any).authenticate === 'function'
    ? [(fastify as any).authenticate]
    : [];

  // Permission check helper
  const checkPerm = async (
    op: keyof NonNullable<StreamlinePluginOptions['permissions']>,
    request: unknown
  ): Promise<boolean> => {
    const check = perms?.[op];
    if (!check) return true;
    return check(request);
  };

  // Register routes per workflow
  for (const [id, wf] of registry) {
    const routePrefix = `${prefix}/${id}`;

    // POST /:workflowId/start — Start a new workflow run
    fastify.post(`${routePrefix}/start`, {
      preHandler: authPreHandler,
    }, async (request, reply) => {
      if (!(await checkPerm('start', request))) {
        return reply.status(403).send({ success: false, error: 'Forbidden' });
      }
      const { input, meta } = (request.body ?? {}) as { input?: unknown; meta?: unknown };
      const run = await wf.start(input, meta);

      // Bridge event to Arc's event bus
      if (bridgeEvents && (fastify as any).events?.publish) {
        await (fastify as any).events.publish(`workflow.${id}.started`, {
          runId: run._id,
          workflowId: id,
          status: run.status,
        });
      }

      return reply.status(201).send({ success: true, data: run });
    });

    // GET /:workflowId/runs/:runId — Get a workflow run
    fastify.get(`${routePrefix}/runs/:runId`, {
      preHandler: authPreHandler,
    }, async (request, reply) => {
      if (!(await checkPerm('get', request))) {
        return reply.status(403).send({ success: false, error: 'Forbidden' });
      }
      const { runId } = request.params as { runId: string };
      const run = await wf.get(runId);
      if (!run) {
        return reply.status(404).send({ success: false, error: 'Workflow run not found' });
      }
      return { success: true, data: run };
    });

    // POST /:workflowId/runs/:runId/resume — Resume a waiting workflow
    fastify.post(`${routePrefix}/runs/:runId/resume`, {
      preHandler: authPreHandler,
    }, async (request, reply) => {
      if (!(await checkPerm('resume', request))) {
        return reply.status(403).send({ success: false, error: 'Forbidden' });
      }
      const { runId } = request.params as { runId: string };
      const { payload } = (request.body ?? {}) as { payload?: unknown };
      const run = await wf.resume(runId, payload);

      if (bridgeEvents && (fastify as any).events?.publish) {
        await (fastify as any).events.publish(`workflow.${id}.resumed`, {
          runId: run._id,
          workflowId: id,
          status: run.status,
        });
      }

      return { success: true, data: run };
    });

    // POST /:workflowId/runs/:runId/cancel — Cancel a workflow run
    fastify.post(`${routePrefix}/runs/:runId/cancel`, {
      preHandler: authPreHandler,
    }, async (request, reply) => {
      if (!(await checkPerm('cancel', request))) {
        return reply.status(403).send({ success: false, error: 'Forbidden' });
      }
      const { runId } = request.params as { runId: string };
      const run = await wf.cancel(runId);

      if (bridgeEvents && (fastify as any).events?.publish) {
        await (fastify as any).events.publish(`workflow.${id}.cancelled`, {
          runId: run._id,
          workflowId: id,
        });
      }

      return { success: true, data: run };
    });

    // POST /:workflowId/runs/:runId/pause — Pause a running workflow (if supported)
    if (wf.engine.pause) {
      fastify.post(`${routePrefix}/runs/:runId/pause`, {
        preHandler: authPreHandler,
      }, async (request, reply) => {
        const { runId } = request.params as { runId: string };
        const run = await wf.engine.pause!(runId);
        return { success: true, data: run };
      });
    }

    // POST /:workflowId/runs/:runId/rewind — Rewind to a step (if supported)
    if (wf.engine.rewindTo) {
      fastify.post(`${routePrefix}/runs/:runId/rewind`, {
        preHandler: authPreHandler,
      }, async (request, reply) => {
        const { runId } = request.params as { runId: string };
        const { stepId } = (request.body ?? {}) as { stepId: string };
        if (!stepId) {
          return reply.status(400).send({ success: false, error: 'stepId is required' });
        }
        const run = await wf.engine.rewindTo!(runId, stepId);
        return { success: true, data: run };
      });
    }
  }

  // List all registered workflows
  fastify.get(prefix, {
    preHandler: authPreHandler,
  }, async () => {
    const list = Array.from(registry.entries()).map(([id, wf]) => ({
      id,
      name: wf.definition.name ?? id,
      steps: Object.keys(wf.definition.steps),
    }));
    return { success: true, data: list };
  });

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    for (const wf of registry.values()) {
      wf.shutdown?.();
    }
  });
};

/** Pluggable streamline integration for Arc */
export const streamlinePlugin: FastifyPluginAsync<StreamlinePluginOptions> = streamlinePluginImpl;
export default streamlinePlugin;
