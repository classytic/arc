# Changelog

Release **index** for `@classytic/arc` — one line per minor, newest first. Full notes and migration steps live in [changelog/v2.md](changelog/v2.md); this file only routes you there, so it stays small enough to read in full.

⚠ = breaking. Detail belongs in the linked section, never here.

| Version | Headline |
|---|---|
| [2.34](changelog/v2.md#2340) | **Write verbs** — bind a CRUD slot to a domain command, pipeline intact; reachability is boot-fatal. Outbox published NOTHING through its default transport (fail-open facade → raw `EventTransport`); `onHandlerError:'throw'`; single-node topology declarable; relay id per instance. |
| [2.33](changelog/v2.md#2330) | ⚠ `NODE_ENV=prod` disclosed stack traces + raw 500 messages and dropped `Secure` cookies. Silent input drop closed on two paths (`strictFilterFields`, `onImmutableWrite`, both opt-in). |
| [2.32](changelog/v2.md#2320) | Module disposers (`defer`), `extendModule`, `buildPermissionMatrix`, outbox-admin at L5. |
| [2.31](changelog/v2.md#2310) | ⚠ `RouteDefinition.raw` removed — `handler` vs `rawHandler` (a leftover flag is boot-fatal). ⚠ Jobs management surface off by default + `requirePlatformRole()`. Zod converts by direction. Static assets. Deprecated aliases removed. |
| [2.30](changelog/v2.md#2300) | ⚠ Authorization standardization — decision-only `PermissionCheck`, one PDP + one PEP, AND-composed policy filters, fail-closed `ownedByUser`. |
| [2.28](changelog/v2.md#2280) | `OutboxStore` conformance suite at `@classytic/arc/testing/outbox`; `repositoryAsOutboxStore`. |
| [2.27](changelog/v2.md#2270) | `@classytic/arc/cleanup` stable + its conformance suite. ⚠ primitives floor >=0.15.0. |
| [2.26](changelog/v2.md#2260) | Data Cleanup Center framework; `purgeResource` `requireChunked` gate. |
| [2.25](changelog/v2.md#2250) | `scopeFirstCtx`. ⚠ `/schemas` moved to TypeBox 1.0. |
| [2.24](changelog/v2.md#2240) | Self-describing modules (health/events/workflows/schedules arms); performance wave. ⚠ outbox contract moved to `@classytic/primitives/outbox`. |
| [2.20](changelog/v2.md#2200) | Domain **modules** (`defineModule`, `dependsOn` topological order); security-defaults wave; `check:peer-skew`. |
| [2.19](changelog/v2.md#2190) | Application-layer encryption (`/encryption`); typed `ResourceExtensions`. |
| [2.18](changelog/v2.md#2180) | Durable WebSocket envelope + ack/replay; geo-rooms; `runInTransaction()`; MCP realtime bridge. |
| [2.17](changelog/v2.md#2170) | Security + host-DX wave: `secure-json-parse` on untrusted boundaries, MCP collision detection, pagination-cap envelope, `referenceData`. |
| [2.16](changelog/v2.md#2160) | Breaking-changes minor: `/org` removed, validation hardened, kit floors bumped. |
| [2.15](changelog/v2.md#2153) · [2.14](changelog/v2.md#2143) · [2.13](changelog/v2.md#213) · [2.12](changelog/v2.md#212) | 2.12 = the adapter split (kit adapters moved to their kits). |
| [2.11](changelog/v2.md#211) · [2.10](changelog/v2.md#210) · [2.9](changelog/v2.md#293) · [2.8](changelog/v2.md#280) | |
| [2.7.x](changelog/v2.md#27x) · [2.6.x](changelog/v2.md#26x) · [2.5.5](changelog/v2.md#255) · [2.4.x](changelog/v2.md#24x) | |
