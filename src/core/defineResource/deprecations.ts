/**
 * Phase 0 side channel — warn (once per process) about deprecated config
 * spellings. Reads the CALLER's config, never the normalised copy: Phase 0
 * itself produces `disabledRoutes` / `disableDefaultRoutes` from `crud` and
 * `customRoutesOnly`, so arc never triggers a warning here. Routes a preset adds
 * are checked where presets merge (`warnDeprecatedPresetRoutes` in `presets/`).
 */

import { warnDeprecated } from "../../logger/deprecation.js";
import type { ResourceConfig } from "../../types/index.js";

const FUNCTION_HANDLER_FIX =
  "Use a function `handler: (ctx) => controller.method(ctx)` (arc pipeline + MCP tool); " +
  "`rawHandler` takes a function for streams, raw-body webhooks, files and redirects.";

export function warnDeprecatedConfig<TDoc>(config: ResourceConfig<TDoc>): void {
  const name = config.name;
  if (config.disableDefaultRoutes !== undefined) {
    warnDeprecated(
      "`disableDefaultRoutes`",
      `Use \`crud: false\` (first seen on resource '${name}').`,
    );
  }
  if (config.disabledRoutes !== undefined) {
    warnDeprecated(
      "`disabledRoutes`",
      "Use the `crud` allow-list: `disabledRoutes: ['delete']` becomes " +
        `\`crud: { list: true, get: true, create: true, update: true }\` (first seen on resource '${name}').`,
    );
  }
  for (const route of config.routes ?? []) {
    const where = `(first seen on ${route.method} ${route.path} of resource '${name}')`;
    if (typeof route.handler === "string") {
      warnDeprecated("A string route `handler`", `${FUNCTION_HANDLER_FIX} ${where}`);
    }
    if (route.controllerMethod !== undefined) {
      warnDeprecated("Route `controllerMethod`", `${FUNCTION_HANDLER_FIX} ${where}`);
    }
    if (typeof route.rawHandler === "string") {
      warnDeprecated(
        "A string route `rawHandler`",
        "Pass the function: `rawHandler: (request, reply) => controller.method(request, reply)`. " +
          where,
      );
    }
  }
}
