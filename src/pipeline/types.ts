/**
 * Pipeline Types — Shared type definitions for guard/transform/intercept.
 */

import type { IRequestContext, IControllerResponse, AnyRecord } from '../types/index.js';

/**
 * Pipeline context passed to guards, transforms, and interceptors.
 * Extends IRequestContext with pipeline-specific metadata.
 */
export interface PipelineContext extends IRequestContext {
  /** Resource name being accessed */
  resource: string;
  /** CRUD operation being performed */
  operation: 'list' | 'get' | 'create' | 'update' | 'delete' | string;
}

/**
 * Which operations a pipeline step applies to.
 * If omitted, applies to ALL operations.
 */
export type OperationFilter = Array<'list' | 'get' | 'create' | 'update' | 'delete' | string>;

// ============================================================================
// Guard
// ============================================================================

/**
 * Guard — boolean check that short-circuits on failure.
 * Return true to proceed, throw to deny.
 */
export interface Guard {
  readonly _type: 'guard';
  readonly name: string;
  readonly operations?: OperationFilter;
  handler(ctx: PipelineContext): boolean | Promise<boolean>;
}

// ============================================================================
// Transform
// ============================================================================

/**
 * Transform — modifies request data before the handler.
 * Returns modified context (or mutates in place).
 */
export interface Transform {
  readonly _type: 'transform';
  readonly name: string;
  readonly operations?: OperationFilter;
  handler(ctx: PipelineContext): PipelineContext | void | Promise<PipelineContext | void>;
}

// ============================================================================
// Intercept
// ============================================================================

/**
 * Next function passed to interceptors — calls the handler (or next interceptor).
 */
export type NextFunction = () => Promise<IControllerResponse<unknown>>;

/**
 * Intercept — wraps handler execution (before + after pattern).
 */
export interface Interceptor {
  readonly _type: 'interceptor';
  readonly name: string;
  readonly operations?: OperationFilter;
  handler(ctx: PipelineContext, next: NextFunction): Promise<IControllerResponse<unknown>>;
}

// ============================================================================
// Pipeline Step (union)
// ============================================================================

export type PipelineStep = Guard | Transform | Interceptor;

/**
 * Pipeline configuration — can be a flat array or per-operation map.
 */
export type PipelineConfig =
  | PipelineStep[]
  | {
      list?: PipelineStep[];
      get?: PipelineStep[];
      create?: PipelineStep[];
      update?: PipelineStep[];
      delete?: PipelineStep[];
      [operation: string]: PipelineStep[] | undefined;
    };
