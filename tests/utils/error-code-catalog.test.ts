/**
 * Every error code arc puts on the wire is catalogued in
 * `@classytic/repo-core/errors` — the contract client SDKs (arc-next) consume
 * without depending on arc. A new `"arc.*"` code, or a new UPPER_SNAKE reason
 * code, must be added there first; this fails otherwise, which is what keeps
 * the client's error vocabulary from drifting.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ARC_ERROR_CODES, ARC_REASON_CODES } from "@classytic/repo-core/errors";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../../src");

/**
 * `arc.*` strings that are not error codes: event types, a cookie name, a
 * Symbol description. Kept explicit so a new one is a visible decision.
 */
const NOT_ERROR_CODES = new Set([
  "arc.ready",
  "arc.resource.registered",
  "arc.cache.version.bumped",
  "arc.cache.tag.bumped",
  "arc.events.observers",
  "arc.permissions.invalidated",
  "arc.scope.elevated",
  "arc.webhook.delivery",
  "arc.session",
  "arc.module.absent",
  "arc.shutdown", // Symbol.for key in utils/shutdown.ts
]);

/**
 * UPPER_SNAKE `code:` literals that are not arc's wire output: a code arc
 * MATCHES (a driver's), and persisted outbox diagnostics.
 */
const NOT_WIRE_REASON_CODES = new Set([
  "P2025", // Prisma's record-not-found, compared in store-helpers
  "MALFORMED_EVENT", // outbox row `lastError.code`, not an HTTP response
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // CLI templates are generated host code, not arc's wire output.
      if (!full.includes(`${path.sep}templates`)) sourceFiles(full, out);
    } else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Code, not comments — a code named in prose (`fastify.arc.modules`) is not emitted. */
function scan(pattern: RegExp): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    for (const m of code.matchAll(pattern)) {
      const value = m[1];
      if (value && !found.has(value)) found.set(value, path.relative(SRC, file));
    }
  }
  return found;
}

describe("error-code catalog (repo-core) covers everything arc emits", () => {
  it('every "arc.*" string literal is a catalogued code or a known non-code', () => {
    const catalogued = new Set<string>(Object.values(ARC_ERROR_CODES));
    // Quoted literals only — a backticked `arc.x` inside a message is prose.
    const missing = [...scan(/["'](arc\.[a-z_.]+)["']/g)]
      .filter(([code]) => !catalogued.has(code) && !NOT_ERROR_CODES.has(code))
      .map(([code, file]) => `${code} (${file})`);
    expect(missing, "add these to ARC_ERROR_CODES in @classytic/repo-core/errors").toEqual([]);
  });

  it("every UPPER_SNAKE `code:` is a catalogued reason code", () => {
    const catalogued = new Set<string>(Object.values(ARC_REASON_CODES));
    const missing = [...scan(/\bcode:\s*["']([A-Z][A-Z0-9_]+)["']/g)]
      .filter(([code]) => !catalogued.has(code) && !NOT_WIRE_REASON_CODES.has(code))
      .map(([code, file]) => `${code} (${file})`);
    expect(missing, "add these to ARC_REASON_CODES in @classytic/repo-core/errors").toEqual([]);
  });

  it("the non-code allowlist holds no catalogued code (it would hide a real one)", () => {
    const catalogued = new Set<string>(Object.values(ARC_ERROR_CODES));
    expect([...NOT_ERROR_CODES].filter((c) => catalogued.has(c))).toEqual([]);
  });
});
