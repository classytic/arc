/**
 * Pick (or auto-create) the resource's controller:
 *   1. User-supplied → thread `queryParser` / options in; warn on anything dropped.
 *   2. No controller + CRUD routes + repository → auto-build a `BaseController`.
 *   3. Otherwise → `undefined` (custom-routes-only resource).
 *
 * Dropped options must never be silent — each warn names the resource, the
 * options, and the fix (`ARC_SUPPRESS_WARNINGS=1` silences via `arcLog()`).
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { isReadOnlyRepo } from "@classytic/repo-core/repository";
import { arcLog } from "../../logger/index.js";
import type { IController, QueryParserInterface, ResourceConfig } from "../../types/index.js";
import { BaseController } from "../BaseController.js";
import type { BaseControllerOptions } from "../controllerTypes.js";
import type { InternalResourceConfig } from "./config.js";
import { enforceWriteVerbReachability, warnOnWriteMethodOverride } from "./writeVerbs.js";

/** CRUD routes refused over a read-only repository. */
const READ_ONLY_REFUSED_ROUTES = ["create", "update", "delete"] as const;

/** Resolve the controller for the resource (branches in the module docstring). */
export function resolveOrAutoCreateController<TDoc extends object>(
  resolvedConfig: InternalResourceConfig<TDoc>,
  adapter: ResourceConfig<TDoc>["adapter"],
  repository: RepositoryLike | undefined,
  hasCrudRoutes: boolean,
): IController<TDoc> | undefined {
  const userController = resolvedConfig.controller;

  // `transactional: true` is BOOT-fatal when unsupported — never silently degraded to
  // bare writes. Method presence is checked now; the deployment CAPABILITY is deferred
  // to registration (`assertTransactionCapability`) because `defineResource()` runs
  // before `beforeBoot()` connects, and kits expose `withTransaction` regardless.
  if (resolvedConfig.transactional === true) {
    const repoLike = repository as
      | { withTransaction?: unknown; capabilities?: { transactions?: unknown } }
      | null
      | undefined;
    if (typeof repoLike?.withTransaction !== "function") {
      throw new Error(
        `Resource "${resolvedConfig.name}" declares \`transactional: true\` but its ` +
          "repository has no `withTransaction` (capability `transactions: false` — D1, " +
          "standalone Mongo). Wire a transactional kit, or remove the flag; arc will not " +
          "silently drop a requested transaction envelope.",
      );
    }
  }

  // Read-only repositories (rows owned elsewhere: Better Auth, a SQL view, a replica)
  // refuse write ROUTES at boot rather than 500 on the first write. Hosts disable the
  // routes or opt into the kit's `unsafeWritable`.
  if (repository && isReadOnlyRepo(repository)) {
    const disabled = new Set(resolvedConfig.disabledRoutes ?? []);
    const enabledWrites = READ_ONLY_REFUSED_ROUTES.filter(
      (op) => !resolvedConfig.disableDefaultRoutes && !disabled.has(op),
    );
    if (enabledWrites.length > 0) {
      throw new Error(
        `Resource "${resolvedConfig.name}" mounts write routes (${enabledWrites.join(", ")}) ` +
          "over a READ-ONLY repository — its rows are owned by another component that enforces " +
          "invariants generic CRUD would bypass (Better Auth hashes passwords, revokes sessions, " +
          "and cascades org membership on every write it performs). Disable the write routes " +
          "(`disabledRoutes: ['create', 'update', 'delete']`), or if raw writes are genuinely " +
          "required, build the repository with the kit's explicit `unsafeWritable: true` opt-in.",
      );
    }
  }

  if (userController) {
    threadQueryParser(userController, resolvedConfig);
    // BEFORE any option threading: a resource whose declared write verbs
    // cannot execute must fail with zero side effects to reason about.
    enforceWriteVerbReachability(userController, resolvedConfig);
    threadConfigureLifecycle(userController, resolvedConfig, adapter);
    warnOnDroppedAuthorOptions(resolvedConfig);
    warnOnDroppedPresetOptions(resolvedConfig);
    warnOnWriteMethodOverride(userController, resolvedConfig);
    return userController as IController<TDoc>;
  }

  if (!hasCrudRoutes || !repository) return undefined;

  return buildBaseController(resolvedConfig, adapter, repository);
}

/**
 * Forward resource-level options into a user-supplied controller via the
 * duck-typed `configure(opts)` hook.
 *
 * **Gated by `_declaredKeys`**: only keys the user literally passed are
 * forwarded, so arc-inferred values (e.g. `tenantField: false` from adapter
 * inference) never clobber what the host set in the controller's constructor.
 */
