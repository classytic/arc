/**
 * @classytic/arc — MCP Integration Types
 *
 * All TypeScript interfaces for the MCP (Model Context Protocol) integration.
 * Zod is a peer dependency — types reference it but don't import it.
 * The MCP SDK is also a peer dep — only loaded when mcpPlugin is registered.
 */

import type { z } from "zod";
import type { ResourceDefinition } from "../../core/defineResource.js";

// ============================================================================
// Tool & Prompt Definitions
// ============================================================================

/** Behavioral hints for MCP clients (tool annotations per MCP spec) */
export interface ToolAnnotations {
  /** Tool only reads data, no side effects */
  readOnlyHint?: boolean;
  /** Tool may perform destructive/irreversible actions */
  destructiveHint?: boolean;
  /** Tool can be safely retried with same input */
  idempotentHint?: boolean;
  /** Tool interacts with external systems beyond this server */
  openWorldHint?: boolean;
}

/**
 * Context passed to tool handlers at invocation time.
 *
 * The `TSession` parameter widens `session` to a host-specific shape — pass
 * an interface that extends `McpAuthResult` (or omits it entirely for fully
 * custom auth resolvers) to drop the `as any` casts at call sites:
 *
 * ```ts
 * interface MySession extends McpAuthResult {
 *   userId: string;            // required, not optional
 *   organizationId: string;
 *   tenantPlan: 'free' | 'pro';
 * }
 *
 * defineTool<MySession>('upgrade', {
 *   handler: async (_input, ctx) => {
 *     ctx.session?.tenantPlan;  // typed, no cast
 *   },
 * });
 * ```
 */
export interface ToolContext<TSession = McpAuthResult> {
  /** Session identity — `null` in no-auth mode */
  session: TSession | null;
  /** Log to MCP client (best-effort, non-blocking) */
  log: (level: "info" | "warning" | "error" | "debug", message: string) => Promise<void>;
  /** Raw MCP SDK extra context (for advanced use) */
  extra: Record<string, unknown>;
}

/**
 * MCP CallToolResult — return type from tool handlers.
 *
 * `content` follows the MCP spec: at minimum a text item, optionally other
 * resource/image content types. The fallback union member allows future
 * MCP spec additions without breaking existing handlers.
 *
 * @example
 * ```typescript
 * return { content: [{ type: 'text', text: JSON.stringify(result) }] };
 * return { content: [{ type: 'text', text: 'Not found' }], isError: true };
 * ```
 */
export interface CallToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
    | { type: string; [key: string]: unknown }
  >;
  isError?: boolean;
  /** Structured output for typed tool results (MCP spec extension) */
  structuredContent?: unknown;
}

/**
 * Output of defineTool() — plain data, not yet registered on a server.
 *
 * `inputSchema` is a flat Zod shape `{ name: z.string(), age: z.number() }` —
 * the SDK wraps it in z.object() internally. Do NOT pass z.object() here.
 *
 * The `TSession` parameter lets hosts widen the session shape on the
 * handler — same generic the `defineTool()` builder accepts.
 */
export interface ToolDefinition<TSession = McpAuthResult> {
  name: string;
  description: string;
  title?: string;
  /** Flat Zod shape: `{ field: z.string() }`. NOT z.object(). */
  inputSchema?: Record<string, z.ZodTypeAny>;
  /** Flat Zod shape for structured output validation */
  outputSchema?: Record<string, z.ZodTypeAny>;
  annotations?: ToolAnnotations;
  handler: (input: Record<string, unknown>, ctx: ToolContext<TSession>) => Promise<CallToolResult>;
  /**
   * Origin label used by collision diagnostics — names BOTH the resource
   * and the surface that produced this tool (`'crud:post:list'`,
   * `'action:post:approve'`, `'route:post:GET /export'`,
   * `'preset:softDelete:post:restore'`). When two tools share a name,
   * `createMcpServer()` prints both labels so the host can see which
   * surfaces collided without spelunking through the MCP SDK's stack
   * trace. Optional — hand-written tools without a `source` simply
   * appear as `'(unknown)'` in collision messages.
   */
  source?: string;
}

