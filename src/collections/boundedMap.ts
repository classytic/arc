/**
 * Insertion-order LRU on a plain `Map` — the two moves, written once.
 *
 * A `Map` iterates in insertion order, so "move to most-recent" is
 * delete-then-set and "least-recent" is the first key. Seven places in arc
 * hand-rolled that, and hand-rolled copies drifted into real bugs:
 *
 *   - the response cache evicted with `while (size >= maxEntries)` BEFORE
 *     inserting, so `maxEntries: 0` spun forever on the first write — no key
 *     to evict, loop condition never changes, event loop frozen;
 *   - `maxEntries: NaN` made the same comparison always false: unbounded;
 *   - the MCP auth cache guarded eviction with `if (firstKey)`, a falsy check,
 *     so an empty-string key could never be evicted.
 *
 * These are functions over the caller's own `Map`, not a class, on purpose:
 * each site keeps its TTL, byte accounting and stats, and borrows only the
 * part that kept going wrong.
 */

/** Move `key` to most-recent and set it. Use on read-hit (LRU) or on overwrite. */
export function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/**
 * Evict least-recent entries until `map.size <= maxSize`; returns how many.
 *
 * Call AFTER inserting. That ordering is what makes it total: with
 * `maxSize: 0` the just-inserted entry is evicted (a disabled cache), never an
 * infinite loop, and the loop terminates on the iterator running dry rather
 * than on the size comparison alone. A non-finite or negative `maxSize` is a
 * configuration bug — {@link assertCapacity} it where the option is read.
 */
export function evictToSize<K, V>(
  map: Map<K, V>,
  maxSize: number,
  onEvict?: (key: K, value: V) => void,
): number {
  let evicted = 0;
  while (map.size > maxSize) {
    const oldest = map.entries().next();
    if (oldest.done) break;
    const [key, value] = oldest.value;
    map.delete(key);
    onEvict?.(key, value);
    evicted++;
  }
  return evicted;
}

/**
 * Validate a capacity option at construction: a non-negative integer. `0` is
 * allowed and means "keep nothing". Throws with the option's name so the error
 * points at the host's config, not at a hang or an unbounded map later.
 */
export function assertCapacity(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[arc] ${name} must be a non-negative integer, got ${String(value)}.`);
  }
  return value;
}
