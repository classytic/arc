/**
 * Module augmentation — `FastifyInstance.arc?: ArcCore`.
 *
 * Hoisted out of `src/core/arcCorePlugin.ts` so hosts that don't import
 * from `@classytic/arc/plugins` still see `app.arc` on their typed
 * Fastify instance. Activated via a side-effect `import` from every
 * common arc entry-point barrel — root (`src/index.ts`), `/factory`,
 * `/core`, `/plugins`, `/registry`. The TS compiler treats `declare
 * module` as global once any file in the program touches this one, so
 * a host that imports from any of those subpaths sees `fastify.arc?`
 * everywhere — including encapsulation contexts they didn't explicitly
 * thread types through.
 *
 * Pure type-only file: no runtime code, no exports. The `import type`
 * for `ArcCore` is erased at build; tsdown emits nothing executable.
 *
 * **Why optional (`arc?:`)** — same reasoning as the previous home in
 * `arcCorePlugin.ts`:
 *   1. The augmentation lands on every `FastifyInstance` a consumer
 *      sees, including apps that never register `arcCorePlugin`. A
 *      non-optional declaration would force those apps to assert or
 *      guard every property access.
 *   2. Hosts that extend `FastifyInstance` to narrow `arc` to a richer
 *      shape (`interface MyApp extends FastifyInstance { arc?: MyArc }`)
 *      can re-declare with a compatible subtype without fighting TS.
 *
 * Inside arc's own code, any call site that runs *after* `arcCorePlugin`
 * has registered treats `fastify.arc` as non-null (see `registerAuth.ts`
 * and `createApp.ts` which assert with `fastify.arc!` or narrow
 * explicitly).
 */

import type { ArcCore } from "../core/arcCorePlugin.js";

declare module "fastify" {
  interface FastifyInstance {
    arc?: ArcCore;
  }
}
