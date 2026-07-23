/**
 * @classytic/arc — Better Auth API-key → MCP auth resolver factory
 *
 * Wraps `auth.api.verifyApiKey(...)` into an {@link McpAuthResolver} so
 * hosts wiring Better Auth's API-key plugin to MCP don't reimplement
 * the same five lines. Handles the two field-name traps the manual
 * wiring keeps hitting:
 *
 *   1. **`key.referenceId` vs `key.userId`** — `referenceId` is the
 *      canonical user binding (it's the column Better Auth's schema
 *      writes), but some plugin versions expose only `userId`, and
 *      service-account keys often have neither. The helper falls back
 *      through `key.userId → key.referenceId → undefined` and treats a
 *      key with only `clientId` metadata as a service-principal (matches
 *      arc's `kind: "service"` scope).
 *
 *   2. **Organization scope lives in metadata** — Better Auth's API-key
 *      record has no `organizationId` column; hosts stamp it into
 *      `metadata.organizationId` at creation. The helper extracts that
 *      key by default; pass `{ orgFromMetadata: fn }` for a custom path.
 *
 * Honours the same precedence as arc's REST auth: `Authorization: Bearer`
 * is checked first, then `x-api-key`. Returns `null` (not throw) on miss
 * so the caller's fail-closed policy applies uniformly.
 *
 * @example
 * ```ts
 * import { mcpPlugin } from '@classytic/arc/mcp';
 * import { createMcpAuthFromBetterAuthApiKey } from '@classytic/arc/mcp';
 * import { auth } from './auth.js';
 *
 * await app.register(mcpPlugin, {
 *   resources,
 *   auth: createMcpAuthFromBetterAuthApiKey(auth),
 * });
 * ```
 */

import type { BetterAuthHandler, McpAuthResolver, McpAuthResult } from "./types.js";

/** Minimal subset of Better Auth's API-key record the helper needs. */
interface BetterAuthKeyRecord {
  id?: string;
  userId?: string;
  referenceId?: string;
  metadata?: unknown;
  permissions?: unknown;
  scopes?: unknown;
  expiresAt?: string | Date | null;
  disabled?: boolean;
  name?: string | null;
}

/** Shape `auth.api.verifyApiKey` returns on a hit. */
interface VerifyApiKeyResult {
  valid?: boolean;
  key?: BetterAuthKeyRecord | null;
  error?: { code?: string; message?: string } | null;
}

/** Better Auth handler augmented with the optional API-key surface. */
type BetterAuthWithApiKey = BetterAuthHandler & {
  api: BetterAuthHandler["api"] & {
    verifyApiKey?: (opts: {
      body: { key: string };
      headers?: Record<string, string | undefined>;
    }) => Promise<VerifyApiKeyResult | null>;
  };
};

export interface CreateMcpAuthFromBetterAuthApiKeyOptions {
  /**
   * How to resolve the organization id from a verified key.
   *
   * - `true` (default) — read `key.metadata.organizationId`.
   * - `false` — never set `organizationId` (single-tenant deployments).
   * - `(metadata, key) => string | undefined` — custom extractor, e.g.
   *   `(m) => m?.tenantId` for hosts that named the column differently.
   */
  orgFromMetadata?: boolean | ((metadata: unknown, key: BetterAuthKeyRecord) => string | undefined);
  /**
   * Field name on `metadata` that holds the org id. Default
   * `"organizationId"`. Ignored when `orgFromMetadata` is a function.
   */
  metadataOrgField?: string;
  /**
   * Permission scope name inside `key.permissions` that should be flattened
   * onto `McpAuthResult.scopes`. Default `"mcp"` — matches Better Auth's
   * docs example. Set to `false` to keep scopes empty.
   */
  permissionScope?: string | false;
}

/**
 * Build an {@link McpAuthResolver} that authenticates MCP requests against
 * Better Auth's API-key plugin. See module docstring for the rationale.
 */
