/**
 * Standard response envelope helper.
 *
 * Wraps a handler return value in arc's `{ success: true, data, ...meta }`
 * shape. Pure utility — no types module coupling, no runtime dependencies.
 *
 * @example
 * ```ts
 * import { envelope } from '@classytic/arc';
 *
 * handler: async (req, reply) => {
 *   const results = await search(req.query.q);
 *   return envelope(results, { took: performance.now() - t0 });
 * }
 * ```
 */

/**
 * Wrap data in arc's standard `{ success: true, data }` envelope, with
 * optional top-level meta keys merged in.
 */
export function envelope<T>(
  data: T,
  meta?: Record<string, unknown>,
): {
  success: true;
  data: T;
  [key: string]: unknown;
} {
  return { success: true, data, ...meta };
}
