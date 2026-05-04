/**
 * Phase 4 — pick (or auto-create) the resource's controller.
 *
 * Three branches:
 *   1. User-supplied controller → forward `queryParser` (duck-typed)
 *      and warn on dropped resource-level options.
 *   2. No controller, has CRUD routes, has a repository → auto-build
 *      a `BaseController` with every resource-level knob threaded
 *      through (tenantField, schemaOptions, idField, defaultSort,
 *      cache, onFieldWriteDenied, presetFields).
 *   3. Otherwise → `undefined` (custom-routes-only resource).
 *
 * The warns are load-bearing DX: silently dropping `queryParser`,
 * `schemaOptions`, etc. on a custom controller produces 90-minute
 * "why don't my filters work" debugs. Each warn names the resource,
 * lists the dropped options, and points at the canonical fix. All
 * warns honour `ARC_SUPPRESS_WARNINGS=1` via `arcLog()`.
 */

import { arcLog } from "../../logger/index.js";
import type {
  AnyRecord,
  IController,
  QueryParserInterface,
  ResourceConfig,
} from "../../types/index.js";
import { BaseController } from "../BaseController.js";
import type { InternalResourceConfig } from "./config.js";

/**
 * Resolve the controller for the resource. See module docstring for
 * branch semantics.
 */
export function resolveOrAutoCreateController<TDoc extends AnyRecord>(
  resolvedConfig: InternalResourceConfig<TDoc>,
  adapter: ResourceConfig<TDoc>["adapter"],
  repository: unknown,
  hasCrudRoutes: boolean,
): IController<TDoc> | undefined {
  const userController = resolvedConfig.controller;

  if (userController) {
    threadQueryParser(userController, resolvedConfig);
    warnOnDroppedAuthorOptions(resolvedConfig);
    warnOnDroppedPresetOptions(resolvedConfig);
    return userController as unknown as IController<TDoc>;
  }

  if (!hasCrudRoutes || !repository) return undefined;

  return buildBaseController(resolvedConfig, adapter, repository);
}

/**
 * Forward a resource-level `queryParser` into a user-supplied
 * controller via duck-typed `setQueryParser`. Without this the
 * controller's internal default would silently override the
 * resource's parser, drifting `[contains]` / `[like]` semantics
 * away from what the OpenAPI schema advertises.
 */
function threadQueryParser<TDoc extends AnyRecord>(
  controller: unknown,
  resolvedConfig: InternalResourceConfig<TDoc>,
): void {
  if (!resolvedConfig.queryParser) return;
  const ctrl = controller as { setQueryParser?: (qp: QueryParserInterface) => void };
  if (typeof ctrl.setQueryParser === "function") {
    ctrl.setQueryParser(resolvedConfig.queryParser as QueryParserInterface);
    return;
  }
  arcLog("defineResource").warn(
    `Resource "${resolvedConfig.name}" declares a custom \`queryParser\` but its controller ` +
      "does not expose `setQueryParser(qp)`. The parser will NOT be threaded into the " +
      "controller's query resolution — operator filters (`[contains]`, `[like]`, etc.) may " +
      "fall back to the controller's internal default. Extend `BaseController` / " +
      "`BaseCrudController` (both implement `setQueryParser`) OR add the method to your " +
      "custom controller to honor the resource-level parser.",
  );
}

/**
 * Warn when the user supplies their own controller AND declares
 * resource-level options arc only auto-threads on the auto-build
 * path. The user *can* fix this by forwarding through `super(repo,
 * { ... })`, so the warn names the dropped options + the canonical
 * fix.
 */
