/** `@classytic/arc/http-cache/testing`: a CDN simulator and assertions for an app's cache policies. */
export { expectCacheable, expectHit, expectPrivate, expectPurged } from "./assertions.js";
export {
  type CacheStatus,
  type CdnRequest,
  type CdnResponse,
  createFakeCdn,
  edgeFreshness,
  type FakeCdn,
  type FakeCdnOptions,
} from "./fake-cdn.js";
