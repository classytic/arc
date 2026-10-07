/**
 * Outbound webhooks — auto-dispatch arc events to registered endpoints with
 * HMAC-SHA256 signing, delivery logging, and a pluggable `WebhookStore`.
 *
 * A separate subpath, loaded only when used:
 * `@classytic/arc/integrations/webhooks`. For at-least-once delivery use
 * `durable: { store }` / `createDurableWebhookModule` — the in-process retry
 * is explicitly best-effort.
 *
 * @example
 * ```typescript
 * await fastify.register(webhookPlugin);
 * app.webhooks.register({ id: 'wh-1', url, events: ['order.created'], secret });
 * await app.events.publish('order.created', { orderId: '123' }); // → signed POST
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createChildEvent, matchEventPattern } from "@classytic/primitives/events";
import type { OutboxFailurePolicy, OutboxStore } from "@classytic/primitives/outbox";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { DomainEvent, EventTransport } from "../events/EventTransport.js";
import { exponentialBackoff } from "../events/outbox/backoff.js";
import { createOutboxModule, type OutboxModuleOptions } from "../events/outbox-module.js";
import { declareRuntimeCapability } from "../utils/runtimeCapabilities.js";

// ============================================================================
// Types
// ============================================================================

export interface WebhookSubscription {
  /** Unique subscription ID */
  id: string;
  /** Delivery URL */
  url: string;
  /** Event patterns (e.g., 'order.created', 'order.*', '*') */
  events: string[];
  /** Shared secret for HMAC-SHA256 signing */
  secret: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface WebhookDeliveryRecord {
  subscriptionId: string;
  eventType: string;
  success: boolean;
  status?: number;
  error?: string;
  timestamp: Date;
  /** Delivery attempts made (present when `retry` is configured). */
  attempts?: number;
}

