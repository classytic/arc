/**
 * `@classytic/arc/http-cache`: declare caching once (route `config.httpCache`, `defineResource({ httpCache })`
 * or path rules); one plugin emits the headers for every tier and turns writes into tag invalidations.
 * Vendor purgers: `@classytic/arc/http-cache/cloudflare`, `/fastly`. Test harness: `/testing`.
 */
export {
  type HttpCacheDecorator,
  type HttpCacheOptions,
  httpCachePlugin,
} from "./enforce/http-cache.plugin.js";
export type { InvalidationBatch, InvalidationDelivery } from "./invalidation/delivery.js";
export { batchedDelivery } from "./invalidation/delivery.js";
export {
  type DurableDeliveryOptions,
  durableDelivery,
  INVALIDATE_EVENT,
} from "./invalidation/durable.js";
export { type PurgeOn, tagsForCrudEvent } from "./invalidation/sources.js";
export type { HttpCacheObserver, HttpCacheStats, PurgeEvent, ReasonKind } from "./observability.js";
export {
  type CanonicalQueryOptions,
  canonicalUrl,
  DEFAULT_IGNORED_QUERY,
} from "./policy/cache-key.js";
export {
  type CacheHeaders,
  type DirectiveOptions,
  privateHeaders,
  publicHeaders,
} from "./policy/directives.js";
export type {
  DocumentTags,
  HttpCachePolicy,
  HttpCacheRule,
  NonCacheableReason,
  PrivacyDecision,
  PrivacyReason,
  ResourceHttpCacheConfig,
  RouteHttpCacheConfig,
  TagSpec,
} from "./policy/policy.types.js";
export { classifyPrivacy, DEFAULT_PRIVATE_HEADERS, type PrivacyOptions } from "./policy/privacy.js";
export { normalizeTags, resourceTags } from "./policy/tags.js";
export { composePurgers, createMemoryPurger, noopPurger } from "./purgers/basic.js";
export {
  CachePurgeError,
  type CachePurger,
  type PurgeMode,
  type PurgerCapabilities,
} from "./purgers/purger.types.js";
