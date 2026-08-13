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
import type { BaseControllerOptions } from "../controllerTypes.js";
import type { InternalResourceConfig } from "./config.js";
import { enforceWriteVerbReachability, warnOnWriteMethodOverride } from "./writeVerbs.js";

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
    // BEFORE any option threading: a resource whose declared write verbs
    // cannot execute must fail with zero side effects to reason about.
    enforceWriteVerbReachability(userController, resolvedConfig);
    threadConfigureLifecycle(userController, resolvedConfig, adapter);
    warnOnDroppedAuthorOptions(resolvedConfig);
    warnOnDroppedPresetOptions(resolvedConfig);
    warnOnWriteMethodOverride(userController, resolvedConfig);
    return userController as unknown as IController<TDoc>;
  }

  if (!hasCrudRoutes || !repository) return undefined;

  return buildBaseController(resolvedConfig, adapter, repository);
}

/**
 * Forward resource-level options into a user-supplied controller via
 * the duck-typed `configure(opts)` lifecycle hook. Closes the pre-2.15
 * gap where `tenantField` / `schemaOptions` / `idField` / `defaultSort`
 * / `cache` / `onFieldWriteDenied` had no path into a host controller
 * unless the host remembered to forward them through `super(repo,
 * { ... })`. `BaseController` / `BaseCrudController` ship `configure()`;
 * custom controllers can opt in by adding the method.
 *
 * **Gate by `_declaredKeys`**: only forward keys the user literally
 * passed at the resource level. Without this gate, arc-inferred values
 * (e.g. `inferTenantFieldFromAdapter` setting `tenantField: false`
 * because the model's organizationId path doesn't exist) would clobber
 * the matching value the host already set in the controller's
 * constructor (e.g. `new BaseController(repo, { tenantField:
 * "companyId" })`). Resource-level explicit values still win — the
 * snapshot captures what the user typed before any inference runs.
 */
function threadConfigureLifecycle<TDoc extends AnyRecord>(
  controller: unknown,
  resolvedConfig: InternalResourceConfig<TDoc>,
  adapter: ResourceConfig<TDoc>["adapter"],
): void {
  const ctrl = controller as { configure?: (opts: Record<string, unknown>) => void };
  if (typeof ctrl.configure !== "function") return;

  const declared = resolvedConfig._declaredKeys;
  const wasDeclared = (key: string): boolean => (declared ? declared.has(key) : true);

  const opts: Record<string, unknown> = {};
  if (resolvedConfig.tenantField !== undefined && wasDeclared("tenantField")) {
    opts.tenantField = resolvedConfig.tenantField;
  }
  if (resolvedConfig.schemaOptions !== undefined && wasDeclared("schemaOptions")) {
    opts.schemaOptions = resolvedConfig.schemaOptions;
  }
  if (resolvedConfig.idField !== undefined && wasDeclared("idField")) {
    opts.idField = resolvedConfig.idField;
  }
  if (resolvedConfig.defaultSort !== undefined && wasDeclared("defaultSort")) {
    opts.defaultSort = resolvedConfig.defaultSort;
  }
  if (resolvedConfig.cache !== undefined && wasDeclared("cache")) {
    opts.cache = resolvedConfig.cache;
  }
  if (resolvedConfig.onFieldWriteDenied !== undefined && wasDeclared("onFieldWriteDenied")) {
    opts.onFieldWriteDenied = resolvedConfig.onFieldWriteDenied;
  }
  if (resolvedConfig.onImmutableWrite !== undefined && wasDeclared("onImmutableWrite")) {
    opts.onImmutableWrite = resolvedConfig.onImmutableWrite;
  }
  if (resolvedConfig.queryParser !== undefined && wasDeclared("queryParser")) {
    opts.queryParser = resolvedConfig.queryParser;
  }
  /**
   * NOT gated on `_declaredKeys`: `writes` is never inferred or injected by a
   * preset, so its presence IS the declaration. Gating it would mean a
   * resource that declares write verbs alongside its own controller silently
   * kept generic CRUD — the exact bypass the seam exists to close.
   */
  if (resolvedConfig.writes !== undefined) {
    opts.writes = resolvedConfig.writes;
  }
  // matchesFilter and presetFields come from adapter / presets, not
  // user-declared fields — always forward when present.
  if (adapter?.matchesFilter !== undefined) opts.matchesFilter = adapter.matchesFilter;
  if (resolvedConfig._controllerOptions) {
    opts.presetFields = {
      slugField: resolvedConfig._controllerOptions.slugField,
      parentField: resolvedConfig._controllerOptions.parentField,
    };
  }

  if (Object.keys(opts).length === 0) return;
  ctrl.configure(opts);
}

