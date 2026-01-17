/**
 * Circuit Breaker Pattern
 *
 * Wraps external service calls with failure protection.
 * Prevents cascading failures by "opening" the circuit when
 * a service is failing, allowing it time to recover.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, all requests fail fast
 * - HALF_OPEN: Testing if service recovered, limited requests
 *
 * @example
 * import { CircuitBreaker } from '@classytic/arc/utils';
 *
 * const paymentBreaker = new CircuitBreaker(async (amount) => {
 *   return await stripe.charges.create({ amount });
 * }, {
 *   failureThreshold: 5,
 *   resetTimeout: 30000,
 *   timeout: 5000,
 * });
 *
 * try {
 *   const result = await paymentBreaker.call(100);
 * } catch (error) {
 *   // Handle failure or circuit open
 * }
 */

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /**
   * Number of failures before opening circuit
   * @default 5
   */
  failureThreshold?: number;

  /**
   * Time in ms before attempting to close circuit
   * @default 60000 (60 seconds)
   */
  resetTimeout?: number;

  /**
   * Request timeout in ms
   * @default 10000 (10 seconds)
   */
  timeout?: number;

  /**
   * Number of successful requests in HALF_OPEN before closing
   * @default 1
   */
  successThreshold?: number;

  /**
   * Fallback function when circuit is open
   */
  fallback?: (...args: any[]) => Promise<any>;

  /**
   * Callback when state changes
   */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;

  /**
   * Callback on error
   */
  onError?: (error: Error) => void;

  /**
   * Name for logging/monitoring
   */
  name?: string;
}

export interface CircuitBreakerStats {
  name?: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalCalls: number;
  openedAt: number | null;
  lastCallAt: number | null;
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public state: CircuitState
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export class CircuitBreaker<T extends (...args: any[]) => Promise<any>> {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private totalCalls: number = 0;
  private nextAttempt: number = 0;
  private lastCallAt: number | null = null;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly timeout: number;
  private readonly successThreshold: number;
  private readonly fallback?: (...args: any[]) => Promise<any>;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
  private readonly onError?: (error: Error) => void;
  private readonly name: string;

  constructor(
    private readonly fn: T,
    options: CircuitBreakerOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 60000;
    this.timeout = options.timeout ?? 10000;
    this.successThreshold = options.successThreshold ?? 1;
    this.fallback = options.fallback;
    this.onStateChange = options.onStateChange;
    this.onError = options.onError;
    this.name = options.name ?? 'CircuitBreaker';
  }

  /**
   * Call the wrapped function with circuit breaker protection
   */
  async call(...args: Parameters<T>): Promise<ReturnType<T>> {
    this.totalCalls++;
    this.lastCallAt = Date.now();

    // Check circuit state
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        // Circuit still open, fail fast
        const error = new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.name}`,
          CircuitState.OPEN
        );

        // Use fallback if available
        if (this.fallback) {
          return this.fallback(...args);
        }

        throw error;
      }

      // Try transitioning to HALF_OPEN
      this.setState(CircuitState.HALF_OPEN);
    }

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(args);

      // Success
      this.onSuccess();
      return result;
    } catch (error) {
      // Failure
      this.onFailure(error as Error);
      throw error;
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout(args: Parameters<T>): Promise<ReturnType<T>> {
    return new Promise<ReturnType<T>>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Request timeout after ${this.timeout}ms`));
      }, this.timeout);

      this.fn(...args)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Handle successful call
   */
  private onSuccess(): void {
    this.failures = 0;
    this.successes++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Check if we should close the circuit
      if (this.successes >= this.successThreshold) {
        this.setState(CircuitState.CLOSED);
        this.successes = 0;
      }
    }
  }

  /**
   * Handle failed call
   */
  private onFailure(error: Error): void {
    this.failures++;
    this.successes = 0;

    if (this.onError) {
      this.onError(error);
    }

    if (this.state === CircuitState.HALF_OPEN || this.failures >= this.failureThreshold) {
      this.setState(CircuitState.OPEN);
      this.nextAttempt = Date.now() + this.resetTimeout;
      this.openedAt = Date.now();
    }
  }

  /**
   * Change circuit state
   */
  private setState(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState !== newState) {
      this.state = newState;

      if (this.onStateChange) {
        this.onStateChange(oldState, newState);
      }
    }
  }

  /**
   * Manually open the circuit
   */
  open(): void {
    this.setState(CircuitState.OPEN);
    this.nextAttempt = Date.now() + this.resetTimeout;
    this.openedAt = Date.now();
  }

  /**
   * Manually close the circuit
   */
  close(): void {
    this.failures = 0;
    this.successes = 0;
    this.setState(CircuitState.CLOSED);
    this.openedAt = null;
  }

  /**
   * Get current statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalCalls: this.totalCalls,
      openedAt: this.openedAt,
      lastCallAt: this.lastCallAt,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  /**
   * Check if circuit is closed
   */
  isClosed(): boolean {
    return this.state === CircuitState.CLOSED;
  }

  /**
   * Reset statistics
   */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.totalCalls = 0;
    this.lastCallAt = null;
    this.openedAt = null;
    this.setState(CircuitState.CLOSED);
  }
}

/**
 * Create a circuit breaker with sensible defaults
 *
 * @example
 * const emailBreaker = createCircuitBreaker(
 *   async (to, subject, body) => sendEmail(to, subject, body),
 *   { name: 'email-service' }
 * );
 */
export function createCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options?: CircuitBreakerOptions
): CircuitBreaker<T> {
  return new CircuitBreaker(fn, options);
}

/**
 * Circuit breaker registry for managing multiple breakers
 */
export class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker<any>> = new Map();

  /**
   * Register a circuit breaker
   */
  register<T extends (...args: any[]) => Promise<any>>(
    name: string,
    fn: T,
    options?: Omit<CircuitBreakerOptions, 'name'>
  ): CircuitBreaker<T> {
    const breaker = new CircuitBreaker(fn, { ...options, name });
    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Get a circuit breaker by name
   */
  get(name: string): CircuitBreaker<any> | undefined {
    return this.breakers.get(name);
  }

  /**
   * Get all breakers
   */
  getAll(): Map<string, CircuitBreaker<any>> {
    return this.breakers;
  }

  /**
   * Get statistics for all breakers
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers.entries()) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Reset all breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Open all breakers
   */
  openAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.open();
    }
  }

  /**
   * Close all breakers
   */
  closeAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.close();
    }
  }
}

/**
 * Global circuit breaker registry
 */
export const circuitBreakerRegistry = new CircuitBreakerRegistry();
