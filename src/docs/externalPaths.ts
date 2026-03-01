/**
 * External OpenAPI Path Provider
 *
 * Generic interface for injecting non-resource paths into the OpenAPI spec.
 * Used by auth adapters (Better Auth, custom auth), third-party integrations,
 * or any system that registers routes outside Arc's resource registry.
 *
 * @example
 * ```typescript
 * import type { ExternalOpenApiPaths } from '@classytic/arc/docs';
 *
 * const authPaths: ExternalOpenApiPaths = {
 *   paths: {
 *     '/api/auth/sign-in': {
 *       post: { summary: 'Sign in', requestBody: { ... } },
 *     },
 *   },
 *   securitySchemes: {
 *     cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session_token' },
 *   },
 *   tags: [{ name: 'Authentication' }],
 * };
 * ```
 */

/** Pre-built OpenAPI path fragments ready to merge into a spec */
export interface ExternalOpenApiPaths {
  /** OpenAPI path items keyed by path (e.g. '/api/auth/sign-in') */
  paths: Record<string, Record<string, unknown>>;
  /** Additional component schemas to merge into components.schemas */
  schemas?: Record<string, Record<string, unknown>>;
  /** Additional security scheme definitions to merge into components.securitySchemes */
  securitySchemes?: Record<string, Record<string, unknown>>;
  /** Additional tags for grouping operations */
  tags?: Array<{ name: string; description?: string }>;
  /**
   * Additional security alternatives for Arc resource paths.
   * Each item is OR'd with bearerAuth. Keys within the same object are AND'd.
   *
   * @example
   * // "bearer OR (api-key AND org-header)"
   * resourceSecurity: [{ apiKeyAuth: [], orgHeader: [] }]
   */
  resourceSecurity?: Array<Record<string, string[]>>;
}