function warnOnDroppedAuthorOptions<TDoc extends AnyRecord>(
  resolvedConfig: InternalResourceConfig<TDoc>,
): void {
  const dropped: string[] = [];
  if (resolvedConfig.tenantField !== undefined) dropped.push("tenantField");
  if (
    resolvedConfig.schemaOptions !== undefined &&
    Object.keys(resolvedConfig.schemaOptions).length > 0
  ) {
    dropped.push("schemaOptions");
  }
  if (resolvedConfig.idField !== undefined) dropped.push("idField");
  if (resolvedConfig.defaultSort !== undefined) dropped.push("defaultSort");
  if (resolvedConfig.cache !== undefined) dropped.push("cache");
  if (resolvedConfig.onFieldWriteDenied !== undefined) dropped.push("onFieldWriteDenied");

  if (dropped.length === 0) return;

  arcLog("defineResource").warn(
    `Resource "${resolvedConfig.name}" declares a custom controller AND resource-level ` +
      `option(s) [${dropped.join(", ")}]. Arc only threads these when it auto-builds ` +
      `the controller — when you pass your own, they are dropped silently and the ` +
      `controller falls back to its own defaults (e.g. tenantField → 'organizationId'). ` +
      `Forward them to your controller's \`super(repo, { ... })\` call. ` +
      `Same root cause as the \`queryParser\` warn above.`,
  );
}

/**
 * Warn when a preset injected `_controllerOptions` (slugLookup,
 * softDelete, parent presets) but the user supplied their own
 * controller. The user did NOT declare these — "forward them" is
 * bad advice. The fix is either drop the preset or extend
 * `BaseController` so the auto-build path runs.
 */
function warnOnDroppedPresetOptions<TDoc extends AnyRecord>(
  resolvedConfig: InternalResourceConfig<TDoc>,
): void {
  if (resolvedConfig._controllerOptions === undefined) return;

  const presetFields: string[] = [];
  if (resolvedConfig._controllerOptions.slugField) presetFields.push("slugField");
  if (resolvedConfig._controllerOptions.parentField) presetFields.push("parentField");

  arcLog("defineResource").warn(
    `Resource "${resolvedConfig.name}" applies a preset that injects controller field(s) ` +
      `[${presetFields.join(", ") || "preset metadata"}] (e.g. slugLookup / softDelete / parent), ` +
      `but the resource also declares a custom controller. Preset metadata only reaches ` +
      `arc's auto-built BaseController — your custom controller will not see ` +
      `\`slugField\`/\`parentField\`/etc. Either (a) drop the preset on this resource ` +
      `(\`presets: [...]\` without it), or (b) extend \`BaseController\` / \`BaseCrudController\` ` +
      `so arc auto-builds the controller and threads the preset fields automatically.`,
  );
}

/**
 * Auto-build a `BaseController` with every resource-level knob
 * threaded in. `maxLimit` is extracted from the parser's schema so
 * `BaseController.QueryResolver` and Fastify validation stay in sync
 * with the parser's configured limit.
 */
function buildBaseController<TDoc extends AnyRecord>(
  resolvedConfig: InternalResourceConfig<TDoc>,
  adapter: ResourceConfig<TDoc>["adapter"],
  repository: unknown,
): IController<TDoc> {
  const qp = resolvedConfig.queryParser as QueryParserInterface | undefined;
  let maxLimitFromParser: number | undefined;
  if (qp?.getQuerySchema) {
    const qpSchema = qp.getQuerySchema();
    const limitProp = qpSchema?.properties?.limit as { maximum?: number } | undefined;
    if (limitProp?.maximum) {
      maxLimitFromParser = limitProp.maximum;
    }
  }

  const controller = new BaseController<TDoc>(repository, {
    resourceName: resolvedConfig.name,
    schemaOptions: resolvedConfig.schemaOptions,
    queryParser: qp,
    maxLimit: maxLimitFromParser,
    tenantField: resolvedConfig.tenantField,
    idField: resolvedConfig.idField,
    ...(resolvedConfig.defaultSort !== undefined
      ? { defaultSort: resolvedConfig.defaultSort }
      : {}),
    matchesFilter: adapter?.matchesFilter,
    cache: resolvedConfig.cache,
    onFieldWriteDenied: resolvedConfig.onFieldWriteDenied,
    presetFields: resolvedConfig._controllerOptions
      ? {
          slugField: resolvedConfig._controllerOptions.slugField,
          parentField: resolvedConfig._controllerOptions.parentField,
        }
      : undefined,
  });

  return controller as unknown as IController<TDoc>;
}