/** Output of definePrompt() — plain data, not yet registered */
export interface PromptDefinition {
  name: string;
  description: string;
  title?: string;
  /** Flat Zod shape for prompt arguments */
  argsSchema?: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => PromptResult;
}

/** Prompt handler return type */
export interface PromptResult {
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string } | { type: string; [key: string]: unknown };
  }>;
}

// ============================================================================
// Plugin Options
// ============================================================================

/**
 * Metadata threaded into a function-form description override so authors
 * can produce a context-aware description without re-deriving filter /
 * sort / operator lists from the resource definition by hand.
 *
 * Equivalent to the inputs `defaultCrudDescription()` consumes — the
 * default description is also passed (`defaultDescription`) so authors
 * can prepend or append to it without duplicating Arc's auto-derived
 * filterable-fields blurb.
 */
export interface CrudDescriptionMeta {
  readonly operation: CrudOperation;
  /** Resource display name (e.g. `Posts`) — Arc derives this from `defineResource`. */
  readonly displayName: string;
  readonly softDelete: boolean;
  /** Pre-rendered default description Arc would have used. */
  readonly defaultDescription: string;
  readonly filterableFields?: readonly string[];
  readonly allowedOperators?: readonly string[];
  readonly sortableFields?: readonly string[];
}

/**
 * Override shape for a single CRUD tool description.
 *
 * - `string` — replace the default outright.
 * - Function — receives the auto-rendered default plus the same metadata
 *   `defaultCrudDescription()` consumes, returns a final string. Use this
 *   to append context (`'Note: prefer isActive: true'`) without losing
 *   Arc's auto-derived filterable-fields blurb.
 */
export type CrudDescriptionOverride = string | ((meta: CrudDescriptionMeta) => string);

/**
 * Execution wiring for MCP tools — the app-level services HTTP requests
 * receive via Fastify decorators (`fastify.arc.hooks`, `fastify.events`,
 * `fastify.audit`, `fastify.log`, `fastify.idempotency`) and MCP's
 * synthetic-context path historically dropped.
 *
 * When present, tool handlers thread it into the request context so the
 * controller pipeline achieves FULL HTTP parity: resource hooks run
 * (before/around/after), the arcCorePlugin after-hook publishes
 * `<resource>.<op>d` events (→ realtime feeds, webhooks, event-driven
 * cache invalidation all see MCP-originated mutations), `ctx.server.*`
 * works inside handlers, and mutating CRUD tools accept an optional
 * `_idempotencyKey` input for retry-safe execution.
 *
 * `mcpPlugin` builds this automatically from its Fastify instance (lazy
 * getters — decorator registration order doesn't matter). Standalone
 * `resourceToTools()` / `createMcpServer()` callers pass their own, or
 * omit it to keep the legacy dispatch-only behavior.
 */
export interface McpExecutionWiring {
  /** Shared `HookSystem` — `fastify.arc.hooks`. */
  readonly hooks?: unknown;
  /** Event bus decorator — `fastify.events`. */
  readonly events?: unknown;
  /** Audit decorator — `fastify.audit`. */
  readonly audit?: unknown;
  /** Structured logger — `fastify.log`. */
  readonly log?: unknown;
  /**
   * Idempotency store (the `IdempotencyStore` contract from
   * `@classytic/arc/idempotency`). Presence advertises `_idempotencyKey`
   * on mutating CRUD tools and enables executor-level check/lock/replay.
   */
  readonly idempotencyStore?: unknown;
}

/** Per-resource MCP configuration overrides */
export interface McpResourceConfig {
  /** Which CRUD operations to expose (default: all enabled on the resource) */
  operations?: CrudOperation[];
  /**
   * Override tool descriptions per operation.
   *
   * Each entry is either a plain replacement string OR a function
   * `(meta) => string` that receives the auto-rendered default plus the
   * filterable / sortable metadata Arc would have used. Use the function
   * form to extend the default without losing the auto-derived blurb:
   *
   * ```ts
   * descriptions: {
   *   list: ({ defaultDescription }) =>
   *     `${defaultDescription} Sort by createdAt desc for newest first.`,
   * }
   * ```
   */
  descriptions?: Partial<Record<CrudOperation, CrudDescriptionOverride>>;
  /** Fields to hide from MCP tool schemas (beyond schemaOptions.hiddenFields) */
  hideFields?: string[];
  /** Per-operation tool name overrides: `{ get: 'get_job_by_id' }` */
  names?: Partial<Record<CrudOperation, string>>;
  /** Per-resource tool name prefix (overrides global `toolNamePrefix`): `'db'` → `db_list_jobs` */
  toolNamePrefix?: string;
}

