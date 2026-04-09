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
import type { AdditionalRoute, PresetResult, ResourceConfig } from "../types/index.js";

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
        suggestion: "Ensure your adapter returns a valid CrudRepository",
      });
    }

    // Controller is auto-created (BaseController) when not provided — this is
    // the intended default. No warning needed; it's not a misconfiguration.
  } else {
    // Service resources (no CRUD routes) don't need adapter or controller
    if (!config.adapter && !config.additionalRoutes?.length) {
      warnings.push({
        field: "config",
        message: "Resource has no adapter and no additionalRoutes",
        suggestion: "Provide either adapter for CRUD or additionalRoutes for custom logic",
      });
    }
  }

  // Legacy validation removed - adapter pattern handles this

  // ========================================
  // Controller Method Validation
  // ========================================

  if (config.controller && !options.skipControllerCheck && !config.disableDefaultRoutes) {
    const ctrl = config.controller as any;

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

  // Validate additional route handlers exist
  if (config.controller && config.additionalRoutes) {
    validateAdditionalRouteHandlers(config.controller, config.additionalRoutes, errors);
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

  if (config.additionalRoutes) {
    validateAdditionalRoutes(config.additionalRoutes, errors);
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

function validateAdditionalRouteHandlers(
  controller: unknown,
  routes: AdditionalRoute[],
  errors: ConfigError[],
): void {
  const ctrl = controller as Record<string, unknown>;

  for (const route of routes) {
    if (typeof route.handler === "string") {
      if (typeof ctrl[route.handler] !== "function") {
        errors.push({
          field: `additionalRoutes[${route.method} ${route.path}]`,
          message: `Handler "${route.handler}" not found on controller`,
          suggestion: `Add method "${route.handler}" to controller or use a function handler`,
        });
      }
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

  // Add keys from additional routes
  for (const route of config.additionalRoutes ?? []) {
    if (typeof route.handler === "string") {
      validKeys.add(route.handler);
    }
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
    // These have middlewares/additionalRoutes and are ready to use
    if (typeof preset === "object" && ("middlewares" in preset || "additionalRoutes" in preset)) {
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

function validateAdditionalRoutes(routes: AdditionalRoute[], errors: ConfigError[]): void {
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  const seenRoutes = new Set<string>();

  for (const [i, route] of routes.entries()) {
    // Method validation
    if (!validMethods.includes(route.method)) {
      errors.push({
        field: `additionalRoutes[${i}].method`,
        message: `Invalid HTTP method "${route.method}"`,
        suggestion: `Valid methods: ${validMethods.join(", ")}`,
      });
    }

    // Path validation
    if (!route.path) {
      errors.push({
        field: `additionalRoutes[${i}].path`,
        message: "Route path is required",
      });
    } else if (!route.path.startsWith("/")) {
      errors.push({
        field: `additionalRoutes[${i}].path`,
        message: `Route path must start with "/" (got "${route.path}")`,
        suggestion: `Change to "/${route.path}"`,
      });
    }

    // Handler validation
    if (!route.handler) {
      errors.push({
        field: `additionalRoutes[${i}].handler`,
        message: "Route handler is required",
      });
    }

    // Duplicate detection
    const routeKey = `${route.method} ${route.path}`;
    if (seenRoutes.has(routeKey)) {
      errors.push({
        field: `additionalRoutes[${i}]`,
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
