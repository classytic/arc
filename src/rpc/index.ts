/**
 * RPC Module — Resource-Oriented Service Client
 *
 * HTTP client for calling remote Arc services.
 * Speaks Arc's resource protocol with circuit breaking,
 * retry, correlationId propagation, and lifecycle hooks.
 *
 * @example
 * ```typescript
 * import { createServiceClient } from '@classytic/arc/rpc';
 *
 * const catalog = createServiceClient({
 *   baseUrl: 'http://catalog-service:3000',
 *   token: () => getServiceToken(),
 *   correlationId: () => request.id,
 *   schemaVersion: '1.0.0',
 *   retry: { maxRetries: 2, backoffMs: 200 },
 * });
 *
 * const products = await catalog.resource('product').list();
 * ```
 */

export type {
  RequestInfo,
  ResourceClient,
  ResponseInfo,
  RetryConfig,
  ServiceClient,
  ServiceClientOptions,
  ServiceResponse,
} from "./serviceClient.js";
export { createServiceClient } from "./serviceClient.js";
