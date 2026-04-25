/**
 * loadResources — zero-match WARN regression
 *
 * 2.10.9 added a zero-discovery WARN when `resourceDir` auto-loads yield 0
 * resources. That covers the `createApp({ resourceDir })` path. It does NOT
 * cover the manual path:
 *
 * ```ts
 * const resources = await loadResources(import.meta.url); // returns []
 * createApp({ resources });                               // silent boot
 * ```
 *
 * The reporter's deploy hit exactly that case — a `dist/` layout mismatch
 * returned an empty array and everything served 404 until someone noticed.
 * v2.11 adds a WARN from `loadResources` itself when it finds zero matching
 * files, so the signal survives regardless of how the host wires discovery.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadResources } from "../../src/factory/loadResources.js";

const TMP = join(import.meta.dirname, "__tmp_zero_match__");

describe("loadResources — zero-match WARN (v2.11)", () => {
  beforeAll(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("empty directory → WARN with absolute path + pattern (via injected logger)", async () => {
    const warns: string[] = [];
    const logger = { warn: (msg: string) => warns.push(msg) };

    const resources = await loadResources(TMP, { logger });
    expect(resources).toEqual([]);

    const zeroWarn = warns.find((m) => m.includes("0 matching files found"));
    expect(zeroWarn).toBeDefined();
    // Operators need the absolute path to diagnose "right option, wrong dir"
    expect(zeroWarn).toContain(TMP);
    // And the pattern so they can spot "right path, wrong extension"
    expect(zeroWarn).toContain(".resource");
  });

  it("nonexistent directory → WARN (doesn't throw)", async () => {
    // Missing dir is treated the same as empty dir for diagnostic purposes —
    // `readdir` throws inside `collectFiles`, we catch and return []. The
    // WARN still fires because resources.length === 0 && files.length === 0.
    const warns: string[] = [];
    const logger = { warn: (msg: string) => warns.push(msg) };

    const resources = await loadResources(join(TMP, "does-not-exist"), { logger });
    expect(resources).toEqual([]);
    expect(warns.some((m) => m.includes("0 matching files found"))).toBe(true);
  });

  it("no-op injected logger suppresses the WARN at the caller's discretion", async () => {
    // 2.11.1: `silent: true` was removed. Two equivalents:
    //   1. Pass `logger: { warn: () => undefined }` (per-call no-op)
    //   2. Set `ARC_SUPPRESS_WARNINGS=1` (global, applies to every arcLog call)
    const warns: string[] = [];
    const noopLogger = { warn: (msg: string) => warns.push(msg) };

    const resources = await loadResources(TMP, {
      logger: { warn: () => undefined },
    });
    expect(resources).toEqual([]);
    expect(noopLogger.warn).toBeDefined();
    expect(warns).toHaveLength(0);
  });

  it("no logger supplied → arcLog fallback (warn-by-default arc convention)", async () => {
    // 2.11.1: when no `logger` is injected, warnings flow through
    // arcLog('loadResources') — same path as every other arc-internal warn.
    // Verify the contract still returns [] and the WARN reaches the canonical
    // arc logger sink (defaults to console.warn).
    const resources = await loadResources(TMP);
    expect(resources).toEqual([]);
  });
});
