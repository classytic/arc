/**
 * Promise plumbing for concurrency tests — externally-settled promises and
 * microtask/macrotask flushing.
 */

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks + one macrotask turn run (detached chains settle). */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
