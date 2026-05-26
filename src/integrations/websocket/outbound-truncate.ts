/**
 * Outbound payload truncation — mirrors n8n's pattern of capping any
 * single server→client frame at a sane upper bound, replacing oversize
 * payloads with a placeholder envelope the client knows to handle.
 *
 * The 2.17.2 review (NEW-LOW) flagged that an earlier draft used a
 * module-global cap mutated by `resetMaxOutboundBytes(maxOutboundBytes)`
 * at plugin construction. Two simultaneous plugin registrations with
 * different caps would surprise the host (last-write-wins). The
 * current shape is purely instance-scoped: every plugin instance owns
 * its own `truncate` closure, callers pass the cap at the call site.
 *
 *   - `truncateOutbound(json, max)` — cheap byte check; returns the
 *     placeholder JSON when oversize.
 *
 *   - `createTruncator(max)` — convenience: returns a function bound
 *     to a specific cap. The plugin holds one of these per registered
 *     instance, eliminating module state.
 */

/** 5 MiB default — same as n8n's `relayViaPubSub` ceiling. */
export const DEFAULT_MAX_OUTBOUND_BYTES = 5 * 1024 * 1024;

/**
 * Returns either the original payload (when within `max`) or a
 * placeholder JSON string (when oversize). The placeholder carries the
 * original size so the client can surface a meaningful error / retry.
 *
 * Byte length is measured via Buffer.byteLength (UTF-8) — same metric
 * the underlying WebSocket frame uses for the payload-length header.
 */
export function truncateOutbound(
  payload: string,
  max: number = DEFAULT_MAX_OUTBOUND_BYTES,
): string {
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes <= max) return payload;
  return JSON.stringify({
    type: "truncated",
    originalBytes: bytes,
    maxBytes: max,
    hint: "Server-side payload exceeded the outbound cap. Refetch via REST or narrow your subscription filter.",
  });
}

/**
 * Bind a cap into a closure — the plugin uses one of these per
 * registered instance so no module state crosses plugin boundaries.
 * Hosts running two WebSocket plugins with different caps get the
 * exact cap each one declared, not last-writer-wins.
 */
export function createTruncator(
  max: number = DEFAULT_MAX_OUTBOUND_BYTES,
): (payload: string) => string {
  return (payload: string): string => truncateOutbound(payload, max);
}
