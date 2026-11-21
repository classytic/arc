/**
 * A preset route's permission: the preset's own option, else the resource permission it
 * maps to. With neither, the route carries an UNRESOLVED marker, never a silent
 * `allowPublic()`: `defineResource` fails boot under `strictPermissions`
 * (`preset-route-public-by-omission`) and otherwise mounts the route public with an info
 * diagnostic, the same ladder as an ungated CRUD read. Outside `defineResource` (a direct
 * `applyPresets` caller) the marker denies.
 */

import { denyAll } from "../permissions/index.js";
import type { PermissionCheck } from "../permissions/types.js";

const UNRESOLVED = Symbol.for("arc.presetPermissionUnresolved");

export interface UnresolvedPresetPermission {
  readonly preset: string;
  /** The resource permission key the route inherits (`get`, `list`). */
  readonly inherits: string;
  /** The preset's own option that sets this route's permission, when it has one. */
  readonly option?: string;
}

export function presetPermission(
  check: PermissionCheck | undefined,
  unresolved: UnresolvedPresetPermission,
): PermissionCheck {
  if (check) return check;
  const marker = denyAll(
    `Preset '${unresolved.preset}' route has no permission (permissions.${unresolved.inherits} is not set)`,
  );
  Object.defineProperty(marker, UNRESOLVED, { value: unresolved });
  return marker;
}

export function unresolvedPresetPermission(check: unknown): UnresolvedPresetPermission | undefined {
  if (typeof check !== "function") return undefined;
  return Reflect.get(check, UNRESOLVED) as UnresolvedPresetPermission | undefined;
}
