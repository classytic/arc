/**
 * The key/value command shapes arc's cache and idempotency stores share, for
 * the two Redis clients hosts actually plug in: ioredis (TCP) and
 * `@upstash/redis` (REST, edge-safe).
 *
 * Both stores used to declare their own copies of these, and they drifted the
 * way copies do — the ioredis-assignability fix in 2.41 had to be applied to
 * each separately. Each store's exported `IoredisLike` / `UpstashRedisLike`
 * now EXTENDS the base here and adds only what that store uses beyond it, so
 * the exported names are unchanged.
 *
 * Deliberately NOT a single shape for every Redis user in arc. Streams
 * (`xadd`/`xreadgroup`), pub/sub (`subscribe`/`duplicate`), sessions (sets),
 * usage (hashes) and circuit counters (`incr`) share almost no commands with
 * each other, and where they overlap the signatures differ on purpose. A
 * shared superset would couple unrelated features and make every host wrapper
 * implement commands it never serves.
 *
 * ## The one rule every ioredis shape must follow
 *
 * Variadic tails are `unknown[]`, never `(string | number)[]`. ioredis types
 * each command as a set of OVERLOADS whose tails mix literal tokens (`'MATCH'`,
 * `'PX'`, `'NX'`), `Buffer`, and an optional trailing callback. A narrower
 * tail matches none of them, and `new Redis(url)` then fails to assign with
 * TS2345. Pinned for every arc shape by `tests/types/ioredis-assignability.test.ts`.
 */

/** ioredis key/value commands shared by the cache and idempotency stores. */
export interface IoredisKeyValueCommands {
  get(key: string): Promise<string | null>;
  set(...args: unknown[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string | number, ...args: unknown[]): Promise<[string, string[]]>;
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * `@upstash/redis` key/value commands shared by the cache and idempotency
 * stores. REST-based, so it runs on edge runtimes (Cloudflare Workers, Vercel
 * Edge, Deno Deploy) where TCP — and thus ioredis — is unavailable. Note the
 * different call shapes: options objects rather than positional tokens, and
 * `eval(script, keys[], args[])`.
 */
export interface UpstashKeyValueCommands {
  get(key: string): Promise<string | null | unknown>;
  set(key: string, value: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: number | string,
    opts?: { match?: string; count?: number },
  ): Promise<[number, string[]] | [string, string[]]>;
  eval?(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}
