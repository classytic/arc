/**
 * Permission MATRIX — what the caller may do, answered from the live registry.
 *
 * A permission-gated frontend has to decide which screens and buttons to render
 * before it issues a request. Without a server answer it keeps a hand-written
 * copy of the gates, and that copy drifts the moment a resource changes one —
 * silently, and in the dangerous direction: the UI offers an action the server
 * will refuse, or hides one the user is entitled to.
 *
 * This builds the answer from what arc ACTUALLY enforces. Every registered
 * resource contributes its CRUD gates, its state-transition `action:<verb>`
 * gates and its `agg:<name>` gates, introspected through `describePermission`.
 * A resource that exists therefore gates its own screen with no one adding it
 * anywhere — including resources unique to one deployment.
 *
 * ## Why it lives in arc
 *
 * Every input is arc's: `describePermission`, the resource registry, the shapes
 * of `actions` and `aggregations`. Nothing here knows what a domain is. Built
 * in a host, it is re-derived per deployment — and the known gap below is a
 * gap in arc's own introspection, which a host cannot close but arc can.
 *
 * ## Known gap
 *
 * `anyOf(a, b)` composes checks into a bare function with no aggregated meta,
 * so `anyOf(platformAdminOnly(), requireOrgRole(…))` introspects as
 * `authenticated` with no roles. Consumers must read `authenticated` as "the
 * server decides" rather than "any logged-in user", and fall back to an
 * explicit gate for those. Fixing it means teaching the combinators to
 * aggregate meta — an arc change, tracked here because this is where it shows.
 */

import { describePermission } from "./explain.js";
import type { PermissionCheck } from "./types.js";

/**
 * `denied` is a CLOSED door — an explicit `denyAll()`. It is not the same as
 * "no rule found", which surfaces as `public` (public-by-omission). Before it
 * existed a denyAll gate was reported as `authenticated`, so a permission UI
 * rendered the action for every signed-in user and the server refused every
 * attempt.
 *
 * A CLIENT MUST treat an unrecognised type as DENIED, never as permitted — the
 * next type added here will otherwise read as "allowed" on every older client.
 */
export type PermissionEntryType = "public" | "authenticated" | "roles" | "scoped" | "denied";

export interface PermissionEntry {
  type: PermissionEntryType;
  roles: string[];
  /**
   * Present only for `scoped` — the caller-scope dimensions the gate requires
   * (e.g. `{ branchRole: "head_office" }`), for the client to resolve against
   * the viewer's active context.
   */
  scope?: Record<string, unknown>;
}

/**
 * The slice of arc's `ResourceRegistry` this reads.
 *
 * Structural on purpose: coupling to the full registry type would drag the
 * resource layer into the permissions layer, and this only ever reads names
 * and gates.
 */
export interface PermissionMatrixRegistry {
  getAll(): ReadonlyArray<{
    name: string;
    permissions?: Record<string, unknown>;
    actions?: ReadonlyArray<{ name: string; permissions?: unknown }>;
    aggregations?: ReadonlyArray<{ name: string; permissions?: unknown }>;
    /**
     * Custom routes. Only those declaring `capability` are published — see the
     * loop in `introspectRegistry` for why a route needs an explicit name.
     */
    customRoutes?: ReadonlyArray<{
      method: string;
      path: string;
      capability?: string;
      permissions?: unknown;
    }>;
  }>;
}

export interface PermissionMatrixOptions {
  /** The live registry. Omit and the matrix carries only curated modules. */
  registry?: PermissionMatrixRegistry;
  /**
   * Curated, human-named groupings the client already organises around
   * (`products`, `finance`, …). Overlaid FIRST — the live registry wins on an
   * exact name collision, because the enforced gate beats an approximation.
   */
  curatedModules?: Record<string, unknown>;
  /**
   * Second curated layer, applied only where `curatedModules` has no entry —
   * typically per-resource policies behind the domain groupings.
   */
  fallbackModules?: Record<string, unknown>;
  /** Platform-level role names. */
  platformRoles?: readonly string[];
  /** Organization/branch-level role names. */
  orgRoles?: readonly string[];
}

export interface PermissionMatrix {
  /** Every role name, both namespaces — so a role picker has one source. */
  roles: string[];
  roleGroups: { platform: string[]; branch: string[] };
  modules: Record<string, Record<string, PermissionEntry>>;
}

