import { arcLog } from "./index.js";

/**
 * One warning per deprecated spelling per process. Keyed by the spelling, not
 * the call site: a host with 80 string handlers needs one line naming the
 * replacement, not 80. Goes through `arcLog`, so `ARC_SUPPRESS_WARNINGS` and
 * the app's pino writer apply.
 */
const warned = new Set<string>();

export function warnDeprecated(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  arcLog("deprecated").warn(
    `${key} is deprecated and will be removed in the next minor. ${message}`,
  );
}

/**
 * Wrap a namespace object so reading one of ITS members warns once. Probes for
 * members it does not have (`then`, symbols) stay silent, so awaiting or
 * tagging the object never emits a false warning.
 */
export function deprecatedNamespace<T extends object>(target: T, key: string, message: string): T {
  return new Proxy(target, {
    get(t, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(t, property)) {
        warnDeprecated(key, message);
      }
      return Reflect.get(t, property, receiver);
    },
  });
}

/** Tests only: forget which keys already warned. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}
