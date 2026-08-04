/**
 * `@classytic/arc/outbox-admin` — the operator surface over the transactional
 * outbox: health, dead-letter triage, replay.
 *
 * Separate from `@classytic/arc/events` on purpose, and the split is not
 * cosmetic. `createOutboxModule` is a DEPENDENCY SLOT — it publishes a store
 * other modules read, and lives at the events layer with them. This is a ROUTE
 * SURFACE: it assembles a resource (L3) and reads the module registry (L5), so
 * it is a composition root and belongs at L5 beside `cleanup`. Left in
 * `events/` it created a factory → events → factory import cycle that arc's
 * boundary gate rejects, and rightly.
 *
 * Compose the two together — the admin module declares a hard `dependsOn` edge
 * on the outbox module, so arc refuses a deployment that mounts the surface
 * without the store behind it.
 */

export type {
  OutboxAdminModuleDeps,
  OutboxAdminPermissions,
  OutboxAdminStore,
} from "./module.js";
export { createOutboxAdminModule } from "./module.js";
