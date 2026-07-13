/**
 * Compile-time contracts against the BUILT dist — checked by `tsc --noEmit`
 * in this fixture's `npm test`, never executed.
 *
 * Guards the `ResourceExtensions` extension model across d.ts bundling:
 * arc's declarations are bundled, and a regression there (e.g. a module
 * augmentation surviving as an unresolvable relative specifier) is invisible
 * to arc's own typecheck — it only breaks consumers. This file IS that
 * consumer.
 */

import '@classytic/arc/encryption';
import type { ResourceExtensions } from '@classytic/arc/types';

// First-party slice: `encryption` is declared inline on ResourceExtensions
// (type-only) and must be visible to hosts of the built package.
export const encryptionSlice: ResourceExtensions = {
  encryption: { mode: 'fields', fields: ['cardNumber', 'cvv'] },
};

// External-plugin pattern from the ResourceExtensions docs: augmenting
// `@classytic/arc/types` must merge against the bundled declarations.
declare module '@classytic/arc/types' {
  interface ResourceExtensions {
    consumerSmokePlugin?: { readonly enabled: boolean };
  }
}
export const externalSlice: ResourceExtensions = {
  consumerSmokePlugin: { enabled: true },
};

// Strong contract: unregistered keys stay compile errors (no index
// signature). If this line ever compiles, the typo-guard is gone.
// @ts-expect-error — 'encyrption' is not a registered extension key
export const typoRejected: ResourceExtensions = { encyrption: {} };
