import { defineResource } from "../core/defineResource.js";
import {
  adminOnly,
  authenticated,
  fullPublic,
  ownerWithAdminBypass,
  publicRead,
  readOnly,
} from "../permissions/index.js";
import type { PermissionCheck } from "../permissions/types.js";

/**
 * Arc Architecture Schema (AAS)
 *
 * A strict JSON-serializable definition framework for AI agents to procedurally
 * generate complete REST API backends without writing imperative code.
 */
export interface ArcArchitectureSchema {
  /** Overall app name */
  app: string;
  /** List of resources to provision */
  resources: ArcResourceSchema[];
}

export interface ArcResourceSchema {
  /** Name of the resource (e.g., 'product', 'user') */
  name: string;
  /**
   * Primary database adapter/model resolution name.
   * ArcDynamicLoader hooks into a resolution map to provide the right Model.
   */
  adapterPattern?: string;

  /** Security policy mapped to Arc's permission presets */
  permissions:
    | "publicRead"
    | "authenticated"
    | "adminOnly"
    | "ownerWithAdminBypass"
    | "fullPublic"
    | "readOnly"
    | {
        list?: "public" | "auth" | "admin";
        get?: "public" | "auth" | "admin";
        create?: "auth" | "admin";
        update?: "auth" | "admin" | "owner";
        delete?: "auth" | "admin" | "owner";
      };

  /** Presets to inject (e.g., 'softDelete', 'slugLookup', 'multiTenant') */
  presets?: string[];

  /** Simple schema mapping (can be passed to dynamic Zod generation) */
  schema?: Record<string, "string" | "number" | "boolean" | "date" | "object" | "array">;
}

export interface DynamicLoaderContext {
  /** Resolution map for data adapters since they can't be JSON serialized */
  adapterResolver: (resourceName: string, pattern?: string) => any;
  /** Resolution map for additional custom permission checks */
  permissionResolver?: (policy: string) => PermissionCheck;
}

/**
 * Parse an Arc Architecture Schema JSON and dynamically register all resources
 * onto a Fastify instance.
 */
export class ArcDynamicLoader {
  private context: DynamicLoaderContext;

  constructor(context: DynamicLoaderContext) {
    this.context = context;
  }

  /**
   * Load an AAS JSON definition and map it to native Arc resources.
   * Returns an array of fully constructed ResourceDefinitions.
   */
  load(schema: ArcArchitectureSchema) {
    return schema.resources.map((resourceDef) => {
      const adapter = this.context.adapterResolver(resourceDef.name, resourceDef.adapterPattern);

      return defineResource({
        name: resourceDef.name,
        adapter,
        presets: resourceDef.presets,
        permissions: this.resolvePermissions(resourceDef.permissions),
        // If schema is provided, we can dynamically build a validation object
        // but typically the adapter handles DB limits.
      });
    });
  }

  private resolvePermissions(policy: ArcResourceSchema["permissions"]) {
    if (typeof policy === "string") {
      switch (policy) {
        case "publicRead":
          return publicRead();
        case "authenticated":
          return authenticated();
        case "adminOnly":
          return adminOnly();
        case "ownerWithAdminBypass":
          return ownerWithAdminBypass();
        case "fullPublic":
          return fullPublic();
        case "readOnly":
          return readOnly();
        default:
          return authenticated();
      }
    }

    // Map object-style fine-grained policies
    const { list, get, create, update, delete: del } = policy;
    const permissions: any = {};

    if (list === "public") permissions.list = publicRead().list;
    else if (list === "auth") permissions.list = authenticated().list;
    else if (list === "admin") permissions.list = adminOnly().list;

    if (get === "public") permissions.get = publicRead().get;
    else if (get === "auth") permissions.get = authenticated().get;
    else if (get === "admin") permissions.get = adminOnly().get;

    if (create === "auth") permissions.create = authenticated().create;
    else if (create === "admin") permissions.create = adminOnly().create;

    if (update === "auth") permissions.update = authenticated().update;
    else if (update === "owner") permissions.update = ownerWithAdminBypass().update;
    else if (update === "admin") permissions.update = adminOnly().update;

    if (del === "auth") permissions.delete = authenticated().delete;
    else if (del === "owner") permissions.delete = ownerWithAdminBypass().delete;
    else if (del === "admin") permissions.delete = adminOnly().delete;

    return permissions;
  }
}
