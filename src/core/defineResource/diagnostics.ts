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
 * One diagnostic produced during resource validation.
 *
 * - `severity`: `error` is FATAL — `defineResource()` throws at define-time,
 *   the resource never boots (used by strict security invariants like ungated
 *   CRUD under `strictPermissions`). `warn` flags a misconfiguration the host
 *   should clean up; `info` is a deprecation hint. `warn`/`info` are non-fatal
 *   and flushed through the host logger on first mount.
 * - `code`: stable identifier for the diagnostic — hosts and tests can match
 *   on this without parsing the human-readable message.
 * - `message`: pre-formatted line, resource name already interpolated.
 */
export interface ResourceDiagnostic {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
}