/** Pluggable persistence — memory for dev, bring your own DB for prod */
export interface WebhookStore {
  readonly name: string;
  getAll(): Promise<WebhookSubscription[]>;
  save(sub: WebhookSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface WebhookPluginOptions {
  /** Custom store for persistent subscriptions (default: in-memory) */
  store?: WebhookStore;
  /** Custom fetch (for testing) */
  fetch?: typeof globalThis.fetch;
  /** Delivery timeout in ms (default: 10000) */
  timeout?: number;
  /** Max delivery log entries kept in memory (default: 1000) */
  maxLogEntries?: number;
  /** Max concurrent deliveries per event, integer >= 1 (default: 5). */
  concurrency?: number;
  /**
   * In-process retry (default: single attempt) on network errors, timeouts,
   * 429 and 5xx — not other 4xx. Each attempt is re-signed with a fresh
   * timestamp; `x-arc-webhook-delivery` stays constant for receiver dedup.
   *
   * BEST-EFFORT: a crash or deploy drops remaining attempts. Use `durable`
   * for guaranteed delivery.
   */
  retry?: {
    /** Total attempts including the first. Must be an integer >= 1. */
    attempts: number;
    /** Backoff before retry N, as `backoffMs * 2^(N-1)` ms (default: 1000). */
    backoffMs?: number;
  };
  /**
   * URL policy — the SSRF seam for tenant-registered URLs; throw to reject.
   * Pass {@link defaultWebhookUrlPolicy} or your own. No policy applies by
   * default (internal webhooks to private services are legitimate).
   *
   * When set it is enforced:
   *  - on `register()`, before saving;
   *  - at init on every PERSISTED subscription — failures are excluded from
   *    dispatch and logged, so pre-policy / out-of-band rows can't bypass it;
   *  - at delivery via `redirect: "manual"`, so an allowed URL can't 302 into
   *    a blocked target (a 3xx records as failed).
   */
  validateUrl?: (url: URL, subscription: WebhookSubscription) => void | Promise<void>;
  /**
   * Durable delivery: each (event × subscription) becomes one outbox row that
   * `createDurableWebhookModule`'s relay delivers, retries and dead-letters,
   * surviving crash and deploy. The row id `<event id>:wh:<subscription id>`
   * doubles as `dedupeKey`, so an at-least-once upstream enqueues each
   * delivery once. Mutually exclusive with `retry`.
   */
  durable?: {
    /** Outbox store the delivery rows are written to — share it with the module. */
    store: OutboxStore;
  };
}

/** `WebhookSubscription` as returned by `list()` — secret withheld. */
export type WebhookSubscriptionPublic = Omit<WebhookSubscription, "secret">;

export interface WebhookManager {
  register(sub: WebhookSubscription): Promise<void> | void;
  unregister(id: string): Promise<void> | void;
  /** Subscriptions WITHOUT secrets — safe for admin UIs / API responses. */
  list(): WebhookSubscriptionPublic[];
  /** Privileged secret retrieval, kept out of `list()` so enumeration never leaks it. */
  getSecret(id: string): string | undefined;
  deliveryLog(limit?: number): WebhookDeliveryRecord[];
}

declare module "fastify" {
  interface FastifyInstance {
    webhooks: WebhookManager;
  }
}

// ============================================================================
// v1 signing contract — replay-bounded, delivery-id-bound
// ============================================================================

/**
 * Sign a v1 webhook. Signed string: `v1.<timestampMs>.<deliveryId>.<body>`.
 *
 * The timestamp bounds replay to the verifier's tolerance window; the
 * delivery id is signed so receivers dedupe on an AUTHENTICATED value (an
 * unsigned id header could be altered on replay to defeat dedup).
 *
 * Wire headers:
 *   - `x-arc-webhook-signature: v1=<hex hmac-sha256>`
 *   - `x-arc-webhook-timestamp: <unix epoch ms>`
 *   - `x-arc-webhook-delivery:  <delivery id>` (arc sends the event's
 *     `meta.id` — STABLE across retries of the same event, so dedup on it
 *     collapses redeliveries)
 */
export function signWebhook(
  body: string,
  secret: string,
  meta: { timestamp: number; deliveryId: string },
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`v1.${meta.timestamp}.${meta.deliveryId}.${body}`);
  return `v1=${hmac.digest("hex")}`;
}

export interface VerifyWebhookInput {
  /** Raw request body — the exact bytes the sender signed (`req.rawBody`). */
  body: string | Buffer;
  /** Shared secret. */
  secret: string;
  /** `x-arc-webhook-signature` header value (`v1=<hex>`). */
  signature: string | undefined;
  /** `x-arc-webhook-timestamp` header value (unix epoch ms). */
  timestamp: string | number | undefined;
  /** `x-arc-webhook-delivery` header value. */
  deliveryId: string | undefined;
  /**
   * Max allowed clock skew between sender timestamp and now, in ms.
   * @default 300_000 (5 minutes)
   */
  toleranceMs?: number;
  /** Injectable clock for tests. @default Date.now */
  now?: () => number;
}

export type VerifyWebhookResult =
  | {
      valid: true;
      /** The AUTHENTICATED delivery id — dedup redeliveries on this. */
      deliveryId: string;
      /** Sender timestamp (unix epoch ms), authenticated. */
      timestamp: number;
    }
  | { valid: false; reason: "missing_headers" | "bad_timestamp" | "expired" | "bad_signature" };

/**
 * Verify an inbound v1 arc webhook: signature + timestamp tolerance, and
 * return the authenticated delivery id for receiver-side deduplication.
 *
 * ⚠ Pass `req.rawBody` (route opted in via `config: { rawBody: true }`),
 * never the parsed `req.body` — re-serialised JSON won't match the HMAC.
 *
 * @example
 * ```typescript
 * fastify.post('/hooks/arc', { config: { rawBody: true } }, async (req, reply) => {
 *   const result = verifyWebhook({
 *     body: req.rawBody,
 *     secret: process.env.WEBHOOK_SECRET,
 *     signature: req.headers['x-arc-webhook-signature'] as string,
 *     timestamp: req.headers['x-arc-webhook-timestamp'] as string,
 *     deliveryId: req.headers['x-arc-webhook-delivery'] as string,
 *   });
 *   if (!result.valid) return reply.status(401).send({ error: result.reason });
 *   if (await seen(result.deliveryId)) return reply.send({ ok: true }); // dedup
 *   // ... handle, then mark result.deliveryId seen
 * });
 * ```
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  const { body, secret, signature, deliveryId, toleranceMs = 300_000, now = Date.now } = input;
  if (typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new TypeError(
      "verifyWebhook: body must be a string or Buffer (the exact bytes the sender signed). " +
        "Add `config: { rawBody: true }` to the route and pass req.rawBody — not req.body.",
    );
  }
  if (!signature || !deliveryId || input.timestamp === undefined || input.timestamp === "") {
    return { valid: false, reason: "missing_headers" };
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "bad_timestamp" };
  if (Math.abs(now() - timestamp) > toleranceMs) return { valid: false, reason: "expired" };

  const bodyString = typeof body === "string" ? body : body.toString("utf8");
  const expected = signWebhook(bodyString, secret, { timestamp, deliveryId });
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad_signature" };
  }
  return { valid: true, deliveryId, timestamp };
}

// ============================================================================
// URL policy — opt-in SSRF guard for tenant-registered webhook URLs
// ============================================================================

const BLOCKED_V4 = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/; // loopback, RFC1918, link-local (incl. 169.254.169.254 metadata), unspecified

/**
 * Opt-in URL policy: requires HTTPS and rejects loopback, link-local,
 * private-network and cloud-metadata hosts. Pass as `validateUrl`.
 *
 * Validates the URL LITERAL only — no DNS resolution. Rebinding protection
 * belongs at the outbound network boundary (egress proxy / network policy).
 */
export function defaultWebhookUrlPolicy(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(`Webhook URL must use https (got ${url.protocol}//)`);
  }
  // WHATWG URL keeps brackets on IPv6 hostnames — strip for inspection.
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  const blockedName =
    host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal";

