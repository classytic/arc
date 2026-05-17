/**
 * Shared types for the `arc generate` scaffolder.
 *
 * `ArcProjectConfig` mirrors the `.arcrc` JSON the `init` command writes —
 * adapter / auth / tenant / language / mcp opt-in. Generated templates
 * branch on these to emit the right imports, permissions, and presets.
 */

export interface ArcProjectConfig {
  adapter?: "mongokit" | "custom";
  auth?: "jwt" | "better-auth";
  tenant?: "multi" | "single";
  typescript?: boolean;
  mcp?: boolean;
}
