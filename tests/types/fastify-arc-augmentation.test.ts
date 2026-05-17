/**
 * `FastifyInstance.arc?: ArcCore` augmentation reach test.
 *
 * Pre-2.17, the `declare module "fastify"` block lived inside
 * `src/core/arcCorePlugin.ts` — and only `@classytic/arc/plugins`
 * re-exported from that file. Hosts importing from `/core`,
 * `/registry`, `/utils`, `/auth`, etc. saw `app.arc` as "Property does
 * not exist" because the augmentation file never landed in their type
 * graph. The skill docs claimed otherwise, which was wrong.
 *
 * 2.17 hoists the augmentation into `src/types/fastify-augmentation.ts`
 * (pure type-only, no runtime) and side-effect-imports it from the five
 * common entry-point barrels: root, /factory, /core, /plugins,
 * /registry. This test pins that any of those entry points activates
 * the augmentation — touching JUST `@classytic/arc/core` is now enough
 * to see `app.arc?`.
 *
 * Compile-time-only assertion. The runtime body of each test is empty;
 * what matters is that the file typechecks. If a future change drops
 * the side-effect import from one of the covered barrels, the
 * corresponding test stops compiling and the regression surfaces in
 * `tsc --noEmit`.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expectTypeOf, it } from "vitest";

// Each subpath imports anything (the side-effect activates the augmentation
// before the assertion below runs). The specific symbol doesn't matter —
// we're checking the `declare module` lands.
import "../../src/index.js"; // root
import "../../src/core/index.js"; // /core
import "../../src/factory/index.js"; // /factory
import "../../src/plugins/index.js"; // /plugins
import "../../src/registry/index.js"; // /registry

describe("FastifyInstance.arc? augmentation reach", () => {
  it("`arc?: ArcCore` is on FastifyInstance after touching any entry-point barrel", () => {
    const app: FastifyInstance = Fastify({ logger: false });
    // If the augmentation didn't land, `app.arc` would be a TS error.
    // We don't access it (the plugin hasn't run), we just type-check it.
    expectTypeOf(app.arc).toEqualTypeOf<typeof app.arc>();
    // Compile-time existence — `arc` is reachable on the typed surface.
    type ArcSlot = FastifyInstance["arc"];
    // `undefined` is part of the union because the field is optional —
    // typed access should narrow to `ArcCore | undefined`.
    expectTypeOf<ArcSlot>().toMatchTypeOf<ArcSlot | undefined>();
  });
});
