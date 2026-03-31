/**
 * Audited Preset
 *
 * Adds createdBy/updatedBy tracking to resources.
 * Works with the audit plugin for full change tracking.
 *
 * @example
 * defineResource({
 *   name: 'product',
 *   presets: ['audited'],
 *   // Fields createdBy, updatedBy auto-populated from user context
 * });
 */

import type { FastifyReply } from "fastify";
import type { MiddlewareHandler, PresetResult, RequestWithExtras } from "../types/index.js";

export interface AuditedPresetOptions {
  /** Field name for creator (default: 'createdBy') */
  createdByField?: string;
  /** Field name for updater (default: 'updatedBy') */
  updatedByField?: string;
}

/**
 * Audited preset - adds createdBy/updatedBy tracking
 */
export function auditedPreset(options: AuditedPresetOptions = {}): PresetResult {
  const { createdByField = "createdBy", updatedByField = "updatedBy" } = options;

  const injectCreatedBy: MiddlewareHandler = async (
    request: RequestWithExtras,
    _reply: FastifyReply,
  ): Promise<unknown> => {
    const userWithId = request.user as { _id?: string; id?: string };
    if (userWithId?._id || userWithId?.id) {
      const userId = userWithId._id ?? userWithId.id;
      (request.body as Record<string, unknown>)[createdByField] = userId;
      (request.body as Record<string, unknown>)[updatedByField] = userId;
    }
    return undefined;
  };

  const injectUpdatedBy: MiddlewareHandler = async (
    request: RequestWithExtras,
    _reply: FastifyReply,
  ): Promise<unknown> => {
    const userWithId = request.user as { _id?: string; id?: string };
    if (userWithId?._id || userWithId?.id) {
      (request.body as Record<string, unknown>)[updatedByField] = userWithId._id ?? userWithId.id;
    }
    return undefined;
  };

  return {
    name: "audited",
    schemaOptions: {
      fieldRules: {
        [createdByField]: { systemManaged: true },
        [updatedByField]: { systemManaged: true },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
    },
    middlewares: {
      create: [injectCreatedBy],
      update: [injectUpdatedBy],
    },
  };
}

export default auditedPreset;
