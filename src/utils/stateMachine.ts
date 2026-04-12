/**
 * State Machine Utility
 *
 * Pure utility for validating state transitions in workflow systems.
 * Zero dependencies, framework-agnostic.
 *
 * @example
 * const orderState = createStateMachine('Order', {
 *   approve: ['pending', 'draft'],
 *   cancel: ['pending', 'approved'],
 *   fulfill: ['approved'],
 * });
 *
 * // Check if transition is allowed
 * if (orderState.can('approve', currentStatus)) {
 *   // Perform approval
 * }
 *
 * // Assert transition (throws if invalid)
 * orderState.assert('approve', currentStatus, ValidationError);
 */

export interface StateMachine {
  /**
   * Synchronously check if action can be performed from current status.
   * Only checks the transition map — does NOT evaluate guards.
   * Use `canAsync()` when guards need to be evaluated.
   */
  can(action: string, status: string | null | undefined): boolean;

  /**
   * Asynchronously check if action can be performed, including guard evaluation.
   * Falls back to simple transition check when no guard is defined.
   */
  canAsync(
    action: string,
    status: string | null | undefined,
    context?: Record<string, unknown>,
  ): Promise<boolean>;

  /**
   * Assert action can be performed, throw error if invalid
   * @param action - Action to perform
   * @param status - Current status
   * @param errorFactory - Optional error constructor
   * @param message - Optional custom error message
   */
  assert(
    action: string,
    status: string | null | undefined,
    errorFactory?: (msg: string) => Error,
    message?: string,
  ): void;

  /**
   * Get transition history
   */
  getHistory?(): TransitionHistoryEntry[];

  /**
   * Record a transition
   */
  recordTransition?(
    from: string,
    to: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): void;

  /**
   * Clear history
   */
  clearHistory?(): void;

  /**
   * Get available actions for current status
   */
  getAvailableActions?(status: string): string[];
}

export interface TransitionHistoryEntry {
  from: string;
  to: string;
  action: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/** Context passed to transition guards and actions */
export interface TransitionContext {
  from: string;
  to: string;
  action: string;
  data?: Record<string, unknown>;
}

export type TransitionGuard = (context: TransitionContext) => boolean | Promise<boolean>;

export type TransitionAction = (context: TransitionContext) => void | Promise<void>;

export type TransitionConfig = Record<
  string,
  | string[]
  | {
      from: string[];
      to?: string;
      guard?: TransitionGuard;
      before?: TransitionAction;
      after?: TransitionAction;
    }
>;

/**
 * Create a state machine for validating transitions
 *
 * @param name - Name of the state machine (used in error messages)
 * @param transitions - Map of actions to allowed source statuses
 * @param options - Additional options (history, guards, actions)
 * @returns State machine with can() and assert() methods
 *
 * @example
 * // Basic usage
 * const transferState = createStateMachine('Transfer', {
 *   approve: ['draft'],
 *   dispatch: ['approved'],
 *   receive: ['dispatched', 'in_transit'],
 *   cancel: ['draft', 'approved'],
 * });
 *
 * @example
 * // With guards and actions
 * const orderState = createStateMachine('Order', {
 *   approve: {
 *     from: ['pending'],
 *     to: 'approved',
 *     guard: ({ data }) => data.paymentConfirmed,
 *     before: ({ from, to }) => console.log(`Approving order from ${from} to ${to}`),
 *     after: ({ data }) => sendApprovalEmail(data.customerId),
 *   },
 * }, { trackHistory: true });
 */
export function createStateMachine(
  name: string,
  transitions: TransitionConfig = {},
  options: { trackHistory?: boolean } = {},
): StateMachine {
  const normalized = new Map<
    string,
    {
      from: Set<string>;
      to?: string;
      guard?: TransitionGuard;
      before?: TransitionAction;
      after?: TransitionAction;
    }
  >();
  const history: TransitionHistoryEntry[] | undefined = options.trackHistory ? [] : undefined;

  // Normalize transition config (support both array and object formats)
  Object.entries(transitions).forEach(([action, allowed]) => {
    if (Array.isArray(allowed)) {
      // Simple array format: action: ['state1', 'state2']
      normalized.set(action, { from: new Set(allowed) });
    } else if (typeof allowed === "object" && "from" in allowed) {
      // Object format with guards/actions
      normalized.set(action, {
        from: new Set(Array.isArray(allowed.from) ? allowed.from : [allowed.from]),
        to: allowed.to,
        guard: allowed.guard,
        before: allowed.before,
        after: allowed.after,
      });
    }
  });

  const can = (action: string, status: string | null | undefined): boolean => {
    const transition = normalized.get(action);
    if (!transition || !status) return false;
    return transition.from.has(status);
  };

  const canAsync = async (
    action: string,
    status: string | null | undefined,
    context?: Record<string, unknown>,
  ): Promise<boolean> => {
    const transition = normalized.get(action);
    if (!transition || !status) return false;

    // Check if transition is allowed from current state
    if (!transition.from.has(status)) return false;

    // Check guard condition if present
    if (transition.guard) {
      try {
        const guardResult = await transition.guard({
          from: status,
          to: transition.to || "",
          action,
          data: context,
        });
        return guardResult;
      } catch {
        return false;
      }
    }

    return true;
  };

  const assert = (
    action: string,
    status: string | null | undefined,
    errorFactory?: (msg: string) => Error,
    message?: string,
  ): void => {
    if (can(action, status)) return;

    const errorMessage =
      message || `${name} cannot '${action}' when status is '${status || "unknown"}'`;

    if (typeof errorFactory === "function") {
      throw errorFactory(errorMessage);
    }
    throw new Error(errorMessage);
  };

  const recordTransition = (
    from: string,
    to: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): void => {
    if (history) {
      history.push({
        from,
        to,
        action,
        timestamp: new Date(),
        metadata,
      });
    }
  };

  const getHistory = (): TransitionHistoryEntry[] => {
    return history ? [...history] : [];
  };

  const clearHistory = (): void => {
    if (history) {
      history.length = 0;
    }
  };

  const getAvailableActions = (status: string): string[] => {
    const actions: string[] = [];
    for (const [action, transition] of normalized.entries()) {
      if (transition.from.has(status)) {
        actions.push(action);
      }
    }
    return actions;
  };

  return {
    can,
    canAsync,
    assert,
    recordTransition,
    getHistory,
    clearHistory,
    getAvailableActions,
  };
}
