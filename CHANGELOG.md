# Changelog

Release history index for `@classytic/arc`.

Detailed release notes now live under [changelog/](changelog/). This root file stays small and provides stable entry points for docs and references.

## v2

See [changelog/v2.md](changelog/v2.md) for the full v2 release history.

## 2.20

- [2.20.0](changelog/v2.md#2200) — domain **modules** (`defineModule` / `ArcModule<TExports>` / typed `getModuleExports`, thunk-of-dynamic-import lazy packs, **`dependsOn` stable topological composition order** with fail-fast cycle/missing/self/duplicate detection via `orderModules`, augmentable `ArcModuleRegistry` for cast-free `getModuleExports`), security-defaults wave (`readOnly()` write-deny, `crud-public-by-omission` diagnostic, MCP session-hijack + MCP aggregation tenant-scope fixes), approval/involvement presets extracted to `@classytic/arc-approval` / `@classytic/arc-involvement` pre-publish (subpaths never shipped), zod made truly optional for `actions:`, `check:peer-skew` release gate, un-driftable `arc init` pins, `./sync` subpath, peer floors primitives `>=0.9.0` / repo-core `>=0.7.0`.

## 2.19

- [2.19.0](changelog/v2.md#2190) — Application-Layer Encryption subpath (`/encryption`: JWE via lazy `jose`, field-level AES-256-GCM via `node:crypto`, `KeyProvider` + `kid` rotation), typed `ResourceExtensions` plugin hatch, better-auth `clone()` fix.

## 2.18

- [2.18.5](changelog/v2.md#2185) — adopt mongokit 3.16.1 PATCH-safety fix (update-body default stripping; e2e regression proving no PATCH default-injection) + production-grade `arc init` scaffold (typed Zod env, health/onClose, biome+CI).
- [2.18.4](changelog/v2.md#2184) — SSE lazy-auth fix.
- [2.18.3](changelog/v2.md#2183) — ecosystem sync (repo-core 0.6 / mongokit 3.16 / sqlitekit 0.6), `traceId` repo-option forwarding, BullMQ repeatable-schedule reconciliation, jittered Streams backoff + batch-scaled recovery, `configure()` rebuild state-loss fix, multi-node diagnostic-map leak fixes, internal refactor sweep (middlewares/crud/normalize splits), `prepublishOnly` runs `test:ci`.
- [2.18.2](changelog/v2.md#2182) — fix streamline DELETE route 500 (`Cannot read properties of undefined`) caused by unbound `delete`/`getById` repo method calls.
- [2.18.1](changelog/v2.md#2181) — remove phantom `disableCrud` type stub, `runtime: 'distributed'` error now names exact `stores.<key>` + fix hint, `TERMINAL_RUN_STATUSES` exported from `@classytic/arc/integrations/streamline`.
- [2.18.0](changelog/v2.md#2180) — durable WebSocket envelope + ack/replay (pushRef-registry, send-queue, dead-queue, outbound-truncate, safe-async), new `RedisPushRefStore` subpath for cross-instance pushRef state, H3-based **geo-room** spatial subscription manager (`h3-js` peer), `runInTransaction()` AsyncLocalStorage Unit-of-Work hook so kit adapters can thread DB sessions without per-function plumbing, **MCP realtime tool bridge** dispatching LiveKit/Gemini/OpenAI `LiveServerToolCall` frames through the existing MCP tool registry, request-id trace-context propagation, additional outbox provider tests. **Cleanup:** removed the phantom `disableCrud` flag from `defineResource` — it shipped in the type but was never read by the router, so it silently no-opped; `disableDefaultRoutes` (or `crud: false`) is the canonical kill-switch. **DX:** `runtime: 'distributed'` validation error now names the exact `stores.<key>` to set plus a per-key fix hint, instead of only listing what's absent.

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
