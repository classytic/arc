/**
 * `@classytic/arc/auth/social`: social sign-in for Better Auth by configuration.
 * `defineSocialProviders` builds `socialProviders` from env; `socialAuth()` serves the provider
 * list and the OAuth bearer handoff under the auth catch-all. Requires `better-auth`.
 */

export type { SocialAuthOptions } from "./plugin.js";
export { socialAuth } from "./plugin.js";
export type {
  DefinedSocialProviders,
  DefineSocialProvidersOptions,
  SocialProviderId,
  SocialProviderInfo,
} from "./providers.js";
export { defineSocialProviders } from "./providers.js";