/** Re-shape arc's typed requirement into the wire entry. */
export function introspectCheck(check: PermissionCheck): PermissionEntry {
  const req = describePermission(check);
  if (req.kind === "public") return { type: "public", roles: [] };
  if (req.kind === "roles") return { type: "roles", roles: [...req.roles] };
  if (req.kind === "scoped") {
    return {
      type: "scoped",
      roles: req.roles ? [...req.roles] : [],
      scope: { ...req.scope },
    };
  }
  if (req.kind === "denied") return { type: "denied", roles: [] };
  return { type: "authenticated", roles: [] };
}

/** Introspect a permission module, flattening nested groups to `a.b`. */
export function introspectModule(mod: Record<string, unknown>): Record<string, PermissionEntry> {
  const result: Record<string, PermissionEntry> = {};
  for (const [action, check] of Object.entries(mod)) {
    if (typeof check === "function") {
      result[action] = introspectCheck(check as PermissionCheck);
    } else if (typeof check === "object" && check !== null) {
      for (const [nested, entry] of Object.entries(
        introspectModule(check as Record<string, unknown>),
      )) {
        result[`${action}.${nested}`] = entry;
      }
    }
  }
  return result;
}

/** Every live resource's ACTUAL gates, keyed by arc resource name. */
export function introspectRegistry(
  registry: PermissionMatrixRegistry,
): Record<string, Record<string, PermissionEntry>> {
  const modules: Record<string, Record<string, PermissionEntry>> = {};
  for (const entry of registry.getAll()) {
    const map: Record<string, PermissionEntry> = {};
    for (const [action, check] of Object.entries(entry.permissions ?? {})) {
      if (typeof check === "function") map[action] = introspectCheck(check as PermissionCheck);
    }
    for (const a of entry.actions ?? []) {
      if (typeof a.permissions === "function") {
        map[`action:${a.name}`] = introspectCheck(a.permissions as PermissionCheck);
      }
    }
    for (const agg of entry.aggregations ?? []) {
      if (typeof agg.permissions === "function") {
        map[`agg:${agg.name}`] = introspectCheck(agg.permissions as PermissionCheck);
      }
    }
    /**
     * Custom routes that OPTED IN via `capability`.
     *
     * A route has no inherent name — only a method and a path — so it cannot be
     * keyed automatically, and a path is not an identity. Without this, a
     * resource whose gates live entirely on `routes[]` published nothing, was
     * absent from the matrix, and every `can()` against it answered `false`:
     * a UI gating on it hid the feature from everyone, admins included, and that
     * reads as broken permissions rather than an unpublished key.
     *
     * The key is BARE, alongside `list`/`get`/`create`, so a consumer never has
     * to know whether a verb is a route, an action or a CRUD slot.
     */
    for (const route of entry.customRoutes ?? []) {
      const key = route.capability;
      if (key === undefined || typeof route.permissions !== "function") continue;
      if (map[key] !== undefined) {
        // THROW, never overwrite: a silent collision makes one gate answer for a
        // different verb, and the wrong answer is indistinguishable from the right one.
        throw new Error(
          `[arc] permission-matrix collision on resource "${entry.name}": ` +
            `route ${route.method} ${route.path} declares capability "${key}", ` +
            `which is already published by a CRUD slot, action or another route. ` +
            `Rename the route's \`capability\`.`,
        );
      }
      map[key] = introspectCheck(route.permissions as PermissionCheck);
    }
    if (Object.keys(map).length > 0) modules[entry.name] = map;
  }
  return modules;
}

export function buildPermissionMatrix(options: PermissionMatrixOptions = {}): PermissionMatrix {
  const platform = [...(options.platformRoles ?? [])];
  const branch = [...(options.orgRoles ?? [])];

  const modules: Record<string, Record<string, PermissionEntry>> = {};

  for (const [name, mod] of Object.entries(options.curatedModules ?? {})) {
    if (typeof mod === "object" && mod !== null) {
      modules[name] = introspectModule(mod as Record<string, unknown>);
    }
  }
  for (const [name, mod] of Object.entries(options.fallbackModules ?? {})) {
    if (modules[name]) continue; // the domain-level grouping takes priority
    if (typeof mod === "object" && mod !== null) {
      modules[name] = introspectModule(mod as Record<string, unknown>);
    }
  }

  // LAST, so it wins: the enforced gate beats a curated approximation, and this
  // is what removes the client's static fallbacks.
  if (options.registry) Object.assign(modules, introspectRegistry(options.registry));

  return {
    roles: [...new Set([...platform, ...branch])],
    roleGroups: { platform, branch },
    modules,
  };
}