  // IPv4-mapped IPv6 reaches the same targets, so police the embedded v4.
  // WHATWG URL canonicalizes it to hex groups (`::ffff:a9fe:a9fe`) — decode both spellings.
  const isV6 = host.includes(":");
  const mappedV4 = isV6 ? decodeMappedV4(host) : undefined;
  const blockedV6 =
    isV6 &&
    (host === "::1" ||
      host === "::" ||
      /^f[cd]/.test(host) || // fc00::/7 unique-local
      /^fe[89ab]/.test(host) || // fe80::/10 link-local
      (mappedV4 !== undefined && BLOCKED_V4.test(mappedV4)));

  const blockedV4 = !isV6 && BLOCKED_V4.test(host);

  if (blockedName || blockedV4 || blockedV6) {
    throw new Error(`Webhook URL host '${host}' is not allowed (loopback/private/metadata)`);
  }
}

/**
 * Decode an IPv4-mapped IPv6 literal to its dotted-quad form. Accepts both
 * the textual spelling (`::ffff:1.2.3.4`) and the hex-group canonical form
 * WHATWG URL produces (`::ffff:102:304`). Returns undefined for anything else.
 */
function decodeMappedV4(host: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  if (dotted) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex?.[1] || !hex[2]) return undefined;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Options for `verifySignature` — customize for non-Arc webhook senders */
export interface VerifySignatureOptions {
  /**
   * Expected prefix before the hex digest (default: `'sha256='`).
   * Set to `''` for bare hex signatures.
   */
  prefix?: string;
  /**
   * HMAC algorithm (default: `'sha256'`).
   * Must match what the sender uses.
   */
  algorithm?: string;
}

