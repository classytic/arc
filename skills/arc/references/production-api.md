# Production: errors, responses, versioning, rate limits, bulk, OpenAPI

## Errors

`errorHandlerPlugin` is on by default in `createApp`. It maps AJV, driver duplicate-key (409 `arc.conflict`), repo-core errors and `ArcError` to the `ErrorContract` `{ code, message, status }`; unknown routes answer 404 `arc.not_found`.

```typescript
import { defineErrorMapper, createDomainError } from '@classytic/arc/utils';

class AccountingError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

const app = await createApp({
  errorHandler: {
    errorMappers: [defineErrorMapper({
      type: AccountingError,
      toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
    })],
    errorMap: { PaymentError: { statusCode: 402, code: 'app.payment_failed' } },   // by error.name, lower priority
    onError: (err, request) => Sentry.captureException(err),
  },
});

throw createDomainError('INSUFFICIENT_BALANCE', 'Not enough credits', 402, { balance: 0 });
```

Mappers run via `instanceof` before any other classification; first match wins. Internal messages are hidden in production (`exposeInternalMessages`).

## Reply helpers and serialization

Arc returns raw data on success (no envelope); the HTTP status discriminates. `createApp({ replyHelpers: true })` adds two decorators:

```typescript
return reply.sendList(result);                    // kit-shaped paginated result or bare array to the canonical list shape
return reply.stream(csvReadable, { contentType: 'text/csv', filename: 'export.csv' });
```

`serializeBigInt: 'string'` turns BigInt into lossless decimal strings (`'number'` is lossy above 2^53-1); the default throws on BigInt.

## Multipart bodies on CRUD routes

```typescript
import { multipartBody } from '@classytic/arc/middleware';

defineResource({
  middlewares: { create: [multipartBody({ allowedMimeTypes: ['image/png'], maxFileSize: 5_000_000, maxFiles: 3, filesKey: '_files' })] },
  hooks: { 'before:create': async (data) => { /* data._files.image */ return data; } },
});
```

Parses fields into `req.body` and files into `req.body[filesKey]`; no-op for JSON requests.

## Versioning

```typescript
createApp({ arcPlugins: { versioning: { type: 'header', defaultVersion: '1', versions: ['1', '2'], sunset: '2026-12-01' } } });
// type 'prefix': /v2/products
```

Reads `accept-version` (`headerName`), sets `x-api-version` (`responseHeader`) and `request.apiVersion`. `VersioningOptions` also takes a list of retiring versions (see the type); those get `Deprecation: true` and a `Sunset` header from `sunset` (ISO date). With `versions` set, other versions return 400 `arc.unsupported_api_version` (`defaultVersion` must be listed); without it the plugin only annotates.

## Rate limiting

```typescript
createApp({
  rateLimit: {
    max: 100, timeWindow: '1 minute',   // per signed-in user; per IP when anonymous
    redis,                              // shared store, required with runtime 'distributed'
    ipCeiling: 2000,                    // early per-IP flood guard (default max(2000, 20 × max)); false drops it
  },
});
```

Default key (no `keyGenerator`, no `plan`): the signed-in user's id when the scope has one, else the client IP (IPv6 grouped by /64). It runs at `preHandler`, after auth, so one office Wi-Fi or carrier NAT never throttles colleagues together, while sign-in, sign-up and reset (no user yet) stay limited per IP. An `allowList` of addresses also matches signed-in callers from those addresses. The `ipCeiling` counts every request per IP at `onRequest` (before auth, unmatched routes included) on the same store; routes with `config: { rateLimit: false }` skip it.

Pick another key with `createTenantKeyGenerator` (`@classytic/arc/scope`); arc moves it to `preHandler` too:

```typescript
import { createTenantKeyGenerator } from '@classytic/arc/scope';

rateLimit: { max: 1000, keyGenerator: createTenantKeyGenerator({ strategy: 'organization' }) }   // one quota per org
rateLimit: { max: 100, keyGenerator: (req) => req.ip }                                         // per IP, as before 2.53
```

| `strategy` | Key |
|---|---|
| `'user'` (createApp default) | `user:<userId>`, else IP |
| `'organization'` (when omitted) | `member`/`service`: `organizationId`; `authenticated`: `userId`; `elevated`: `organizationId ?? userId`; `public`: IP |
| `(ctx) => string` | yours (`ctx.ip`, `ctx.scope`) |

A host `keyGenerator` or `plan` gets no `ipCeiling`. Per-resource budgets: `defineResource({ rateLimit })`.

Shared store down (`redis`/`store`): every call is bounded (`storeFallback.timeoutMs`, 250) and an error or timeout is answered from per-instance memory counters (still limited, never hangs or 500s); one warning per outage, probed every `retryAfterMs` (5000), resumes on its first answer; `storeFallback.onStatus` reports each switch for a health/metrics signal. `storeFallback: false` = the plugin's own behaviour.

A route's raw `config: { rateLimit: { max, timeWindow, keyGenerator, groupId, allowList } }` runs on arc's resource limiter (same headers, same 429 `arc.rate_limited`). `keyGenerator(req)` replaces the scope/IP key (per device behind one NAT address); `allowList` (keys or `(req, key) => boolean`) skips the limit; `groupId` shares one budget across routes and resources (one group, one `max`/`timeWindow`). Any other option refuses to register.

## Bulk preset

```typescript
import { bulkPreset } from '@classytic/arc/presets';

defineResource({ name: 'product', adapter, presets: ['bulk'] });                         // all three
defineResource({ name: 'product', adapter, presets: [bulkPreset({ operations: ['createMany', 'updateMany'], maxCreateItems: 500 })] });
```

| Route | Body | Repository method |
|---|---|---|
| `POST /bulk` | `{ items }` (max `maxCreateItems`, default 1000) | `createMany` |
| `PATCH /bulk` | `{ filter, data }` | `updateMany` |
| `DELETE /bulk` | `{ filter }` | `deleteMany` |

The repository must provide those methods; permissions inherit from `create`, `update`, `delete`.

## OpenAPI

`buildOpenApiSpec` and `openApiPlugin` (default prefix `/_docs`) come from `@classytic/arc/docs`. Non-resource routes (auth adapters) inject paths with `ExternalOpenApiPaths`:

```typescript
import type { ExternalOpenApiPaths } from '@classytic/arc/docs';

const ext: ExternalOpenApiPaths = {
  paths: { '/api/auth/sign-in': { post: { summary: 'Sign in' } } },
  schemas: {}, tags: [{ name: 'Authentication' }],
  securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session_token' } },
  resourceSecurity: [{ apiKeyAuth: [], orgHeader: [] }],   // "bearer OR (api-key AND org-header)"
};
```

`resourceSecurity` items are OR'd with `bearerAuth`; keys inside one item are AND'd. Core schemes: `bearerAuth`, `orgHeader`. The Better Auth adapter (`extractBetterAuthOpenApi`, `@classytic/arc/auth`) supplies `cookieAuth`, and `apiKeyAuth` plus `resourceSecurity` when Better Auth's API-key plugin is present.