/**
 * Forward a resource-level `queryParser` into a user-supplied
 * controller via duck-typed `setQueryParser`. Without this the
 * controller's internal default would silently override the
 * resource's parser, drifting `[contains]` / `[like]` semantics
 * away from what the OpenAPI schema advertises.
 *
 * **Fail-loud (2.15.0):** older versions warned and continued —
 * letting the resource register with a silently-shadowed parser. The
 * "ship and pray they read the log" path produced 90-minute "why
 * doesn't `[contains]` work" debugs in production. Now throws at
 * registration so the misconfig surfaces immediately, with the same
 * fix-it message in the error.
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
  throw new Error(
    `Resource "${resolvedConfig.name}" declares a custom \`queryParser\` but its controller ` +
      "does not expose `setQueryParser(qp)`. The parser would be silently dropped, " +
      "drifting `[contains]` / `[like]` semantics away from the OpenAPI schema. " +
      "Extend `BaseController` / `BaseCrudController` (both implement `setQueryParser`) " +
      "OR add a `setQueryParser(qp)` method to your custom controller that actually wires " +
      "the parser into the controller's query resolution path. " +
      "(arc 2.15.0 hardened this to a registration-time throw — pre-2.15 it was a warn.)",
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
  // If the controller exposes the 2.15.0 `configure(opts)` lifecycle
  // hook arc is about to call, options aren't actually dropped — skip
  // the warn entirely. Configure-aware controllers are the canonical
  // post-2.15 path; the warn was always a band-aid for the older
  // "user-provided controller has no way to receive these" gap.
  const ctrl = resolvedConfig.controller as { configure?: unknown } | undefined;
  if (typeof ctrl?.configure === "function") return;

  const declared = resolvedConfig._declaredKeys;

  // Only warn for keys the USER literally passed — not values arc
  // injected via presets or `inferTenantFieldFromAdapter`. Pre-2.15
  // omitting this check fired false positives whenever inference set
  // e.g. `tenantField: false` on a global resource.
  const isDeclared = (key: string): boolean => (declared ? declared.has(key) : true);

  const dropped: string[] = [];
  if (resolvedConfig.tenantField !== undefined && isDeclared("tenantField")) {
    dropped.push("tenantField");
  }
  if (
    resolvedConfig.schemaOptions !== undefined &&
    Object.keys(resolvedConfig.schemaOptions).length > 0 &&
    isDeclared("schemaOptions")
  ) {
    dropped.push("schemaOptions");
  }
  if (resolvedConfig.idField !== undefined && isDeclared("idField")) {
    dropped.push("idField");
  }
  if (resolvedConfig.defaultSort !== undefined && isDeclared("defaultSort")) {
    dropped.push("defaultSort");
  }
  if (resolvedConfig.cache !== undefined && isDeclared("cache")) {
    dropped.push("cache");
  }
  if (resolvedConfig.onFieldWriteDenied !== undefined && isDeclared("onFieldWriteDenied")) {
    dropped.push("onFieldWriteDenied");
  }
  if (resolvedConfig.onImmutableWrite !== undefined && isDeclared("onImmutableWrite")) {
    dropped.push("onImmutableWrite");
  }

  if (dropped.length === 0) return;

  arcLog("defineResource").warn(
    `Resource "${resolvedConfig.name}" declares a custom controller AND resource-level ` +
      `option(s) [${dropped.join(", ")}]. Arc only threads these when it auto-builds ` +
      `the controller — when you pass your own, they are dropped silently and the ` +
      `controller falls back to its own defaults (e.g. tenantField → 'organizationId'). ` +
      `Either implement \`configure(opts)\` on the controller (arc 2.15+ canonical) ` +
      `or forward them via \`super(repo, { ... })\`. ` +
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

  // Resource-level `defaultLimit` / `maxLimit` (2.17.0) win over the
  // parser-derived defaults so hosts can declare pagination shape
  // inline without authoring a custom `queryParser`. Used by the
  // `referenceData: true` shorthand to lift both caps to 1000 in one
  // line.
  const resourceConfigMaxLimit = (resolvedConfig as { maxLimit?: number }).maxLimit;
  const resourceConfigDefaultLimit = (resolvedConfig as { defaultLimit?: number }).defaultLimit;

  const controller = new BaseController<TDoc>(repository, {
    resourceName: resolvedConfig.name,
    schemaOptions: resolvedConfig.schemaOptions,
    queryParser: qp,
    maxLimit: resourceConfigMaxLimit ?? maxLimitFromParser,
    ...(resourceConfigDefaultLimit !== undefined
      ? { defaultLimit: resourceConfigDefaultLimit }
      : {}),
    tenantField: resolvedConfig.tenantField,
    idField: resolvedConfig.idField,
    ...(resolvedConfig.defaultSort !== undefined
      ? { defaultSort: resolvedConfig.defaultSort }
      : {}),
    matchesFilter: adapter?.matchesFilter,
    cache: resolvedConfig.cache,
    onFieldWriteDenied: resolvedConfig.onFieldWriteDenied,
    onImmutableWrite: resolvedConfig.onImmutableWrite,
    /**
     * Domain commands for the write slots. Threaded here rather than
     * subclassing: the pipeline stays arc's and the command stays the
     * kernel's, so neither has to be re-implemented to reach the other.
     */
    writes: resolvedConfig.writes as BaseControllerOptions["writes"],
    presetFields: resolvedConfig._controllerOptions
      ? {
          slugField: resolvedConfig._controllerOptions.slugField,
          parentField: resolvedConfig._controllerOptions.parentField,
        }
      : undefined,
  });

  return controller as unknown as IController<TDoc>;
}
