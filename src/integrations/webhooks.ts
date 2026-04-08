/**
 * @classytic/arc — Webhook Outbound Integration
 *
 * Fastify plugin that auto-dispatches Arc events to registered webhook
 * endpoints with HMAC-SHA256 signing, delivery logging, and pluggable
 * persistence via WebhookStore.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
 *
 * @example
 * ```typescript
 * import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
 *
 * await fastify.register(webhookPlugin);
 *
 * // Register a customer webhook
 * app.webhooks.register({
 *   id: 'wh-1',
 *   url: 'https://customer.com/webhook',
 *   events: ['order.created', 'order.shipped'],
 *   secret: 'whsec_abc123',
 * });
 *
 * // Events auto-dispatch — no manual wiring needed
 * await app.events.publish('order.created', { orderId: '123' });
 * // → POST https://customer.com/webhook with HMAC signature
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { DomainEvent } from "../events/EventTransport.js";

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
  /** Max concurrent deliveries per event (default: 5). Set to 1 for sequential. */
  concurrency?: number;
}

export interface WebhookManager {
  register(sub: WebhookSubscription): Promise<void> | void;
  unregister(id: string): Promise<void> | void;
  list(): WebhookSubscription[];
  deliveryLog(limit?: number): WebhookDeliveryRecord[];
}

declare module "fastify" {
  interface FastifyInstance {
    webhooks: WebhookManager;
  }
}

// ============================================================================
// HMAC Signing & Verification
// ============================================================================

/**
 * Sign a payload with HMAC-SHA256 for outbound webhook delivery.
 *
 * @returns `sha256=<hex>` — the format written to `x-webhook-signature`
 */
export function signPayload(payload: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
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
   * Must match what the sender uses — Arc's `signPayload` always uses sha256.
   */
  algorithm?: string;
}

/**
 * Verify an inbound webhook signature using timing-safe comparison.
 *
 * Works with Arc's own `signPayload` format by default (`sha256=<hex>`),
 * but configurable for any HMAC scheme via options.
 *
 * @param body      - Raw request body (string or Buffer — must be the exact bytes the sender signed)
 * @param secret    - Shared secret between sender and receiver
 * @param signature - The signature header value (e.g. `req.headers['x-webhook-signature']`)
 * @param options   - Override prefix/algorithm for non-Arc senders
 * @returns `true` if valid, `false` otherwise — never throws
 *
 * @example
 * ```typescript
 * import { verifySignature } from '@classytic/arc/integrations/webhooks';
 *
 * // Arc-to-Arc (default headers + format)
 * fastify.post('/webhooks/incoming', async (req, reply) => {
 *   const sig = req.headers['x-webhook-signature'] as string;
 *   if (!verifySignature(req.rawBody, secret, sig)) {
 *     return reply.status(401).send({ error: 'Invalid signature' });
 *   }
 *   // handle event via req.headers['x-webhook-event']
 * });
 *
 * // Third-party sender with custom header + bare hex
 * const valid = verifySignature(body, secret, req.headers['x-hub-signature'], {
 *   prefix: 'sha256=',  // GitHub format
 * });
 *
 * // Stripe-style (bare hex, different header)
 * const valid = verifySignature(body, stripeSecret, req.headers['stripe-signature'], {
 *   prefix: '',
 * });
 * ```
 */
export function verifySignature(
  body: string | Buffer,
  secret: string,
  signature: string | undefined,
  options?: VerifySignatureOptions,
): boolean {
  if (!signature) return false;

  const prefix = options?.prefix ?? "sha256=";
  const algorithm = options?.algorithm ?? "sha256";

  // Validate prefix
  if (prefix && !signature.startsWith(prefix)) return false;

  const providedHex = signature.slice(prefix.length);
  if (!providedHex) return false;

  // Compute expected
  const hmac = createHmac(algorithm, secret);
  hmac.update(typeof body === "string" ? body : body);
  const expectedHex = hmac.digest("hex");

  // Length check before timing-safe compare (lengths leaking is acceptable —
  // a wrong-length hex is already an invalid signature, not a partial match)
  if (providedHex.length !== expectedHex.length) return false;

  try {
    return timingSafeEqual(Buffer.from(providedHex, "hex"), Buffer.from(expectedHex, "hex"));
  } catch {
    // Malformed hex → not a valid signature
    return false;
  }
}