/**
 * Timing-safe verification of an INBOUND third-party webhook (GitHub,
 * Stripe, ...). Defaults to `sha256=<hex>`; prefix/algorithm configurable.
 * Receivers of arc's own webhooks use {@link verifyWebhook}.
 *
 * ⚠ `body` must be the exact signed bytes: opt the route into
 * `config: { rawBody: true }` (arc registers fastify-raw-body with
 * `global: false`) and pass `req.rawBody` — re-serialised JSON won't match.
 *
 * @returns `true` if valid, `false` otherwise. Throws `TypeError` only when
 *   `body` is not a string/Buffer.
 *
 * @example
 * ```typescript
 * fastify.post('/webhooks/github', { config: { rawBody: true } }, async (req, reply) => {
 *   const sig = req.headers['x-hub-signature-256'] as string;
 *   if (!verifySignature(req.rawBody, secret, sig)) {
 *     return reply.status(401).send({ error: 'Invalid signature' });
 *   }
 * });
 * ```
 */
export function verifySignature(
  body: string | Buffer,
  secret: string,
  signature: string | undefined,
  options?: VerifySignatureOptions,
): boolean {
  // A parsed `req.body` would never match and look like a wrong secret — throw instead.
  if (typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new TypeError(
      "verifySignature: body must be a string or Buffer (the exact bytes the sender signed). " +
        "Add `config: { rawBody: true }` to the route (arc registers fastify-raw-body " +
        "with global: false) and pass req.rawBody — not req.body.",
    );
  }

  if (!signature) return false;

  const prefix = options?.prefix ?? "sha256=";
  const algorithm = options?.algorithm ?? "sha256";

  if (prefix && !signature.startsWith(prefix)) return false;

  const providedHex = signature.slice(prefix.length);
  if (!providedHex) return false;

  const hmac = createHmac(algorithm, secret);
  hmac.update(typeof body === "string" ? body : body);
  const expectedHex = hmac.digest("hex");

  // timingSafeEqual needs equal lengths; leaking a length mismatch reveals nothing.
  if (providedHex.length !== expectedHex.length) return false;

  try {
    return timingSafeEqual(Buffer.from(providedHex, "hex"), Buffer.from(expectedHex, "hex"));
  } catch {
    return false;
  }
}

// ============================================================================
// Pattern matching
// ============================================================================

/** The transports' own matcher — a local copy missed `order:*` (the `:` convention). */
function matchesPattern(patterns: string[], eventType: string): boolean {
  return patterns.some((pattern) => matchEventPattern(pattern, eventType));
}

// ============================================================================
// MemoryWebhookStore — dev/testing default
// ============================================================================

class MemoryWebhookStore implements WebhookStore {
  readonly name = "memory";
  private subs = new Map<string, WebhookSubscription>();

  async getAll(): Promise<WebhookSubscription[]> {
    return [...this.subs.values()];
  }

  async save(sub: WebhookSubscription): Promise<void> {
    this.subs.set(sub.id, sub);
  }

  async remove(id: string): Promise<void> {
    this.subs.delete(id);
  }
}

// ============================================================================
// Plugin
// ============================================================================

