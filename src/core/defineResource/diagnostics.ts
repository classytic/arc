/**
 * Boot-time diagnostics produced by the `defineResource()` validation pipeline.
 *
 * `defineResource()` runs at module load — long before any Fastify instance
 * exists — so non-fatal warnings (redundant field-rule flags, ambiguous
 * preset combinations, etc.) cannot be emitted through a logger at the
 * point they are detected. Instead we COLLECT them into a structured
 * `ResourceDiagnostic[]`, attach the array to `ResourceDefinition._diagnostics`,
 * and flush each entry through `fastify.log.warn` on first mount inside
 * `buildResourcePlugin`. Hosts thus retain full control over framework
 * output (silencing, redirecting, structured logging) — the framework
 * never reaches for `console.*` directly outside of `src/cli/`.
 *
 * Hard errors continue to `throw` inside the validation pipeline — those
 * surface synchronously at define-time, which is the right UX for
 * "this resource will never work" failures.
 */

/**
 * One non-fatal diagnostic produced during resource validation.
 *
 * - `severity`: log level the host logger uses (`warn` for misconfigurations
 *   the host should clean up, `info` for deprecation hints).
 * - `code`: stable identifier for the diagnostic — hosts and tests can match
 *   on this without parsing the human-readable message.
 * - `message`: pre-formatted line, resource name already interpolated.
 */
export interface ResourceDiagnostic {
  severity: "warn" | "info";
  code: string;
  message: string;
}
