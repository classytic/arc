/**
 * Field permission descriptions — appended to schema-property
 * `description` strings during component generation so codegen surfaces
 * the perm rule next to the field type.
 */

/**
 * Format a field permission rule for an OpenAPI field description.
 *
 * Mirrors the runtime field-permission types — the four supported rule
 * kinds map to a sentence each.
 */
export function formatFieldPermDescription(perm: {
  type: string;
  roles?: readonly string[];
  redactValue?: unknown;
}): string {
  switch (perm.type) {
    case "hidden":
      return "Hidden — never returned in responses";
    case "visibleTo":
      return `Visible to: ${(perm.roles ?? []).join(", ")}`;
    case "writableBy":
      return `Writable by: ${(perm.roles ?? []).join(", ")}`;
    case "redactFor":
      return `Redacted for: ${(perm.roles ?? []).join(", ")}`;
    default:
      return perm.type;
  }
}
