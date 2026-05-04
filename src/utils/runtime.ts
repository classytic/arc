/**
 * Portable "run on next tick" scheduler. `setImmediate` is Node-only — not
 * available in Bun workers, Deno, Cloudflare Workers, or edge runtimes.
 */
export const scheduleBackground: (cb: () => void) => void =
  typeof setImmediate === "function" ? (cb) => void setImmediate(cb) : (cb) => queueMicrotask(cb);