const webhookPlugin: FastifyPluginAsync<WebhookPluginOptions> = async (
  fastify: FastifyInstance,
  opts: WebhookPluginOptions = {},
) => {
  const store = opts.store ?? new MemoryWebhookStore();
  // A host-supplied store is presumed shared across replicas.
  declareRuntimeCapability(fastify, {
    subsystem: "webhooks.store",
    durability: opts.store ? "shared" : "memory",
    detail: "default MemoryWebhookStore: subscriptions + delivery log are replica-local",
  });
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeout = opts.timeout ?? 10000;
  const maxLogEntries = opts.maxLogEntries ?? 1000;
  const concurrency = opts.concurrency ?? 5;
  // < 1 would make the delivery loop splice empty batches forever.
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `webhookPlugin: concurrency must be an integer >= 1 (got ${String(opts.concurrency)})`,
    );
  }
  const retryAttempts = opts.retry?.attempts ?? 1;
  const retryBackoffMs = opts.retry?.backoffMs ?? 1000;
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1) {
    throw new Error(
      `webhookPlugin: retry.attempts must be an integer >= 1 (got ${String(opts.retry?.attempts)})`,
    );
  }
  // Two retry axes would double-attempt every failure.
  if (opts.durable && opts.retry) {
    throw new Error(
      "webhookPlugin: `durable` and `retry` are mutually exclusive — durable delivery " +
        "retries via the relay's failure policy (webhookDeliveryFailurePolicy), not in-process.",
    );
  }
  const durableStore = opts.durable?.store;

  let subscriptions: WebhookSubscription[] = [];
  const log: WebhookDeliveryRecord[] = [];

  // Re-apply the URL policy to every persisted row. Invalid rows are excluded
  // and logged rather than failing boot — one bad DB write must not be an outage.
  subscriptions = await store.getAll();
  if (opts.validateUrl) {
    const admitted: WebhookSubscription[] = [];
    for (const sub of subscriptions) {
      try {
        await opts.validateUrl(new URL(sub.url), sub);
        admitted.push(sub);
      } catch (err) {
        fastify.log.warn(
          { subscriptionId: sub.id, url: sub.url, err },
          "webhookPlugin: persisted subscription failed the URL policy — excluded from dispatch. " +
            "Fix the URL or unregister the subscription.",
        );
      }
    }
    subscriptions = admitted;
  }

  async function dispatchEvent(event: DomainEvent): Promise<void> {
    const matching = subscriptions.filter((s) => matchesPattern(s.events, event.type));
    if (matching.length === 0) return;

    // Durable mode: enqueue rows; the relay owns the POST. A thrown save
    // PROPAGATES so an upstream durable chain retries instead of losing it.
    if (durableStore) {
      for (const sub of matching) {
        const deliveryId = `${event.meta.id}:wh:${sub.id}`;
        const delivery = createChildEvent(
          event,
          WEBHOOK_DELIVERY_EVENT,
          {
            subscriptionId: sub.id,
            event: { type: event.type, payload: event.payload, meta: event.meta },
          } satisfies WebhookDeliveryPayload,
          { id: deliveryId },
        );
        await durableStore.save(delivery, { dedupeKey: deliveryId });
      }
      return;
    }

    const body = JSON.stringify({
      type: event.type,
      payload: event.payload,
      meta: event.meta,
    });

    async function deliverToSubscription(sub: WebhookSubscription): Promise<void> {
      const record: WebhookDeliveryRecord = {
        subscriptionId: sub.id,
        eventType: event.type,
        success: false,
        timestamp: new Date(),
      };

      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        record.attempts = attempt;
        delete record.status;
        delete record.error;
        try {
          // Fresh timestamp per attempt; the delivery id stays constant for receiver dedup.
          const timestamp = Date.now();
          const v1Signature = signWebhook(body, sub.secret, {
            timestamp,
            deliveryId: event.meta.id,
          });

          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeout);

          try {
            const response = await fetchFn(sub.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-arc-webhook-signature": v1Signature,
                "x-arc-webhook-timestamp": String(timestamp),
                "x-arc-webhook-delivery": event.meta.id,
              },
              body,
              signal: ac.signal,
              // The policy validated the literal, not the redirect chain — don't
              // let an allowed URL 302 into a blocked target.
              ...(opts.validateUrl ? { redirect: "manual" as const } : {}),
            });

            record.success = response.ok;
            record.status = response.status;
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          record.error = err instanceof Error ? err.message : String(err);
        }

        if (record.success) break;
        // Transient: no status (network/timeout), 429, 5xx. Anything else is final.
        const transient =
          record.status === undefined || record.status === 429 || record.status >= 500;
        if (!transient || attempt === retryAttempts) break;
        await new Promise((r) => setTimeout(r, retryBackoffMs * 2 ** (attempt - 1)));
      }

      log.push(record);
      if (log.length > maxLogEntries) {
        log.splice(0, log.length - maxLogEntries);
      }
    }

    const pending = [...matching];
    while (pending.length > 0) {
      const batch = pending.splice(0, concurrency);
      await Promise.allSettled(batch.map(deliverToSubscription));
    }
  }

  // Wildcard subscription; matching happens in dispatchEvent.
  let unsubscribe: (() => void) | undefined;

  if (fastify.events) {
    unsubscribe = await fastify.events.subscribe("*", dispatchEvent);
  }

  const manager: WebhookManager = {
    async register(sub: WebhookSubscription): Promise<void> {
      let parsed: URL;
      try {
        parsed = new URL(sub.url);
      } catch {
        throw new Error(`webhookPlugin: invalid webhook URL '${sub.url}'`);
      }
      if (opts.validateUrl) await opts.validateUrl(parsed, sub);

      await store.save(sub);
      subscriptions = subscriptions.filter((s) => s.id !== sub.id);
      subscriptions.push(sub);
    },

    async unregister(id: string): Promise<void> {
      await store.remove(id);
      subscriptions = subscriptions.filter((s) => s.id !== id);
    },

    list(): WebhookSubscriptionPublic[] {
      return subscriptions.map(({ secret: _secret, ...pub }) => pub);
    },

    getSecret(id: string): string | undefined {
      return subscriptions.find((s) => s.id === id)?.secret;
    },

    deliveryLog(limit?: number): WebhookDeliveryRecord[] {
      if (limit) return log.slice(-limit);
      return [...log];
    },
  };

  fastify.decorate("webhooks", manager);

  fastify.addHook("onClose", async () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  });
};

