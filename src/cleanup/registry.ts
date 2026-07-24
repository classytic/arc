/**
 * Cleanup recipe registry — the framework's boot-time integrity gate.
 *
 * Validates recipe-id uniqueness at construction (fail fast, never at run
 * time), exposes typed lookup, and produces the introspection payload the
 * UI/SDK renders as recipe cards. Pure — no I/O, no Fastify.
 */

import { CleanupErrors } from "./errors.js";
import type { CleanupRecipe } from "./types.js";

/** UI/SDK-facing description of one recipe (no methods). */
export interface CleanupRecipeInfo {
  readonly id: string;
  readonly label: string;
  readonly destructive: boolean;
}

export interface CleanupRegistry {
  /** Get a recipe by id, or throw `CLEANUP_UNKNOWN_RECIPE`. */
  get(id: string): CleanupRecipe;
  /** Get a recipe by id, or `undefined`. */
  find(id: string): CleanupRecipe | undefined;
  /** Every registered recipe. */
  all(): readonly CleanupRecipe[];
  /** Introspection payload for UI/SDK recipe cards. */
  introspect(): readonly CleanupRecipeInfo[];
}

/**
 * Build a registry from a recipe list. Throws `CLEANUP_DUPLICATE_RECIPE` at
 * construction if two recipes share an id — a boot-time failure, never a
 * silent last-wins overwrite.
 */
export function createCleanupRegistry(recipes: readonly CleanupRecipe[]): CleanupRegistry {
  const byId = new Map<string, CleanupRecipe>();
  for (const recipe of recipes) {
    if (byId.has(recipe.id)) throw CleanupErrors.duplicateRecipe(recipe.id);
    byId.set(recipe.id, recipe);
  }

  return {
    get(id) {
      const recipe = byId.get(id);
      if (!recipe) throw CleanupErrors.unknownRecipe(id);
      return recipe;
    },
    find(id) {
      return byId.get(id);
    },
    all() {
      return [...byId.values()];
    },
    introspect() {
      return [...byId.values()].map((r) => ({
        id: r.id,
        label: r.label,
        destructive: r.destructive,
      }));
    },
  };
}