export function createMcpAuthFromBetterAuthApiKey(
  auth: BetterAuthHandler,
  options: CreateMcpAuthFromBetterAuthApiKeyOptions = {},
): McpAuthResolver {
  const augmented = auth as BetterAuthWithApiKey;
  const verifyApiKey = augmented.api?.verifyApiKey;
  if (typeof verifyApiKey !== "function") {
    throw new Error(
      "createMcpAuthFromBetterAuthApiKey: the provided Better Auth instance does not expose " +
        "`api.verifyApiKey`. Register the `apiKey()` plugin on your auth instance " +
        "(see https://www.better-auth.com/docs/plugins/api-key) and pass the same `auth` " +
        "object you pass to your REST routes.",
    );
  }

  const orgFromMetadata = options.orgFromMetadata ?? true;
  const metadataOrgField = options.metadataOrgField ?? "organizationId";
  const permissionScope = options.permissionScope === undefined ? "mcp" : options.permissionScope;

  return async (headers) => {
    const apiKey = extractApiKey(headers);
    if (!apiKey) return null;

    let result: VerifyApiKeyResult | null;
    try {
      result = await verifyApiKey({
        body: { key: apiKey },
        headers,
      });
    } catch {
      return null;
    }

    if (!result?.valid || !result.key) return null;
    const key = result.key;

    // Disabled / expired guards — Better Auth's verifier should catch
    // these, but the v1.6.x plugin has a known race where a key
    // rotated mid-request still validates against the prior cache slot.
    // A second-line check here is cheap.
    if (key.disabled === true) return null;
    if (key.expiresAt) {
      const exp = key.expiresAt instanceof Date ? key.expiresAt : new Date(key.expiresAt);
      if (Number.isFinite(exp.getTime()) && exp.getTime() < Date.now()) return null;
    }

    const userId = key.userId ?? key.referenceId;
    const organizationId = resolveOrg(key, orgFromMetadata, metadataOrgField);
    const scopes = resolveScopes(key, permissionScope);
    const clientId = !userId && key.id ? key.id : undefined;

    // A key with neither a user binding nor a key id is unusable — refuse
    // rather than emit an unprincipled `{}` session. This shouldn't
    // happen with a sane schema, but guards a misconfigured plugin.
    if (!userId && !clientId) return null;

    const out: McpAuthResult = {
      ...(userId ? { userId } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(scopes?.length ? { scopes } : {}),
    };
    return out;
  };
}

// ============================================================================
// Helpers
// ============================================================================

function extractApiKey(headers: Record<string, string | undefined>): string | null {
  const authz = headers.authorization ?? headers.Authorization;
  if (typeof authz === "string" && authz.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(authz);
    const token = match?.[1];
    if (token) return token.trim();
  }
  const direct = headers["x-api-key"] ?? headers["X-Api-Key"];
  if (typeof direct === "string" && direct.length > 0) return direct.trim();
  return null;
}

function resolveOrg(
  key: BetterAuthKeyRecord,
  setting: NonNullable<CreateMcpAuthFromBetterAuthApiKeyOptions["orgFromMetadata"]>,
  field: string,
): string | undefined {
  if (setting === false) return undefined;
  const metadata = parseMetadata(key.metadata);
  if (typeof setting === "function") {
    const value = setting(metadata, key);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  if (metadata && typeof metadata === "object") {
    const raw = (metadata as Record<string, unknown>)[field];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

function resolveScopes(
  key: BetterAuthKeyRecord,
  scopeKey: string | false,
): readonly string[] | undefined {
  if (scopeKey === false) return undefined;
  const permissions = parseMetadata(key.permissions);
  if (permissions && typeof permissions === "object") {
    const bucket = (permissions as Record<string, unknown>)[scopeKey];
    if (Array.isArray(bucket) && bucket.every((s) => typeof s === "string")) {
      return bucket as readonly string[];
    }
  }
  // Fallback — some hosts store flat `scopes: string[]` on the key.
  if (Array.isArray(key.scopes) && key.scopes.every((s) => typeof s === "string")) {
    return key.scopes as readonly string[];
  }
  return undefined;
}

/**
 * Better Auth stores `metadata` and `permissions` as JSON-stringified
 * columns in SQL kits. Accept both shapes — already-parsed objects pass
 * through, strings round-trip through `JSON.parse`. Failures yield
 * `undefined` rather than throwing because malformed metadata should
 * degrade gracefully (key still authenticates; org scope is absent).
 */
function parseMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}
