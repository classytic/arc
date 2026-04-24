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

  it("silent: true suppresses the WARN", async () => {
    const warns: string[] = [];
    const logger = { warn: (msg: string) => warns.push(msg) };

    const resources = await loadResources(TMP, { logger, silent: true });
    expect(resources).toEqual([]);
    expect(warns).toHaveLength(0);
  });

  it("no logger supplied → silent (back-compat with existing callers)", async () => {
    // Hosts that call loadResources() without wiring a logger (common in
    // tests + scripts) don't suddenly start seeing stderr noise. They DO
    // still get the empty array back — the contract is unchanged.
    const resources = await loadResources(TMP);
    expect(resources).toEqual([]);
  });
});