/**
 * Auth resolver function — user provides their own auth logic.
 * Receives request headers, returns identity or null (unauthorized).
 *
 * @example
 * ```ts
 * // API key auth
 * auth: async (headers) => {
 *   if (headers['x-api-key'] !== process.env.MCP_API_KEY) return null;
 *   return { userId: 'service-account', organizationId: 'org-123' };
 * },
 *
 * // Static org (trusted internal network)
 * auth: async () => ({ userId: 'internal', organizationId: 'org-main' }),
 *
 * // Gateway-validated JWT (token already verified by API gateway)
 * auth: async (headers) => {
 *   const userId = headers['x-user-id'];
 *   const orgId = headers['x-org-id'];
 *   return userId ? { userId, organizationId: orgId } : null;
 * },
 * ```
 */
export type McpAuthResolver = (
  headers: Record<string, string | undefined>,
) => Promise<McpAuthResult | null> | McpAuthResult | null;

/**
 * mcpPlugin() options — Fastify plugin config.
 *
 * @example
 * ```ts
 * // No auth (dev/testing)
 * await app.register(mcpPlugin, { resources, auth: false });
 *
 * // Better Auth OAuth 2.1
 * await app.register(mcpPlugin, { resources, auth: getAuth() });
 *
 * // Custom auth function (API key, gateway headers, etc.)
 * await app.register(mcpPlugin, {
 *   resources,
 *   auth: async (headers) => {
 *     if (headers['x-api-key'] !== process.env.MCP_KEY) return null;
 *     return { userId: 'bot', organizationId: 'org-1' };
 *   },
 * });
 * ```
 */
export interface McpPluginOptions {
  /** Arc resources to expose as MCP tools */
  resources: ResourceDefinition[];
  /**
   * Auth mode:
   * - `false` — no auth, anonymous access (default)
   * - `BetterAuthHandler` — OAuth 2.1 via Better Auth's mcp() plugin
   * - `McpAuthResolver` — custom function that resolves identity from headers
   */
  auth?: BetterAuthHandler | McpAuthResolver | false;
  /** MCP endpoint path (default: '/mcp') */
  prefix?: string;
  /** Server identity */
  serverName?: string;
  serverVersion?: string;
  /** Instructions for the LLM — guidance on tool usage, constraints */
  instructions?: string;
  /**
   * Resources to exclude by name (ignored if `expose`/`include` is set).
   *
   * Drift-prone for LLM-facing surfaces: a new `defineResource()` is exposed
   * by default and you have to remember to add it here. Prefer `expose` when
   * the principle of least authority matters.
   */
  exclude?: string[];
  /**
   * Default-deny allowlist — only resources whose names appear here are
   * surfaced to MCP. New `defineResource()` calls are auto-denied (the
   * inverse of `exclude`), matching the principle-of-least-authority that
   * LLM-driven tool surfaces want.
   *
   * Mutually exclusive with `include` (a deprecated alias) — passing both
   * throws at registration. Mutually exclusive with `exclude`: the deny
   * default would render the exclude list redundant; passing both throws
   * with a hint to drop `exclude`.
   *
   * @example
   * ```ts
   * await app.register(mcpPlugin, { resources, expose: ['post'] });
   * ```
   */
  expose?: string[];
  /** Tool name prefix: 'crm' → 'crm_list_products' */
  toolNamePrefix?: string;
  /** Per-resource overrides (operations, descriptions, hideFields, names, toolNamePrefix) */
  overrides?: Record<string, McpResourceConfig>;
  /** Hand-written tools added alongside auto-generated ones */
  extraTools?: ToolDefinition[];
  /** Custom prompts */
  extraPrompts?: PromptDefinition[];
  /**
   * Session mode:
   * - `false` (default) — stateless, fresh server per request. Best for production, scaling, serverless.
   * - `true` — stateful, sessions cached with TTL. Use for server-initiated notifications or long-lived connections.
   */
  stateful?: boolean;
  /** Session TTL in ms (default: 1800000 = 30 min). Only used when stateful: true. */
  sessionTtlMs?: number;
  /** Max concurrent sessions (default: 1000). Only used when stateful: true. */
  maxSessions?: number;
  /**
   * Auth cache TTL in ms for stateless mode (default: 5000 = 5 sec).
   * Caches auth resolver results briefly to avoid redundant DB lookups
   * across initialize → tools/list → tools/call sequences.
   * Set to `0` to disable.
   */
  authCacheTtlMs?: number;
}

