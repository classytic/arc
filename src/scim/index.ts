/**
 * SCIM 2.0 plugin (RFC 7643/7644)
 *
 * Auto-derives `/scim/v2/Users` + `/scim/v2/Groups` REST endpoints from
 * existing arc resources — no shadow tables, no parallel data model.
 *
 * The plugin is **opt-in**: register it only when an enterprise customer
 * needs IdP provisioning (Okta, Azure AD, Google Workspace, JumpCloud,
 * OneLogin, …). All routes mounted under `/scim/v2/` so it never collides
 * with the underlying `/users` / `/organizations` REST surface.
 *
 * **Surface**:
 *   - CRUD: `GET/POST/PUT/PATCH/DELETE /scim/v2/Users[/:id]` + same for `Groups`
 *   - PATCH: full RFC 7644 PatchOp (add / replace / remove)
 *   - Discovery: `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`
 *   - Auth: bearer token (single static OR `verify(req)` callback)
 *   - Observability: every request emits a `ScimObservedEvent` (see `types.ts`)
 *
 * Internals split across:
 *   - `helpers.ts`   — auth, mapping merge, response unwrap, content-type parser
 *   - `routes.ts`    — User/Group CRUD route mounting
 *   - `discovery.ts` — RFC 7644 §4 discovery endpoints
 *   - `filter.ts`    — SCIM filter language parser
 *   - `patch.ts`     — RFC 7644 PatchOp parser
 *   - `mapping.ts`   — SCIM ↔ resource bidirectional translation
 *   - `errors.ts`    — RFC 7644 §3.12 error envelope
 *
 * @example
 * ```typescript
 * import { scimPlugin } from '@classytic/arc/scim';
 *
 * await app.register(scimPlugin, {
 *   users: { resource: userResource },             // mapping defaults to BA shape
 *   groups: { resource: orgResource },
 *   bearer: process.env.SCIM_TOKEN,                // simple static
 *   // OR: verify: async (req) => verifyOidcToken(req.headers.authorization),
 * });
 * ```
 */

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { mountDiscoveryRoutes } from "./discovery.js";
import {
  ensureScimContentTypeParser,
  type MountedResource,
  makeAuthCheck,
  mergeMapping,
} from "./helpers.js";
import { DEFAULT_GROUP_MAPPING, DEFAULT_USER_MAPPING } from "./mapping.js";
import { mountResourceRoutes } from "./routes.js";
import type { ScimObservedEvent, ScimPluginOptions } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Public re-exports — single import surface for downstream consumers
// ─────────────────────────────────────────────────────────────────────

export { ScimError, type ScimType } from "./errors.js";
export type { FilterNode } from "./filter.js";
export { IDENTITY_MAP, parseScimFilter } from "./filter.js";
export {
  DEFAULT_GROUP_MAPPING,
  DEFAULT_USER_MAPPING,
  resourceToScim,
  SCIM_ENTERPRISE_USER_SCHEMA,
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  type ScimResourceMapping,
  scimToResource,
} from "./mapping.js";
export {
  parseScimPatch,
  type ScimPatchRequest,
  type ScimUpdate,
  scimUpdateToFlatPatch,
} from "./patch.js";
export type { ScimObservedEvent, ScimPluginOptions, ScimResourceBinding } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────

const scimPlugin: FastifyPluginAsync<ScimPluginOptions> = async (fastify, opts) => {
  if (!opts.users) {
    throw new Error("scimPlugin: `users` binding is required");
  }
  const prefix = opts.prefix ?? "/scim/v2";
  const maxResults = opts.maxResults ?? 200;
  const authCheck = makeAuthCheck(opts);
  const observe: (event: ScimObservedEvent) => void =
    opts.observe ??
    ((event) => {
      // Default — structured log line. Hosts pipe Pino → Loki / Datadog,
      // and metric exporters scrape `scim.*` patterns. No prom-client peer-dep.
      fastify.log?.info?.({ scim: event }, "scim.request");
    });

  ensureScimContentTypeParser(fastify);

  const usersMounted: MountedResource = {
    binding: opts.users,
    mapping: mergeMapping(DEFAULT_USER_MAPPING, opts.users.mapping),
    basePath: prefix,
  };
  mountResourceRoutes(fastify, "Users", usersMounted, authCheck, maxResults, observe);

  let hasGroups = false;
  if (opts.groups) {
    hasGroups = true;
    const groupsMounted: MountedResource = {
      binding: opts.groups,
      mapping: mergeMapping(DEFAULT_GROUP_MAPPING, opts.groups.mapping),
      basePath: prefix,
    };
    mountResourceRoutes(fastify, "Groups", groupsMounted, authCheck, maxResults, observe);
  }

  mountDiscoveryRoutes(fastify, prefix, hasGroups, authCheck, maxResults, observe);

  fastify.log?.debug?.(
    { prefix, hasGroups, auth: opts.bearer ? "bearer" : "verify" },
    "SCIM 2.0 plugin mounted",
  );
};

export default fp(scimPlugin, {
  name: "arc-scim",
  fastify: "5.x",
});

export { scimPlugin };
