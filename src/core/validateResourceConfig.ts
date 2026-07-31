/**
 * Resource Configuration Validator
 *
 * Fail-fast validation at definition time.
 * Invalid configs throw immediately with clear, actionable errors.
 *
 * @example
 * const result = validateResourceConfig(config);
 * if (!result.valid) {
 *   console.error(formatValidationErrors(result.errors));
 * }
 */

import { CRUD_OPERATIONS } from "../constants.js";
import { getAvailablePresets } from "../presets/index.js";
import type { PresetResult, ResourceConfig, RouteDefinition } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface ConfigError {
  field: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ConfigError[];
  warnings: ConfigError[];
}

export interface ValidateOptions {
  /** Skip controller method validation (for testing) */
  skipControllerCheck?: boolean;
  /** Allow unknown preset names */
  allowUnknownPresets?: boolean;
  /** Custom valid permission keys beyond CRUD */
  additionalPermissionKeys?: string[];
}

// ============================================================================
// Core Validation
// ============================================================================

/**
 * Validate a resource configuration
 */
export function validateResourceConfig(
  config: ResourceConfig,
  options: ValidateOptions = {},
): ValidationResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigError[] = [];

  // ========================================
  // Required Fields
  // ========================================

  if (!config.name) {
    errors.push({
      field: "name",
      message: "Resource name is required",
      suggestion: 'Add a unique resource name (e.g., "product", "user")',
    });
  } else if (!/^[a-z][a-z0-9-]*$/i.test(config.name)) {
    errors.push({
      field: "name",
      message: `Invalid resource name "${config.name}"`,
      suggestion: "Use alphanumeric characters and hyphens, starting with a letter",
    });
  }

  // Check if any CRUD routes will actually be created
  const crudRoutes = CRUD_OPERATIONS;
  const disabledRoutes = new Set(config.disabledRoutes ?? []);
  const enabledCrudRoutes = crudRoutes.filter((route) => !disabledRoutes.has(route));
  const hasCrudRoutes = !config.disableDefaultRoutes && enabledCrudRoutes.length > 0;

  // Adapter is required when CRUD routes are enabled
  if (hasCrudRoutes) {
    if (!config.adapter) {
      errors.push({
        field: "adapter",
        message: "Data adapter is required when CRUD routes are enabled",
        suggestion: "Provide an adapter: createMongooseAdapter({ model, repository })",
      });
    } else if (!config.adapter.repository) {
      errors.push({
        field: "adapter.repository",
        message: "Adapter must provide a repository",
        suggestion: "Ensure your adapter returns a valid StandardRepo (see @classytic/repo-core)",
      });
    }

    // Controller is auto-created (BaseController) when not provided — this is
    // the intended default. No warning needed; it's not a misconfiguration.
  } else {
    // Service resources (no CRUD routes) don't need adapter or controller
    if (!config.adapter && !config.routes?.length) {
      warnings.push({
        field: "config",
        message: "Resource has no adapter and no routes",
        suggestion: "Provide either adapter for CRUD or routes for custom logic",
      });
    }
  }

  // Legacy validation removed - adapter pattern handles this

  // ========================================
  // Controller Method Validation
  // ========================================

  if (config.controller && !options.skipControllerCheck && !config.disableDefaultRoutes) {
    const ctrl = config.controller as unknown as Record<string, unknown>;

    // Check for IController methods (MongoKit-compatible standard)
    const requiredMethods = CRUD_OPERATIONS;
    for (const method of requiredMethods) {
      if (typeof ctrl[method] !== "function") {
        errors.push({
          field: `controller.${method}`,
          message: `Missing required CRUD method "${method}"`,
          suggestion: "Extend BaseController which implements IController interface",
        });
      }
    }
  }

  // Validate route handlers exist on controller
  if (config.controller && config.routes) {
    validateRouteHandlers(config.controller, config.routes, errors);
  }

  // ========================================
  // Permission Key Validation
  // ========================================

  if (config.permissions) {
    validatePermissionKeys(config, options, errors, warnings);
  }

  // ========================================
  // Preset Validation
  // ========================================

  if (config.presets && !options.allowUnknownPresets) {
    validatePresets(config.presets, errors, warnings);
  }

  // ========================================
  // Prefix Validation
  // ========================================

  if (config.prefix) {
    if (!config.prefix.startsWith("/")) {
      errors.push({
        field: "prefix",
        message: `Prefix must start with "/" (got "${config.prefix}")`,
        suggestion: `Change to "/${config.prefix}"`,
      });
    }
    if (config.prefix.endsWith("/") && config.prefix !== "/") {
      warnings.push({
        field: "prefix",
        message: `Prefix should not end with "/" (got "${config.prefix}")`,
        suggestion: `Change to "${config.prefix.slice(0, -1)}"`,
      });
    }
  }

  // ========================================
  // Additional Route Validation
  // ========================================

  if (config.routes) {
    validateRoutes(config.routes, errors);
    validateRouteCrudCollisions(config, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function validateRouteHandlers(
  controller: unknown,
  routes: RouteDefinition[],
  errors: ConfigError[],
): void {
  const ctrl = controller as Record<string, unknown>;

  for (const route of routes) {
    // Both fields accept a controller-method NAME; only the calling convention
    // differs, so the lookup must cover either.
    const named = typeof route.handler === "string" ? route.handler : route.rawHandler;
    if (typeof named !== "string") continue;
    if (typeof ctrl[named] !== "function") {
      errors.push({
        field: `routes[${route.method} ${route.path}]`,
        message: `Handler "${named}" not found on controller`,
        suggestion: `Add method "${named}" to controller or use a function handler`,
      });
    }
  }
}

function validatePermissionKeys(
  config: ResourceConfig,
  options: ValidateOptions,
  _errors: ConfigError[],
  warnings: ConfigError[],
): void {
  const validKeys = new Set([...CRUD_OPERATIONS, ...(options.additionalPermissionKeys ?? [])]);

  // Add keys from custom routes
  for (const route of config.routes ?? []) {
    if (typeof route.handler === "string") validKeys.add(route.handler);
    if (typeof route.rawHandler === "string") validKeys.add(route.rawHandler);
  }

  // Add preset-specific keys
  for (const preset of config.presets ?? []) {
    const presetName = typeof preset === "string" ? preset : (preset as { name: string }).name;
    if (presetName === "softDelete") {
      validKeys.add("deleted");
      validKeys.add("restore");
    }
    if (presetName === "slugLookup") {
      validKeys.add("getBySlug");
    }
    if (presetName === "tree") {
      // Semantic keys (intuitive)
      validKeys.add("tree");
      validKeys.add("children");
      // Handler names (exact match)
      validKeys.add("getTree");
      validKeys.add("getChildren");
    }
  }

  for (const key of Object.keys(config.permissions ?? {})) {
    if (!validKeys.has(key)) {
      warnings.push({
        field: `permissions.${key}`,
        message: `Unknown permission key "${key}"`,
        suggestion: `Valid keys: ${Array.from(validKeys).join(", ")}`,
      });
    }
  }
}

function validatePresets(
  presets: Array<string | PresetResult | { name: string; [key: string]: unknown }>,
  errors: ConfigError[],
  warnings: ConfigError[],
): void {
  const availablePresets = getAvailablePresets();

  for (const preset of presets) {
    // Skip validation for fully-resolved PresetResult objects (custom presets)
    // These have middlewares/routes and are ready to use
    if (typeof preset === "object" && ("middlewares" in preset || "routes" in preset)) {
      // This is a custom preset passed as PresetResult - skip registry validation
      continue;
    }

    const presetName = typeof preset === "string" ? preset : preset.name;

    if (!availablePresets.includes(presetName)) {
      errors.push({
        field: "presets",
        message: `Unknown preset "${presetName}"`,
        suggestion: `Available presets: ${availablePresets.join(", ")}`,
      });
    }

    // Validate preset options if object form (but not full PresetResult)
    if (typeof preset === "object") {
      validatePresetOptions(preset, warnings);
    }
  }
}

function validatePresetOptions(
  preset: PresetResult | { name: string; [key: string]: unknown },
  warnings: ConfigError[],
): void {
  const knownOptions: Record<string, string[]> = {
    slugLookup: ["slugField"],
    tree: ["parentField"],
    softDelete: ["deletedField"],
    ownedByUser: ["ownerField"],
    multiTenant: ["tenantField", "allowPublic"],
  };

  const validOptions = knownOptions[preset.name] ?? [];
  const providedOptions = Object.keys(preset).filter((k) => k !== "name");

  for (const opt of providedOptions) {
    if (!validOptions.includes(opt)) {
      warnings.push({
        field: `presets[${preset.name}].${opt}`,
        message: `Unknown option "${opt}" for preset "${preset.name}"`,
        suggestion:
          validOptions.length > 0
            ? `Valid options: ${validOptions.join(", ")}`
            : `Preset "${preset.name}" has no configurable options`,
      });
    }
  }
}

/**
 * Detect collisions between user-declared `routes:` entries and the
 * auto-CRUD route table that `createCrudRouter` will register.
 *
 * Without this check, a custom `POST /` on the same prefix as auto-CRUD's
 * `create` boots fine through `defineResource()` and only blows up at
 * `app.register()` time with Fastify's opaque `FST_ERR_DUPLICATED_ROUTE`.
 * That error doesn't mention `disabledRoutes` and doesn't distinguish
 * "you collided with auto-CRUD" from "you collided with yourself" — so
 * the consumer has to grep arc's source to discover the fix.
 *
 * We surface the fix in the error message, naming the conflicting op
 * and the literal line to add.
 *
 * Honored config:
 *   - `disableDefaultRoutes: true` → no auto-CRUD, no collisions possible
 *   - `disabledRoutes: ['create']` → that op's path is free for custom use
 *   - `updateMethod: 'PUT' | 'both'` → update slot covers PUT/PATCH accordingly
 */
function validateRouteCrudCollisions(config: ResourceConfig, errors: ConfigError[]): void {
  if (config.disableDefaultRoutes) return;
  if (!config.routes || config.routes.length === 0) return;

  const updateMethod = config.updateMethod ?? "PATCH";
  const updateMethods: readonly string[] =
    updateMethod === "both" ? ["PUT", "PATCH"] : [updateMethod];

  const disabled = new Set(config.disabledRoutes ?? []);
  // Each CRUD slot maps to one or more (method, path) tuples. `update`
  // expands to two tuples when `updateMethod: 'both'`.
  const crudTable: ReadonlyArray<{
    op: "list" | "get" | "create" | "update" | "delete";
    method: string;
    path: string;
  }> = [
    { op: "list", method: "GET", path: "/" },
    { op: "get", method: "GET", path: "/:id" },
    { op: "create", method: "POST", path: "/" },
    ...updateMethods.map((m) => ({ op: "update" as const, method: m, path: "/:id" })),
    { op: "delete", method: "DELETE", path: "/:id" },
  ];

  for (const [i, route] of config.routes.entries()) {
    if (!route.method || !route.path) continue;
    for (const crud of crudTable) {
      if (disabled.has(crud.op)) continue;
      if (route.method !== crud.method || route.path !== crud.path) continue;
      errors.push({
        field: `routes[${i}]`,
        message: `Route ${route.method} ${route.path} collides with auto-CRUD "${crud.op}"`,
        suggestion:
          `Add \`disabledRoutes: ['${crud.op}']\` to suppress the auto-CRUD route, ` +
          `or move your custom handler to a different path. ` +
          `Set \`disableDefaultRoutes: true\` to disable all auto-CRUD on this resource.`,
      });
    }
  }
}

function validateRoutes(routes: RouteDefinition[], errors: ConfigError[]): void {
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  const seenRoutes = new Set<string>();

  for (const [i, route] of routes.entries()) {
    if (!validMethods.includes(route.method)) {
      errors.push({
        field: `routes[${i}].method`,
        message: `Invalid HTTP method "${route.method}"`,
        suggestion: `Valid methods: ${validMethods.join(", ")}`,
      });
    }

    if (!route.path) {
      errors.push({
        field: `routes[${i}].path`,
        message: "Route path is required",
      });
    } else if (!route.path.startsWith("/")) {
      errors.push({
        field: `routes[${i}].path`,
        message: `Route path must start with "/" (got "${route.path}")`,
        suggestion: `Change to "/${route.path}"`,
      });
    }

    // 2.16 — routes accept either `handler` (string / function) OR
    // `controllerMethod` (typed function-ref form). The runtime layer
    // enforces "exactly one"; this gate just rejects "neither set".
    const routeWithRefs = route as typeof route & {
      controllerMethod?: unknown;
    };
    if (
      !route.handler &&
      !route.rawHandler &&
      typeof routeWithRefs.controllerMethod !== "function"
    ) {
      errors.push({
        field: `routes[${i}].handler`,
        message:
          "Route must declare one of `handler` (arc pipeline), `rawHandler` (Fastify-native), or `controllerMethod`",
        suggestion:
          "Prefer `controllerMethod: (c: MyController) => c.method` for typed handler refs.",
      });
    }
    // The two execution models are mutually exclusive — declaring both is
    // ambiguous about whether arc wraps the response.
    if (route.handler && route.rawHandler) {
      errors.push({
        field: `routes[${i}].rawHandler`,
        message: "Route declares BOTH `handler` and `rawHandler`",
        suggestion:
          "Use `handler` for the arc pipeline (receives IRequestContext) or `rawHandler` for a Fastify-native handler (receives request, reply) — not both.",
      });
    }

    // 2.31 — `raw` removed. Reported here so a config with several stale routes
    // lists them all at once; `createCrudRouter` throws on the first as the
    // backstop for routes that never pass through this validator (preset- and
    // module-contributed ones).
    if ("raw" in route) {
      errors.push({
        field: `routes[${i}].raw`,
        message: "`raw` was removed in arc 2.31 — the field now carries the intent",
        suggestion:
          "Move the function to `rawHandler` (Fastify-native) or leave it in `handler` (arc pipeline), and delete the flag. If the route comes from a dependency, that package needs a release built against arc >=2.31.",
      });
    }

    // `streamResponse` invokes the handler with `(request, reply)` and lets it
    // own the response — that IS the raw model, so it REQUIRES `rawHandler`.
    // Stated as a positive invariant rather than "reject `handler`": the router
    // derives `isRaw` from `rawHandler` alone, so a `controllerMethod` route
    // would otherwise validate, get pipeline-wrapped, and then be handed to the
    // streaming wrapper — a third execution model nobody declared.
    if (
      (route as { streamResponse?: boolean }).streamResponse === true &&
      route.rawHandler === undefined
    ) {
      errors.push({
        field: `routes[${i}].streamResponse`,
        message: "`streamResponse: true` requires `rawHandler`",
        suggestion:
          "Streaming routes are invoked with `(request, reply)` and own the socket — declare the function as `rawHandler` (not `handler` or `controllerMethod`).",
      });
    }

    const routeKey = `${route.method} ${route.path}`;
    if (seenRoutes.has(routeKey)) {
      errors.push({
        field: `routes[${i}]`,
        message: `Duplicate route "${routeKey}"`,
      });
    }
    seenRoutes.add(routeKey);
  }
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format validation errors for display
 */
export function formatValidationErrors(resourceName: string, result: ValidationResult): string {
  const lines: string[] = [];

  if (result.errors.length > 0) {
    lines.push(`Resource "${resourceName}" validation failed:`);
    lines.push("");
    lines.push("ERRORS:");
    for (const err of result.errors) {
      lines.push(`  ✗ ${err.field}: ${err.message}`);
      if (err.suggestion) {
        lines.push(`    → ${err.suggestion}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("WARNINGS:");
    for (const warn of result.warnings) {
      lines.push(`  ⚠ ${warn.field}: ${warn.message}`);
      if (warn.suggestion) {
        lines.push(`    → ${warn.suggestion}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Validate and throw if invalid
 */
export function assertValidConfig(config: ResourceConfig, options?: ValidateOptions): void {
  const result = validateResourceConfig(config, options);

  if (!result.valid) {
    const errorMsg = formatValidationErrors(config.name ?? "unknown", result);
    throw new Error(errorMsg);
  }

  // Warnings are available via validateResourceConfig() return value.
  // Callers with access to a logger can surface them; no console output from library code.
}
