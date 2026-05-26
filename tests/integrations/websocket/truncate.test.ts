/**
 * Outbound payload truncation — mirrors n8n's 5 MiB cap with a
 * `{type:'truncated', originalBytes, ...}` placeholder so a misbehaving
 * server-side emitter can't pin socket buffers across the fleet.
 */

import { describe, expect, it } from "vitest";
import {
  createTruncator,
  DEFAULT_MAX_OUTBOUND_BYTES,
  truncateOutbound,
} from "../../../src/integrations/websocket/outbound-truncate.js";

describe("truncateOutbound", () => {
  it("passes through payloads within the cap unchanged", () => {
    const payload = JSON.stringify({ hello: "world" });
    expect(truncateOutbound(payload)).toBe(payload);
  });

  it("createTruncator binds a per-instance cap (no module state)", () => {
    const tight = createTruncator(50);
    const loose = createTruncator(10_000);
    const payload = "x".repeat(200);
    // Two instances, two caps — neither affects the other.
    expect(JSON.parse(tight(payload)).type).toBe("truncated");
    expect(loose(payload)).toBe(payload);
  });

  it("replaces oversize payloads with a placeholder carrying the original size", () => {
    const big = JSON.stringify({ blob: "x".repeat(1024) });
    const truncated = JSON.parse(truncateOutbound(big, 100));
    expect(truncated.type).toBe("truncated");
    expect(truncated.originalBytes).toBeGreaterThan(100);
    expect(truncated.maxBytes).toBe(100);
    expect(typeof truncated.hint).toBe("string");
  });

  it("default cap is 5 MiB", () => {
    expect(DEFAULT_MAX_OUTBOUND_BYTES).toBe(5 * 1024 * 1024);
  });

  it("measures bytes via UTF-8 (multi-byte chars count correctly)", () => {
    // 4 emoji = 16 bytes (4 bytes each in UTF-8) — fits in 20, not in 10.
    const payload = "🌍🌍🌍🌍";
    expect(truncateOutbound(payload, 20)).toBe(payload);
    const truncated = JSON.parse(truncateOutbound(payload, 10));
    expect(truncated.type).toBe("truncated");
    expect(truncated.originalBytes).toBe(16);
  });
});
