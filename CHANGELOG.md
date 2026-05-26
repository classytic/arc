# Changelog

Release history index for `@classytic/arc`.

Detailed release notes now live under [changelog/](changelog/). This root file stays small and provides stable entry points for docs and references.

## v2

See [changelog/v2.md](changelog/v2.md) for the full v2 release history.

## 2.18

- [2.18.0](changelog/v2.md#2180) — durable WebSocket envelope + ack/replay (pushRef-registry, send-queue, dead-queue, outbound-truncate, safe-async), new `RedisPushRefStore` subpath for cross-instance pushRef state, H3-based **geo-room** spatial subscription manager (`h3-js` peer), `runInTransaction()` AsyncLocalStorage Unit-of-Work hook so kit adapters can thread DB sessions without per-function plumbing, **MCP realtime tool bridge** dispatching LiveKit/Gemini/OpenAI `LiveServerToolCall` frames through the existing MCP tool registry, request-id trace-context propagation, additional outbox provider tests.

## 2.17

- [2.17.0](changelog/v2.md#2170) — stabilization + security + arc-ai host-DX + pagination-cap envelope + reference-data shorthand. `secure-json-parse` on every untrusted JSON boundary (Redis sessions, Redis pub/sub + Streams, WebSocket frames, multipart text fields), idempotency fingerprint depth-cap against deep-nesting DoS, MCP `evaluatePermission` scope threading + exported `buildScope`, four new first-mount diagnostics for silent-drop misconfigs (`cache.invalidateOn` without `queryCachePlugin`, `audit: true` without `auditPlugin`, `events: {...}` without `eventPlugin`, `mcpPlugin` with `auth: false`), `FST_ERR_DUPLICATED_ROUTE` rewrap with `disabledRoutes` hint, auto field-write permissions on custom routes with `RouteDefinition.fieldWrite` opt-out, `GET /jobs/:id/status` + `JobDefinition.maxConcurrent` semaphore, `defineResource` overload that narrows `actions` to the captured literal shape, public `ResourceDefinition.warnings` getter for CI gating, **`pipeUIMessageStreamToReply()` + `UI_MESSAGE_STREAM_HEADERS`** (one-line AI SDK stream pipe — `streamResponse: true` now auto-pipes returned `ReadableStream`s instead of crashing with `chunk must be a string or Buffer`), **MCP tool-name collision detection** with source attribution + auto-namespace for preset-vs-user clashes (no more opaque `Tool already registered` from inside the MCP SDK), **`createMcpAuthFromBetterAuthApiKey()`** factory wrapping the `verifyApiKey` + metadata-org-scope dance every host kept reimplementing, **`customRoutesOnly: true`** shorthand on `defineResource` (replaces the `disableDefaultRoutes` + `skipValidation` + `skipRegistry` lockstep), **pagination-cap envelope** (a `?limit=200` violation against a `maxLimit=100` resource now responds 400 with a cap-aware top-level message AND machine-readable `meta.cap` + `meta.field` so callers can self-correct without scraping the message; per-detail `meta.bound` carries the AJV threshold for any `minimum`/`maximum` violation and `meta.allowedValues` for `enum`), **`referenceData: true` shorthand + resource-level `defaultLimit`/`maxLimit`** on `defineResource` (one flag for "fetch all, cache aggressively, no pagination UI" — expands to read-only `crud`, `defaultLimit/maxLimit: 1000`, `cache: { staleTime: 300, gcTime: 600 }`; the narrower `defaultLimit` / `maxLimit` knobs flow directly into the listQuery schema so a custom queryParser is no longer required just to set caps).

## 2.16

- [2.16.1](changelog/v2.md#2161) — DX patch: boot-time CRUD/custom-route collision detection, auto-envelope of bare handler returns, full `TenantPurgeStrategy` (with `reason` / `fields` / handler) exposed on audit surfaces, `preloadResources` discoverable from `/factory`, `FastifyInstance.arc?` augmentation reaches every entry-point barrel.
- [2.16.0](changelog/v2.md#2160) — breaking-changes minor: removed dead `/org` subpath, hardened validation pipeline, fixed streamline + queryParser + MCP DX traps, bumped kit peer floors.

## 2.15

See [changelog/v2.md#2153](changelog/v2.md#2153).

## 2.14

See [changelog/v2.md#2143](changelog/v2.md#2143).

## 2.13

See [changelog/v2.md#213](changelog/v2.md#213).

## 2.12

See [changelog/v2.md#212](changelog/v2.md#212).

## 2.11

See [changelog/v2.md#211](changelog/v2.md#211).

## 2.10

See [changelog/v2.md#210](changelog/v2.md#210).

## 2.9

See [changelog/v2.md#293](changelog/v2.md#293) and [changelog/v2.md#291](changelog/v2.md#291).

## 2.8

See [changelog/v2.md#285](changelog/v2.md#285), [changelog/v2.md#284](changelog/v2.md#284), [changelog/v2.md#283](changelog/v2.md#283), [changelog/v2.md#282](changelog/v2.md#282), and [changelog/v2.md#280](changelog/v2.md#280).

## 2.7.x

See [changelog/v2.md#27x](changelog/v2.md#27x).

## 2.6.x

See [changelog/v2.md#26x](changelog/v2.md#26x).

## 2.5.5

See [changelog/v2.md#255](changelog/v2.md#255).

## 2.4.x

See [changelog/v2.md#24x](changelog/v2.md#24x).