// ============================================================================
// Auth
// ============================================================================

/** Minimal Better Auth handler interface for MCP session validation */
export interface BetterAuthHandler {
  api: {
    getMcpSession: (opts: {
      headers: Record<string, string | undefined>;
    }) => Promise<McpSession | null>;
  };
  handler: (request: Request) => Promise<Response>;
}

/** Session from Better Auth's getMcpSession() */
export interface McpSession {
  userId: string;
  clientId: string;
  scopes: string;
  activeOrganizationId?: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** Resolved auth identity for a single MCP request */
export interface McpAuthResult {
  /**
   * Human user ID. Optional for service/machine principals — when `clientId`
   * is set and `userId` is omitted, the principal is purely machine-identity
   * and `ctx.user` will be `null` (not a synthetic user object).
   */
  userId?: string;
  organizationId?: string;
  /** User roles (global) — used by guard helpers like requireRole() */
  roles?: string[];
  /** Org-level roles — used by guard helpers */
  orgRoles?: string[];
  /**
   * OAuth client ID — set this to enable `kind: "service"` scope.
   * When present, buildRequestContext produces a service scope instead
   * of member/authenticated, enabling `requireServiceScope()` checks.
   */
  clientId?: string;
  /**
   * OAuth scopes (e.g. `['read:products', 'write:orders']`).
   * Carried on the `service` RequestScope for fine-grained permission checks.
   */
  scopes?: readonly string[];
  /**
   * Active team — carried onto a `member` scope so `getTeamId()` answers the
   * same on MCP as on HTTP. Member-only, like the HTTP surface.
   */
  teamId?: string;
  /**
   * Host-defined scope dimensions (`branchId`, `projectId`, `region`, …),
   * carried onto `member` / `service` scopes.
   *
   * Declared explicitly because `requireScopeContext()` AUTHORISES against
   * these: a resource gated on `branchId` denies every MCP call until the
   * resolver supplies it. Non-string entries are dropped rather than coerced.
   */
  context?: Record<string, string>;
  /** Any extra metadata from the auth resolver */
  [key: string]: unknown;
}

// ============================================================================
// Session Cache
// ============================================================================

/** Internal session entry */
export interface SessionEntry {
  transport: {
    handleRequest: (req: unknown, res: unknown, body?: unknown) => Promise<void>;
    close: () => void;
  };
  lastAccessed: number;
  organizationId: string;
  auth: McpAuthResult | null;
  /** Mutable ref updated per-request — tool handler closures read from this */
  authRef: { current: McpAuthResult | null };
}

// ============================================================================
// createMcpServer config
// ============================================================================

/**
 * Configuration for createMcpServer() — Level 2 declarative factory.
 *
 * @example
 * ```ts
 * const server = await createMcpServer({
 *   name: 'my-api',
 *   version: '1.0.0',
 *   instructions: 'Use list_users to browse users.',
 *   tools: [
 *     defineTool('greet', {
 *       description: 'Say hello',
 *       input: { name: z.string() },
 *       handler: async ({ name }) => ({ content: [{ type: 'text', text: `Hello ${name}` }] }),
 *     }),
 *   ],
 * });
 * ```
 */
export interface CreateMcpServerConfig {
  name: string;
  version?: string;
  instructions?: string;
  tools?: ToolDefinition[];
  prompts?: PromptDefinition[];
}

/** CRUD operation type */
export type CrudOperation = "list" | "get" | "create" | "update" | "delete";
