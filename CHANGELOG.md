# Changelog

Release **index** for `@classytic/arc` — one line per minor, newest first. Full notes and migration steps live in [changelog/v2.md](changelog/v2.md); this file only routes you there, so it stays small enough to read in full.

⚠ = breaking. Detail belongs in the linked section, never here.

| Version | Headline |
|---|---|
| [2.38](changelog/v2.md#2380) | `MemoryEventTransport` `handlerDispatch: 'parallel'` — one event's handlers run concurrently instead of queued, capped by `handlerConcurrency`. Default stays `'sequential'`; opting in needs an ordering audit. |
| [2.37](changelog/v2.md#2370) | `schedulesPlugin` `drainTimeoutMs` bounds shutdown drain (5 s). Perf tests ported to Node 24's GC. [2.37.1](changelog/v2.md#2371): ⚠ `hidden: true` fields were returned when the client sent no `select`. Better Auth team scope is active-org-safe on both auth paths; ⚠ `better-auth` floor `>=1.7.0`. |
| [2.36](changelog/v2.md#2360) | ⚠ `defineEvent` validation rejected UNION (every nullable field) and `integer` types. ⚠ `denyAll()` introspected as "any authenticated user". Boot preflight names every missing plugin package at once; `resolveHeaders` gives per-subscription webhook auth. |
| [2.35](changelog/v2.md#2350) | `hooks.after(resource, 'list' \| 'read', fn)` was a silent no-op. ⚠ `trustProxy` no longer accepts a hop COUNT. Dependency alignment for fastify 5.12.1 + better-auth 1.7.1. |
| [2.34](changelog/v2.md#2340) | `nativePolicyFilter()` — branded escape hatch for adapter-native policy the filter IR can't express; client-sent `_policyFilters` stripped before the parser. ⚠ Outbox relay `onError` defaults to a structured error log instead of silence. |
| [2.33](changelog/v2.md#2330) | **Write verbs** + **transactional write envelope** (`transactional: true`). Outbox published NOTHING through its default transport. ⚠ repo-core >=0.24.0, primitives >=0.23.0. ⚠ `NODE_ENV=prod` leaked stack traces, dropped `Secure` cookies. |
| [2.32](changelog/v2.md#2320) | Module disposers (`defer`), `extendModule`, `buildPermissionMatrix`, outbox-admin at L5. |
| [2.31](changelog/v2.md#2310) | ⚠ `RouteDefinition.raw` removed — `handler` vs `rawHandler`; a leftover flag is boot-fatal. ⚠ Jobs surface off by default + `requirePlatformRole()`. Zod converts by direction; static assets. |
| [2.30](changelog/v2.md#2300) | ⚠ Authorization standardization — decision-only `PermissionCheck`, one PDP + one PEP, AND-composed policy filters, fail-closed `ownedByUser`. |
| [2.28](changelog/v2.md#2280) · [2.27](changelog/v2.md#2270) · [2.26](changelog/v2.md#2260) | `OutboxStore` + `/cleanup` conformance suites; `repositoryAsOutboxStore`; Data Cleanup Center + `requireChunked`. ⚠ primitives floor >=0.15.0. |
| [2.25](changelog/v2.md#2250) | `scopeFirstCtx`. ⚠ `/schemas` moved to TypeBox 1.0. |
| [2.24](changelog/v2.md#2240) | Self-describing modules (health/events/workflows/schedules arms); performance wave. ⚠ outbox contract moved to `@classytic/primitives/outbox`. |
| [2.20](changelog/v2.md#2200) | Domain **modules** (`defineModule`, `dependsOn` topological order); security-defaults wave; `check:peer-skew`. |
| [2.19](changelog/v2.md#2190) · [2.18](changelog/v2.md#2180) | Application-layer `/encryption`; typed `ResourceExtensions`. Durable WebSocket envelope + ack/replay; `runInTransaction()`. |
| [2.17](changelog/v2.md#2170) | Security + host-DX wave: `secure-json-parse` on untrusted boundaries, MCP collision detection, `referenceData`. |
| [2.16](changelog/v2.md#2160) | Breaking-changes minor: `/org` removed, validation hardened, kit floors bumped. |
| [2.15](changelog/v2.md#2153) · [2.14](changelog/v2.md#2143) · [2.13](changelog/v2.md#213) · [2.12](changelog/v2.md#212) | 2.12 = the adapter split (kit adapters moved to their kits). |
| [2.11](changelog/v2.md#211) · [2.10](changelog/v2.md#210) · [2.9](changelog/v2.md#293) · [2.8](changelog/v2.md#280) | |
| [2.7.x](changelog/v2.md#27x) · [2.6.x](changelog/v2.md#26x) · [2.5.5](changelog/v2.md#255) · [2.4.x](changelog/v2.md#24x) | |
