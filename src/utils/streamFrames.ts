/**
 * SSE control-frame vocabulary shared by every arc stream and `@classytic/arc-next/sse`.
 *
 * Kept apart from `replayStream.ts` so a feed that only names the frames
 * (`realtimePlugin`) does not pull the replay hub, and `node:crypto`, into its chunk.
 */

/**
 * SSE control frame names. The same literals ship from `@classytic/arc-next/sse`;
 * a test in each package pins them.
 */
export const STREAM_FRAMES = {
  READY: "ready",
  RESYNC: "resync",
  REVOKED: "revoked",
  RETRY: "retry",
} as const;
export type StreamFrameName = (typeof STREAM_FRAMES)[keyof typeof STREAM_FRAMES];
export type ResyncReason = "cursor_expired" | "gap_too_large" | "cursor_invalid";

/**
 * `event: ready` (no `id:`). The first frame on every connection. `cursor` is
 * present only on a replayable stream (the replay hub always sends it).
 * `realtimePlugin` keeps its `resources` and `operations` fields next to these.
 */
export interface ReadyFrame {
  cursor?: string;
  resumed: boolean;
}
/** `event: resync` (no `id:`). The gap could not be replayed: reload the snapshot, then continue from `cursor`. */
export interface ResyncFrame {
  cursor: string;
  reason: ResyncReason;
}
/** `event: revoked` (no `id:`). Access ended; the server closes the stream right after this frame. */
export interface RevokedFrame {
  reason: string;
}
/**
 * `event: retry` (no `id:`). NOT final: the server closes right after, and the client
 * should reconnect at once (no backoff) with its `Last-Event-ID`, so the stream is
 * authorized afresh. Sent by the replay hub's `revalidate` (`{ close: 'retry' }` or
 * `maxConsecutiveFailures`). A client that does not know the frame still reconnects
 * with its normal backoff, so the frame is safe to send to older clients.
 */
export interface RetryFrame {
  reason: string;
}