export default fp(webhookPlugin, {
  name: "arc-webhooks",
  fastify: "5.x",
  dependencies: ["arc-events"],
});

export { webhookPlugin };

// ============================================================================
// Durable delivery — the outbox→worker composition
// ============================================================================
//
// A webhook delivery IS an outbox event: the relay's transport `publish()`
// performs the signed POST, so lease, fencing, failure policy and DLQ apply unchanged.

/** Event type carried by durable webhook delivery rows. */
export const WEBHOOK_DELIVERY_EVENT = "arc.webhook.delivery";

/** Payload of a {@link WEBHOOK_DELIVERY_EVENT} row. */
export interface WebhookDeliveryPayload {
  subscriptionId: string;
  /** The original event, verbatim — what the receiver is signed and sent. */
  event: { type: string; payload: unknown; meta: DomainEvent["meta"] };
}

/**
 * A failed webhook POST. `transient` (network, timeout, 429, 5xx) retries;
 * anything else (4xx, 3xx, URL-policy rejection, malformed row) dead-letters.
 */
export class WebhookDeliveryError extends Error {
  readonly status?: number;
  readonly transient: boolean;

  constructor(message: string, options: { status?: number; transient: boolean; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WebhookDeliveryError";
    if (options.status !== undefined) this.status = options.status;
    this.transient = options.transient;
  }
}

export interface WebhookDeliveryTransportOptions {
  /**
   * Resolve a subscription (WITH secret) per attempt. `undefined` (unregistered)
   * acknowledges the delivery as moot.
   */
  getSubscription: (
    id: string,
  ) => WebhookSubscription | undefined | Promise<WebhookSubscription | undefined>;
  /** Custom fetch (for testing). */
  fetch?: typeof globalThis.fetch;
  /** Per-POST timeout in ms (default: 10000). */
  timeout?: number;
  /**
   * Same seam as {@link WebhookPluginOptions.validateUrl}, enforced at
   * DELIVERY time (with `redirect: "manual"`); a rejection is permanent.
   */
  validateUrl?: (url: URL, subscription: WebhookSubscription) => void | Promise<void>;
  /** Resolve private auth headers at delivery time; reserved Arc headers cannot be replaced. */
  resolveHeaders?: (
    subscription: WebhookSubscription,
    event: WebhookDeliveryPayload["event"],
  ) => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * Publish-only `EventTransport` whose `publish()` IS the webhook POST, for an
 * outbox relay. Throws {@link WebhookDeliveryError} on failure; returns on
 * 2xx or an unregistered subscription.
 *
 * Same wire contract as inline dispatch: `x-arc-webhook-delivery` is the
 * ORIGINAL event's `meta.id`, stable across retries.
 */
export function createWebhookDeliveryTransport(
  options: WebhookDeliveryTransportOptions,
): EventTransport {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeout = options.timeout ?? 10000;

  return {
    name: "webhook-delivery",

    async publish(event: DomainEvent): Promise<void> {
      if (event.type !== WEBHOOK_DELIVERY_EVENT) {
        throw new WebhookDeliveryError(
          `webhook-delivery transport received event type '${event.type}' — this store must ` +
            `contain only ${WEBHOOK_DELIVERY_EVENT} rows (wiring bug: wrong store or transport)`,
          { transient: false },
        );
      }
      const payload = event.payload as Partial<WebhookDeliveryPayload> | undefined;
      if (!payload?.subscriptionId || !payload.event?.meta?.id) {
        throw new WebhookDeliveryError(
          "webhook-delivery row is malformed: payload.subscriptionId and payload.event required",
          { transient: false },
        );
      }

      const sub = await options.getSubscription(payload.subscriptionId);
      if (!sub) return; // unregistered → delivery is moot; acknowledge

      let url: URL;
      try {
        url = new URL(sub.url);
        if (options.validateUrl) await options.validateUrl(url, sub);
      } catch (err) {
        throw new WebhookDeliveryError(
          `webhook URL rejected for subscription '${sub.id}': ${err instanceof Error ? err.message : String(err)}`,
          { transient: false, cause: err },
        );
      }

      const body = JSON.stringify(payload.event);
      const timestamp = Date.now();
      const v1Signature = signWebhook(body, sub.secret, {
        timestamp,
        deliveryId: payload.event.meta.id,
      });
      const extraHeaders = options.resolveHeaders
        ? await options.resolveHeaders(sub, payload.event)
        : {};
      assertWebhookHeaderOverrides(extraHeaders);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      let response: Response;
      try {
        response = await fetchFn(sub.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-arc-webhook-signature": v1Signature,
            "x-arc-webhook-timestamp": String(timestamp),
            "x-arc-webhook-delivery": payload.event.meta.id,
            ...extraHeaders,
          },
          body,
          signal: ac.signal,
          ...(options.validateUrl ? { redirect: "manual" as const } : {}),
        });
      } catch (err) {
        throw new WebhookDeliveryError(
          `webhook POST to subscription '${sub.id}' failed: ${err instanceof Error ? err.message : String(err)}`,
          { transient: true, cause: err },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new WebhookDeliveryError(
          `webhook POST to subscription '${sub.id}' returned ${response.status}`,
          {
            status: response.status,
            transient: response.status === 429 || response.status >= 500,
          },
        );
      }
    },
  };
}

export interface WebhookDeliveryPolicyOptions {
  /** Total attempts before dead-lettering (default: 8). */
  maxAttempts?: number;
  /** First retry delay in ms (default: 5000). */
  baseMs?: number;
  /** Backoff cap in ms (default: 900000 — 15 minutes). */
  maxMs?: number;
}

/**
 * Default durable-delivery policy: non-transient {@link WebhookDeliveryError}s
 * dead-letter immediately; others retry with exponential backoff until
 * `maxAttempts`.
 */
export function webhookDeliveryFailurePolicy(
  options: WebhookDeliveryPolicyOptions = {},
): OutboxFailurePolicy {
  const maxAttempts = options.maxAttempts ?? 8;
  const baseMs = options.baseMs ?? 5000;
  const maxMs = options.maxMs ?? 900_000;
  return ({ error, attempts }) => {
    if (error instanceof WebhookDeliveryError && !error.transient) return { deadLetter: true };
    if (attempts >= maxAttempts) return { deadLetter: true };
    return { retryAt: exponentialBackoff({ attempt: attempts, baseMs, maxMs }) };
  };
}

export interface DurableWebhookModuleOptions
  extends Omit<OutboxModuleOptions, "name" | "transport" | "failurePolicy">,
    Pick<WebhookDeliveryTransportOptions, "fetch" | "timeout" | "validateUrl" | "resolveHeaders"> {
  /** Module name / `dependsOn` key. Default `'webhook-delivery'`. */
  name?: string;
  /** Retry/backoff tuning for the default failure policy. */
  delivery?: WebhookDeliveryPolicyOptions;
  /** Full policy override — replaces {@link webhookDeliveryFailurePolicy}. */
  failurePolicy?: OutboxFailurePolicy;
}

/**
 * Durable webhook delivery as a module: the outbox relay machinery pointed at
 * webhook POSTs. Pair with `webhookPlugin`'s `durable` option sharing the
 * same store:
 *
 * ```ts
 * const store = repositoryAsOutboxStore(deliveryRepo);
 * createApp({
 *   modules: [createDurableWebhookModule({ store })],
 *   plugins: async (f) => {
 *     await f.register(webhookPlugin, { durable: { store } });
 *   },
 * });
 * ```
 *
 * `role: 'relay'` deployments deliver; `role: 'api'` only enqueues. The
 * delivering process must ALSO register `webhookPlugin` with the shared
 * subscription store (boot-checked).
 */
export function createDurableWebhookModule(
  options: DurableWebhookModuleOptions,
): ReturnType<typeof createOutboxModule> {
  const {
    name,
    delivery,
    failurePolicy,
    fetch,
    timeout,
    validateUrl,
    resolveHeaders,
    ...outboxOptions
  } = options;
  return createOutboxModule({
    ...outboxOptions,
    name: name ?? "webhook-delivery",
    transport: (fastify) => {
      if (!fastify.hasDecorator("webhooks")) {
        throw new Error(
          `Durable webhook module "${name ?? "webhook-delivery"}" requires webhookPlugin — ` +
            "subscriptions resolve through fastify.webhooks at delivery time. Register it " +
            "in plugins() (with the SHARED subscription store in multi-process topologies).",
        );
      }
      return createWebhookDeliveryTransport({
        getSubscription: (id) => {
          const pub = fastify.webhooks.list().find((s) => s.id === id);
          if (!pub) return undefined;
          const secret = fastify.webhooks.getSecret(id);
          return secret === undefined ? undefined : { ...pub, secret };
        },
        ...(fetch !== undefined ? { fetch } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(validateUrl !== undefined ? { validateUrl } : {}),
        ...(resolveHeaders !== undefined ? { resolveHeaders } : {}),
      });
    },
    failurePolicy: failurePolicy ?? webhookDeliveryFailurePolicy(delivery),
  });
}

const RESERVED_WEBHOOK_HEADERS = new Set([
  "content-type",
  "x-arc-webhook-signature",
  "x-arc-webhook-timestamp",
  "x-arc-webhook-delivery",
]);

function assertWebhookHeaderOverrides(headers: Record<string, string>): void {
  const reserved = Object.keys(headers).find((name) =>
    RESERVED_WEBHOOK_HEADERS.has(name.toLowerCase()),
  );
  if (reserved) {
    throw new WebhookDeliveryError(`webhook authentication header '${reserved}' is reserved`, {
      transient: false,
    });
  }
}
