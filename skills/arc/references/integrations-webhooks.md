# Webhooks (outbound, signed)

```typescript
import { webhookPlugin, verifyWebhook, verifySignature, defaultWebhookUrlPolicy } from '@classytic/arc/integrations/webhooks';
```

Auto-delivers bus events to registered endpoints. Needs the events plugin (registered by `createApp`).

```typescript
await app.register(webhookPlugin, {
  store,                         // WebhookStore { name, getAll, save, remove }; default in-memory
  timeout: 10000,
  concurrency: 5,                // parallel deliveries per event
  maxLogEntries: 1000,
  retry: { attempts: 3, backoffMs: 1000 },   // best-effort in-process; network, timeout, 429, 5xx only
  validateUrl: defaultWebhookUrlPolicy,      // https only, blocks private, loopback, metadata hosts
  // durable: { store: outboxStore },        // guaranteed delivery, exclusive with retry
});

await app.webhooks.register({ id: 'wh-1', url: 'https://c.example/hook', events: ['order.*'], secret });
await app.events.publish('order.created', { orderId: '1' });   // signed POST to matches
```

`app.webhooks`: `register`, `unregister`, `list()` (secrets withheld), `getSecret(id)`, `deliveryLog(limit?)` (`{ subscriptionId, eventType, success, status?, error?, timestamp, attempts? }`).

- Patterns: exact, `order.*`, `*`.
- `validateUrl` runs on register, on every persisted subscription at init, and at delivery with `redirect: 'manual'` (a 3xx counts as failed). It checks the URL literal only; do DNS-rebinding defence at the egress boundary.

## Wire contract (v1)

Headers: `x-arc-webhook-signature: v1=<hex>`, `x-arc-webhook-timestamp` (epoch ms), `x-arc-webhook-delivery` (event `meta.id`, stable across retries). Body: `{ type, payload, meta }`. Signed string: `v1.<timestamp>.<deliveryId>.<body>` (HMAC-SHA256), so replay is bounded and dedupe uses an authenticated id. `signWebhook(body, secret, { timestamp, deliveryId })` produces it.

## Verify (receiver)

```typescript
app.post('/hooks/arc', { config: { rawBody: true } }, async (req, reply) => {
  const r = verifyWebhook({
    body: req.rawBody as string,          // exact bytes, never the parsed body
    secret,
    signature: req.headers['x-arc-webhook-signature'] as string,
    timestamp: req.headers['x-arc-webhook-timestamp'] as string,
    deliveryId: req.headers['x-arc-webhook-delivery'] as string,
    toleranceMs: 300000,                  // default
  });
  if (!r.valid) return reply.status(401).send({ error: r.reason });   // missing_headers | bad_timestamp | expired | bad_signature
  // dedupe on r.deliveryId, then handle
});
```

Third-party senders: `verifySignature(rawBody, secret, header, { prefix: 'sha256=', algorithm: 'sha256' })` returns boolean (`prefix: ''` for bare hex). Both throw `TypeError` when the body is not a string or Buffer (re-serialised JSON breaks the HMAC).

## Durable delivery

Each (event x subscription) becomes one outbox row (`<event id>:wh:<subscription id>` as dedupe key); a relay performs the signed POST, retries and dead-letters.

```typescript
import { createDurableWebhookModule, webhookDeliveryFailurePolicy } from '@classytic/arc/integrations/webhooks';
import { repositoryAsOutboxStore } from '@classytic/arc/events';

const store = repositoryAsOutboxStore(deliveryRepo);
await createApp({
  modules: [createDurableWebhookModule({ store, delivery: { maxAttempts: 8, baseMs: 5000, maxMs: 900000 } })],
  plugins: async (f) => { await f.register(webhookPlugin, { durable: { store } }); },
});
```

- Module name defaults to `'webhook-delivery'`. It accepts the `createOutboxModule` options plus `fetch`, `timeout`, `validateUrl`, `resolveHeaders(sub, event)`, `delivery`, `failurePolicy`.
- `resolveHeaders` cannot override `content-type` or the `x-arc-webhook-*` headers.
- Non-transient failures (4xx, 3xx, URL policy rejection, malformed row) dead-letter at once; transient ones (network, timeout, 429, 5xx) retry with backoff.
- The delivering process must also register `webhookPlugin` with the shared subscription store (checked at boot). `role: 'api'` only enqueues, `role: 'relay'` delivers.
- Row type constant: `WEBHOOK_DELIVERY_EVENT`; errors: `WebhookDeliveryError` (`status`, `transient`); lower level `createWebhookDeliveryTransport`.
