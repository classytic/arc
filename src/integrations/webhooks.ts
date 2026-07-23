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
  /**
   * Max concurrent deliveries per event (default: 5). Set to 1 for
   * sequential. Must be >= 1 — the plugin throws at registration otherwise
   * (a zero would make the delivery loop spin forever without progress).
   */
  concurrency?: number;
  /**
   * In-process retry for failed deliveries. Default: single attempt.
   * Retries fire on network errors, timeouts, 429 and 5xx — NOT on other
   * 4xx (the receiver rejected the payload; repeating it can't succeed).
   * Each attempt is re-signed with a fresh timestamp so the receiver's
   * replay-tolerance window applies per attempt; `x-arc-webhook-delivery`
   * stays constant, which is exactly what receiver-side dedup keys on.
   *
   * This is BEST-EFFORT: attempts live in this process, so a crash or
   * deploy drops the remaining ones. Guaranteed delivery is a durable-job
   * concern (queue keyed by subscription + delivery id) — pair the events
   * outbox with a worker if you need it.
   */
  retry?: {
    /** Total attempts including the first. Must be an integer >= 1. */
    attempts: number;
    /** Backoff before retry N, as `backoffMs * 2^(N-1)` ms (default: 1000). */
    backoffMs?: number;
  };
  /**
   * URL policy hook — the SSRF seam for tenant-registered URLs. Throw to
   * reject. Pass {@link defaultWebhookUrlPolicy} to require HTTPS and block
   * localhost / link-local / private-network / cloud-metadata destinations,
   * or supply your own (allowlists, per-tenant rules).
   *
   * Enforcement points when set:
   *  - `register()` — new subscriptions are validated BEFORE saving.
   *  - Plugin init — every PERSISTED subscription is re-validated; failures
   *    are excluded from dispatch and logged (they stay in the store for
   *    the host to fix), so pre-policy rows and out-of-band store writes
   *    can't bypass the policy.
   *  - Delivery — `fetch` runs with `redirect: "manual"`, so an allowed
   *    public URL can't 302 into a blocked private/metadata target; a 3xx
   *    records as a failed delivery.
   *
   * Arc deliberately ships no DEFAULT policy — deployments differ (internal
   * webhooks to private services are legitimate), and DNS-rebinding
   * protection belongs at the actual outbound network boundary, not in the
   * framework.
   */
  validateUrl?: (url: URL, subscription: WebhookSubscription) => void | Promise<void>;
}

/** `WebhookSubscription` as returned by `list()` — secret withheld. */
export type WebhookSubscriptionPublic = Omit<WebhookSubscription, "secret">;

export interface WebhookManager {
  register(sub: WebhookSubscription): Promise<void> | void;
  unregister(id: string): Promise<void> | void;
  /**
   * Enumerate subscriptions WITHOUT their secrets — safe to surface in
   * admin UIs / API responses. Use {@link WebhookManager.getSecret} for
   * the privileged retrieval path.
   */
  list(): WebhookSubscriptionPublic[];
  /**
   * Privileged secret retrieval — separate from `list()` so enumerating
   * subscriptions never leaks signing material into logs or UIs.
   */
  getSecret(id: string): string | undefined;
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

// The legacy body-only signing format (`signPayload` → `x-webhook-signature`)
// was REMOVED in 2.24: it allowed indefinite replay of a captured request and
// carried the event id on an unsigned header. Arc emits ONLY the v1 contract
// (`x-arc-webhook-*`, timestamp + delivery-id bound — `signWebhook` /
// `verifyWebhook` below). `verifySignature` stays as a generic INBOUND
// verifier for third-party `sha256=<hex>` webhooks arc receives.

// ============================================================================
// v1 signing contract — replay-bounded, delivery-id-bound
// ============================================================================

/**
 * Signed-string layout for the v1 webhook contract:
 *
 *     v1.<timestampMs>.<deliveryId>.<body>
 *
 * Binding the timestamp bounds replay to the verifier's tolerance window,
 * and binding the delivery id lets receivers deduplicate redeliveries on an
 * AUTHENTICATED value (the legacy `x-webhook-id` header was unsigned — an
 * attacker replaying a captured request could change it and defeat dedup).
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

/**
 * Opt-in URL policy for tenant-registered webhooks: requires HTTPS and
 * rejects loopback, link-local, private-network, and cloud-metadata
 * destinations. Pass as `validateUrl: defaultWebhookUrlPolicy`.
 *
 * Scope note: this validates the URL LITERAL at registration time. It does
 * not resolve DNS — rebinding/level-2 SSRF protection belongs at the actual
 * outbound network boundary (egress proxy, network policy), where the real
 * connection target is known. Internal deployments that legitimately POST
 * to private services should write their own narrower policy instead.
 */
const BLOCKED_V4 = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/; // loopback, RFC1918, link-local (incl. 169.254.169.254 metadata), unspecified

export function defaultWebhookUrlPolicy(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(`Webhook URL must use https (got ${url.protocol}//)`);
  }
  // WHATWG URL keeps brackets on IPv6 hostnames — strip for inspection.
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  const blockedName =
    host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal";

