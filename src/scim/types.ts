/**
 * SCIM 2.0 plugin public types
 *
 * Uses `RepositoryLike` from `@classytic/repo-core/adapter` directly — the
 * SCIM plugin does NOT introduce its own repository subset. The same kit
 * repos that power arc REST power SCIM unchanged. PATCH array operators
 * and PUT replace semantics are kit-conditional and detected at runtime
 * (see `routes.ts` for honest 400 / 501 paths).
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { FastifyRequest } from "fastify";
import type { ScimResourceMapping } from "./mapping.js";

/**
 * One arc resource bound into the SCIM surface.
 *
 * Pass the resource definition you already register with arc — the plugin
 * reads `resource.adapter.repository`. Whatever kit plugins (`auditPlugin`,
 * `multiTenantPlugin`, `fieldFilterPlugin`, …) you wire at construction
 * time fire for SCIM the same way they fire for arc REST, because both
 * surfaces call the same repository methods.
 */
export interface ScimResourceBinding {
  resource: {
    name: string;
    adapter: {
      repository: RepositoryLike;
    };
  };
  /**
   * Override the SCIM ↔ resource mapping. Defaults to the BA-aligned shape
   * (BA `user.email` ↔ SCIM `userName`, etc.). Pass a partial — only the
   * diverging fields need to be overridden.
   */
  mapping?: Partial<ScimResourceMapping>;
}

/**
 * Configuration for `scimPlugin`. One of `bearer` / `verify` is required.
 */
export interface ScimPluginOptions {
  /** User resource binding (mounts `/scim/v2/Users`). */
  users: ScimResourceBinding;
  /** Group / organization resource binding (mounts `/scim/v2/Groups`). Optional. */
  groups?: ScimResourceBinding;
  /**
   * Static bearer token. Mutually exclusive with `verify` — pass one or the other.
   */
  bearer?: string;
  /**
   * Custom verifier — runs on every SCIM request. Return `true` to accept,
   * `false` (or throw) to reject. Use for OIDC-secured deployments where
   * the SCIM token is a short-lived JWT.
   */
  verify?: (request: FastifyRequest) => boolean | Promise<boolean>;
  /**
   * Mount prefix. Defaults to `/scim/v2` — RFC-compliant, what every IdP expects.
   */
  prefix?: string;
  /**
   * Maximum page size SCIM clients can request via `count` — defaults to 200
   * (Okta's default). Larger values may degrade IdP-side reconciliation.
   */
  maxResults?: number;
  /**
   * Optional structured-log hook — called once per SCIM request with a
   * canonical observability payload. Defaults to `request.log.info(...)`.
   */
  observe?: (event: ScimObservedEvent) => void;
}

/**
 * Single observability event emitted per SCIM request. Stable shape so
 * downstream metrics / logging stacks can pin dashboards without arc-version
 * drift.
 */
export interface ScimObservedEvent {
  /** SCIM resource type (`Users` / `Groups`) or `discovery` for meta endpoints. */
  resourceType: "Users" | "Groups" | "discovery";
  /**
   * SCIM operation. CRUD: `list`, `get`, `create`, `replace`, `patch`, `delete`.
   * Discovery: `discovery.<endpoint>`.
   */
  op: string;
  /** HTTP status code returned. */
  status: number;
  /** Wall-clock duration in ms (rounded). */
  durationMs: number;
  /** SCIM error type when the request failed (`invalidFilter`, etc.). Undefined on success. */
  scimType?: string;
  /** Path component (`/Users`, `/Users/:id`, `/ServiceProviderConfig`, …). */
  path: string;
}
