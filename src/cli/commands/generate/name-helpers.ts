/**
 * Case conversion for resource-name normalisation.
 *
 * `arc generate r org-profile` accepts kebab-case names from the CLI;
 * templates need PascalCase for class identifiers (`OrgProfileRepository`)
 * and camelCase for variable / instance names (`orgProfileResource`).
 * Centralising the converters here keeps every template emitting the
 * same shape — no one-off `.charAt(0).toUpperCase()` chains scattered
 * through template code.
 */

/** Convert kebab-case to PascalCase: `org-profile` → `OrgProfile`. */
export function toPascalCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Convert PascalCase to camelCase: `OrgProfile` → `orgProfile`. */
export function toCamelCase(pascalName: string): string {
  return pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
}