  // IPv6 literals: loopback/unspecified, unique-local fc00::/7, link-local
  // fe80::/10, and IPv4-mapped — police the embedded v4, it reaches the
  // same private/metadata targets the v4 rules block. WHATWG URL
  // CANONICALIZES `::ffff:169.254.169.254` into hex groups
  // (`::ffff:a9fe:a9fe`), so decode both spellings back to dotted-quad.
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
 * Verify an INBOUND third-party webhook signature using timing-safe
 * comparison — for webhooks arc RECEIVES (GitHub, Stripe, ...), not for
 * arc-to-arc delivery. Arc's own outbound contract is v1
 * (`x-arc-webhook-*`) — receivers of arc webhooks use {@link verifyWebhook}.
 *
 * Defaults to the common `sha256=<hex>` format; configurable for any HMAC
 * scheme via options.
 *
 * ⚠ The `body` argument must be the exact bytes the sender signed. Fastify
 * parses JSON bodies by default and the re-serialised object will NOT match
 * the original signature. Register `fastify-raw-body` (arc's createApp does
 * this automatically with `global: false`) and opt the route in via
 * `config: { rawBody: true }`, then pass `req.rawBody` here.
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
 * // `config: { rawBody: true }` is REQUIRED — arc registers
 * // fastify-raw-body with `global: false`, so routes opt in per-route;
 * // without it `req.rawBody` is undefined and verifySignature throws a
 * // TypeError.
 *
 * // GitHub-style sender (sha256=<hex>)
 * fastify.post('/webhooks/github', { config: { rawBody: true } }, async (req, reply) => {
 *   const sig = req.headers['x-hub-signature-256'] as string;
 *   if (!verifySignature(req.rawBody, secret, sig)) {
 *     return reply.status(401).send({ error: 'Invalid signature' });
 *   }
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
  // Guard against the most common footgun: passing `req.body` (a parsed object)
  // instead of `req.rawBody` (the exact bytes the sender signed). Fastify
  // re-serialises JSON, so the HMAC would never match and the failure would
  // look like a wrong secret. Throw so the misuse surfaces at the call site.
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
  // A concurrency of 0 (or negative/NaN) would make the delivery loop below
  // splice empty batches forever — fail at boot, not at first delivery.
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

  // In-memory cache of subscriptions (loaded from store on init)
  let subscriptions: WebhookSubscription[] = [];
  const log: WebhookDeliveryRecord[] = [];

  // Load persisted subscriptions — and re-apply the URL policy to EVERY one.
  // `register()` validates new entries, but rows written before the policy
  // existed (or by another writer sharing the store) would otherwise bypass
  // it entirely. Failing boot on one poisoned row would turn a bad DB write
  // into an outage, so invalid entries are EXCLUDED from dispatch and logged
  // loudly instead — they stay in the store for the host to fix or
  // unregister.
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

      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        record.attempts = attempt;
        delete record.status;
        delete record.error;
        try {
          // v1 contract: timestamp + delivery id are INSIDE the signed
          // string, so replay is bounded by the receiver's tolerance window
          // and dedup runs on an authenticated id. Each attempt is re-signed
          // with a fresh timestamp; the delivery id stays constant so
          // receiver-side dedup treats retries as the same delivery.
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
              // With a URL policy active, following redirects would let an
              // ALLOWED public URL 302 into a blocked private/metadata target
              // — the policy validated the literal, not the redirect chain.
              // `manual` surfaces the 3xx as a failed delivery instead.
              // Without a policy the platform default (follow) is kept.
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
        // Retry only transient failures: network errors/timeouts (no
        // status) and 429/5xx. Other statuses — 4xx rejections, 3xx under
        // redirect: "manual" — are final for this payload.
        const transient =
          record.status === undefined || record.status === 429 || record.status >= 500;
        if (!transient || attempt === retryAttempts) break;
        await new Promise((r) => setTimeout(r, retryBackoffMs * 2 ** (attempt - 1)));
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
      // URL must at least parse; the host-supplied policy (SSRF guard,
      // allowlists) runs on the parsed URL and rejects by throwing.
      let parsed: URL;
      try {
        parsed = new URL(sub.url);
      } catch {
        throw new Error(`webhookPlugin: invalid webhook URL '${sub.url}'`);
      }
      if (opts.validateUrl) await opts.validateUrl(parsed, sub);

      await store.save(sub);
      // Update in-memory cache
      subscriptions = subscriptions.filter((s) => s.id !== sub.id);
      subscriptions.push(sub);
    },

    async unregister(id: string): Promise<void> {
      await store.remove(id);
      subscriptions = subscriptions.filter((s) => s.id !== id);
    },

    list(): WebhookSubscriptionPublic[] {
      // Secrets never leave via enumeration — admin UIs and API responses
      // consume list() wholesale; getSecret() is the privileged path.
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
