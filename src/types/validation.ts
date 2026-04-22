/**
 * Validation result types — produced by `validateResourceConfig` and
 * consumed by `assertValidConfig` / `formatValidationErrors`.
 */

export interface ConfigError {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ConfigError[];
}

export interface ValidateOptions {
  strict?: boolean;
}
