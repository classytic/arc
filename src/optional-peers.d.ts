/**
 * Ambient module declarations for optional peer dependencies.
 *
 * These tell TypeScript that these modules MAY exist at runtime
 * (installed by the user) without requiring them in devDependencies.
 * Actual types come from the packages themselves when installed.
 */

/**
 * No `@modelcontextprotocol/*` stubs here. v1 was declared ambiently because its
 * subpaths (`.../server/mcp.js`) resolved to hand-written `unknown`-typed shims;
 * the v2 packages are real devDependencies that ship their own types, so a stub
 * would only shadow a checked signature with an unchecked one.
 */

declare module "bullmq" {
  export class Queue {
    constructor(name: string, opts?: Record<string, unknown>);
    add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id: string }>;
    getJobCounts(): Promise<Record<string, number>>;
    /** Retrieve a job by ID within this queue's namespace. Returns undefined if not found or removed. */
    getJob(id: string): Promise<Record<string, unknown> | undefined>;
    close(): Promise<void>;
  }

  // `processor` accepts a `never`-typed arg so concrete callers can declare
  // their own job-shape parameter without TS rejecting on variance. The
  // event handler takes `never[]` for the same reason — bullmq emits a
  // mix of (job, error) tuples and concrete shapes vary per event name.
  export class Worker {
    constructor(
      name: string,
      processor: (job: never) => Promise<unknown>,
      opts?: Record<string, unknown>,
    );
    on(event: string, handler: (...args: never[]) => void): void;
    close(): Promise<void>;
  }
}