// ============================================================================
// Pattern matching (shared with MemoryEventTransport)
// ============================================================================

function matchesPattern(patterns: string[], eventType: string): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (eventType.startsWith(`${prefix}.`)) return true;
    }
  }
  return false;
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
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeout = opts.timeout ?? 10000;
  const maxLogEntries = opts.maxLogEntries ?? 1000;
  const concurrency = opts.concurrency ?? 5;

  // In-memory cache of subscriptions (loaded from store on init)
  let subscriptions: WebhookSubscription[] = [];
  const log: WebhookDeliveryRecord[] = [];

  // Load persisted subscriptions
  subscriptions = await store.getAll();

  // -------------------------------------------------------------------
  // Dispatch a single event to all matching subscriptions
  // -------------------------------------------------------------------

  async function dispatchEvent(event: DomainEvent): Promise<void> {
    const matching = subscriptions.filter((s) => matchesPattern(s.events, event.type));
    if (matching.length === 0) return;

    const body = JSON.stringify({
      type: event.type,
      payload: event.payload,
      meta: event.meta,
    });

    // Bounded concurrency — one slow endpoint doesn't block the rest.
    // Default: 5 concurrent deliveries. Set concurrency: 1 for sequential.
    async function deliverToSubscription(sub: WebhookSubscription): Promise<void> {
      const record: WebhookDeliveryRecord = {
        subscriptionId: sub.id,
        eventType: event.type,
        success: false,
        timestamp: new Date(),
      };

      try {
        const signature = signPayload(body, sub.secret);

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout);

        try {
          const response = await fetchFn(sub.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-webhook-signature": signature,
              "x-webhook-id": event.meta.id,
              "x-webhook-event": event.type,
            },
            body,
            signal: ac.signal,
          });

          record.success = response.ok;
          record.status = response.status;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
      }

      // Append to log (ring buffer)
      log.push(record);
      if (log.length > maxLogEntries) {
        log.splice(0, log.length - maxLogEntries);
      }
    }

    // Execute with bounded concurrency
    const pending = [...matching];
    while (pending.length > 0) {
      const batch = pending.splice(0, concurrency);
      await Promise.allSettled(batch.map(deliverToSubscription));
    }
  }

  // -------------------------------------------------------------------
  // Auto-subscribe to Arc events (wildcard — we filter internally)
  // Track unsubscribe handle for lifecycle cleanup (mirrors websocket.ts)
  // -------------------------------------------------------------------

  let unsubscribe: (() => void) | undefined;

  if (fastify.events) {
    unsubscribe = await fastify.events.subscribe("*", dispatchEvent);
  }

  // -------------------------------------------------------------------
  // Decorate fastify.webhooks
  // -------------------------------------------------------------------

  const manager: WebhookManager = {
    async register(sub: WebhookSubscription): Promise<void> {
      await store.save(sub);
      // Update in-memory cache
      subscriptions = subscriptions.filter((s) => s.id !== sub.id);
      subscriptions.push(sub);
    },

    async unregister(id: string): Promise<void> {
      await store.remove(id);
      subscriptions = subscriptions.filter((s) => s.id !== id);
    },

    list(): WebhookSubscription[] {
      return [...subscriptions];
    },

    deliveryLog(limit?: number): WebhookDeliveryRecord[] {
      if (limit) return log.slice(-limit);
      return [...log];
    },
  };

  fastify.decorate("webhooks", manager);

  // Cleanup on server close — release wildcard listener to prevent leaks
  // in hot-reload, test runners, or multi-app processes
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