function threadConfigureLifecycle<TDoc extends object>(
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
  if (resolvedConfig.lookupFields !== undefined && wasDeclared("lookupFields")) {
    opts.lookupFields = resolvedConfig.lookupFields;
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
  // NOT gated: `writes` is never inferred, so presence IS the declaration. Gating it
  // would let a custom controller silently keep generic CRUD, bypassing the verbs.
  if (resolvedConfig.writes !== undefined) {
    opts.writes = resolvedConfig.writes;
  }
  // Same rule as `writes`: never inferred, presence IS the declaration.
  if (resolvedConfig.transactional !== undefined) {
    opts.transactional = resolvedConfig.transactional;
  }
  if (resolvedConfig.concurrency !== undefined) {
    opts.concurrency = resolvedConfig.concurrency;
  }
  // From adapter / presets, not user-declared — always forwarded when present.
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
 * Forward a resource-level `queryParser` into a user-supplied controller via
 * duck-typed `setQueryParser`. Throws when the controller can't accept it —
 * a shadowed parser silently drifts filter semantics from the OpenAPI schema.
 */
function threadQueryParser<TDoc extends object>(
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
 * Warn when a custom controller without `configure()` can't receive
 * resource-level options the user declared.
 */
function warnOnDroppedAuthorOptions<TDoc extends object>(
  resolvedConfig: InternalResourceConfig<TDoc>,
): void {
  // Configure-aware controllers receive the options — nothing is dropped.
  const ctrl = resolvedConfig.controller as { configure?: unknown } | undefined;
  if (typeof ctrl?.configure === "function") return;

  const declared = resolvedConfig._declaredKeys;

  // Only keys the USER passed — inferred/preset values would be false positives.
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
 * Warn when a preset injected `_controllerOptions` but the user supplied their
 * own controller. The user didn't declare these, so the fix is dropping the
 * preset or extending `BaseController` — not "forward them".
 */
function warnOnDroppedPresetOptions<TDoc extends object>(
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
 * Auto-build a `BaseController` with every resource-level option. `maxLimit`
 * comes from the parser's schema so QueryResolver and Fastify validation agree.
 */
function buildBaseController<TDoc extends object>(
  resolvedConfig: InternalResourceConfig<TDoc>,
  adapter: ResourceConfig<TDoc>["adapter"],
  repository: RepositoryLike,
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

  // Resource-level `defaultLimit` / `maxLimit` win over parser-derived values
  // (e.g. the `referenceData: true` shorthand).
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
    ...(resolvedConfig.lookupFields ? { lookupFields: resolvedConfig.lookupFields } : {}),
    ...(resolvedConfig.defaultSort !== undefined
      ? { defaultSort: resolvedConfig.defaultSort }
      : {}),
    matchesFilter: adapter?.matchesFilter,
    cache: resolvedConfig.cache,
    onFieldWriteDenied: resolvedConfig.onFieldWriteDenied,
    onImmutableWrite: resolvedConfig.onImmutableWrite,
    writes: resolvedConfig.writes as BaseControllerOptions["writes"],
    transactional: resolvedConfig.transactional === true,
    ...(resolvedConfig.concurrency ? { concurrency: resolvedConfig.concurrency } : {}),
    presetFields: resolvedConfig._controllerOptions
      ? {
          slugField: resolvedConfig._controllerOptions.slugField,
          parentField: resolvedConfig._controllerOptions.parentField,
        }
      : undefined,
  });

  return controller as IController<TDoc>;
}

/** Deferred like the transaction check: `concurrency` needs the kit's CAS on `ifVersion`. */
export function assertConcurrencyCapability(repository: unknown, resourceName: string): void {
  const capabilities = (repository as { capabilities?: { optimisticConcurrency?: unknown } } | null)
    ?.capabilities;
  if (!capabilities || capabilities.optimisticConcurrency === true) return;
  throw new Error(
    `Resource "${resourceName}" declares \`concurrency\` but its repository reports ` +
      `\`capabilities.optimisticConcurrency: ${String(capabilities.optimisticConcurrency)}\` — ` +
      "an ETag it cannot enforce would promise a guard that is not there. Use a kit with CAS " +
      "writes (mongokit), or remove the option.",
  );
}

/**
 * The DEFERRED half of the `transactional: true` gate — run at registration,
 * after `beforeBoot()` connects. Fail-closed: anything but a confirmed `true`
 * refuses the boot. A repository with NO capability descriptor passes (it never
 * promised one; the define-time presence check covered it).
 */
export function assertTransactionCapability(repository: unknown, resourceName: string): void {
  const capabilities = (repository as { capabilities?: { transactions?: unknown } } | null)
    ?.capabilities;
  if (!capabilities || capabilities.transactions === true) return;
  throw new Error(
    `Resource "${resourceName}" declares \`transactional: true\` but its repository reports ` +
      `\`capabilities.transactions: ${String(capabilities.transactions)}\` — this deployment ` +
      "cannot run transactions (standalone MongoDB, D1, or a topology arc could not confirm). " +
      "`withTransaction` exists but every call would fail at BEGIN. Point at a replica set / " +
      "transactional backend, or remove the flag. Checked at REGISTRATION, so a connection " +
      "opened in `beforeBoot()` is already live by now.",
  );
}
