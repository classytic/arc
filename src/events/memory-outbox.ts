/**
 * In-memory outbox store — reference implementation for dev / testing.
 *
 * Supports the full `OutboxStore` capability set (claim/lease, fail/retry,
 * dedupe, visibleAt). Production deployments should pass a `repository` to
 * `EventOutbox` instead of using this; the memory store exists for unit
 * tests and single-process dev where durable persistence is noise.
 */

import type { DeadLetteredEvent, DomainEvent } from "./EventTransport.js";
import {
  InvalidOutboxEventError,
  type OutboxAcknowledgeOptions,
  type OutboxClaimOptions,
  type OutboxErrorInfo,
  type OutboxFailOptions,
  OutboxOwnershipError,
  type OutboxStore,
  type OutboxWriteOptions,
} from "./outbox.js";

const DEFAULT_LEASE_MS = 30_000;

interface MemoryEntry {
  event: DomainEvent;
  status: "pending" | "delivered" | "dead_letter";
  attempts: number;
  visibleAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number;
  deliveredAt: number | null;
  firstFailedAt: number | null;
  lastFailedAt: number | null;
  lastError: OutboxErrorInfo | null;
  dedupeKey?: string;
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly entries: MemoryEntry[] = [];
  private readonly seenDedupeKeys = new Set<string>();

  async save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
    if (!event?.type || typeof event.type !== "string") {
      throw new InvalidOutboxEventError("event.type is required");
    }
    if (!event.meta?.id || typeof event.meta.id !== "string") {
      throw new InvalidOutboxEventError("event.meta.id is required");
    }
    if (options?.dedupeKey) {
      if (this.seenDedupeKeys.has(options.dedupeKey)) return;
      this.seenDedupeKeys.add(options.dedupeKey);
    }
    this.entries.push({
      event,
      status: "pending",
      attempts: 0,
      visibleAt: options?.visibleAt?.getTime() ?? 0,
      leaseOwner: null,
      leaseExpiresAt: 0,
      deliveredAt: null,
      firstFailedAt: null,
      lastFailedAt: null,
      lastError: null,
      dedupeKey: options?.dedupeKey,
    });
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    const now = Date.now();
    return this.entries
      .filter(
        (e) =>
          e.status === "pending" &&
          e.visibleAt <= now &&
          (e.leaseOwner === null || e.leaseExpiresAt <= now),
      )
      .slice(0, limit)
      .map((e) => e.event);
  }

  async claimPending(options?: OutboxClaimOptions): Promise<DomainEvent[]> {
    const now = Date.now();
    const limit = options?.limit ?? 100;
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const consumerId = options?.consumerId ?? "anonymous";
    const typeFilter = options?.types ? new Set(options.types) : null;

    const claimed: DomainEvent[] = [];
    for (const entry of this.entries) {
      if (claimed.length >= limit) break;
      if (entry.status !== "pending") continue;
      if (entry.visibleAt > now) continue;
      if (entry.leaseOwner !== null && entry.leaseExpiresAt > now) continue;
      if (typeFilter && !typeFilter.has(entry.event.type)) continue;

      entry.leaseOwner = consumerId;
      entry.leaseExpiresAt = now + leaseMs;
      entry.attempts++;
      claimed.push(entry.event);
    }
    return claimed;
  }

  async acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void> {
    const entry = this.entries.find((e) => e.event.meta.id === eventId);
    if (!entry) return;
    if (entry.status === "delivered") return;
    if (options?.consumerId && entry.leaseOwner && entry.leaseOwner !== options.consumerId) {
      throw new OutboxOwnershipError(eventId, options.consumerId, entry.leaseOwner);
    }
    entry.status = "delivered";
    entry.deliveredAt = Date.now();
    entry.leaseOwner = null;
  }

  async fail(eventId: string, error: OutboxErrorInfo, options?: OutboxFailOptions): Promise<void> {
    const entry = this.entries.find((e) => e.event.meta.id === eventId);
    if (!entry) return;
    if (options?.consumerId && entry.leaseOwner && entry.leaseOwner !== options.consumerId) {
      throw new OutboxOwnershipError(eventId, options.consumerId, entry.leaseOwner);
    }
    const now = Date.now();
    entry.lastError = error;
    entry.leaseOwner = null;
    entry.leaseExpiresAt = 0;
    if (entry.firstFailedAt === null) entry.firstFailedAt = now;
    entry.lastFailedAt = now;
    if (options?.deadLetter) {
      entry.status = "dead_letter";
      return;
    }
    entry.status = "pending";
    entry.visibleAt = options?.retryAt ? options.retryAt.getTime() : 0;
  }

  async getDeadLettered(limit: number): Promise<DeadLetteredEvent[]> {
    const out: DeadLetteredEvent[] = [];
    for (const entry of this.entries) {
      if (out.length >= limit) break;
      if (entry.status !== "dead_letter") continue;
      out.push({
        event: entry.event,
        error: {
          message: entry.lastError?.message ?? "unknown",
          ...(entry.lastError?.code !== undefined ? { code: entry.lastError.code } : {}),
        },
        attempts: entry.attempts,
        firstFailedAt: new Date(entry.firstFailedAt ?? entry.lastFailedAt ?? Date.now()),
        lastFailedAt: new Date(entry.lastFailedAt ?? entry.firstFailedAt ?? Date.now()),
      });
    }
    return out;
  }

  async purge(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let purged = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry) continue;
      if (
        entry.status === "delivered" &&
        entry.deliveredAt !== null &&
        entry.deliveredAt < cutoff
      ) {
        if (entry.dedupeKey) this.seenDedupeKeys.delete(entry.dedupeKey);
        this.entries.splice(i, 1);
        purged++;
      }
    }
    return purged;
  }

  /** Test helper: inspect entry by id */
  _getEntry(eventId: string): Readonly<MemoryEntry> | undefined {
    return this.entries.find((e) => e.event.meta.id === eventId);
  }
}
