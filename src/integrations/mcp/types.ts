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

/** Context passed to tool handlers at invocation time */
export interface ToolContext {
  /** Session identity — null in no-auth mode */
  session: McpAuthResult | null;
  /** Log to MCP client (best-effort, non-blocking) */
  log: (level: "info" | "warning" | "error" | "debug", message: string) => Promise<void>;
  /** Raw MCP SDK extra context (for advanced use) */
  extra: Record<string, unknown>;
}

/** MCP CallToolResult — return type from tool handlers */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Output of defineTool() — plain data, not yet registered on a server.
 *
 * `inputSchema` is a flat Zod shape `{ name: z.string(), age: z.number() }` —
 * the SDK wraps it in z.object() internally. Do NOT pass z.object() here.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  title?: string;
  /** Flat Zod shape: `{ field: z.string() }`. NOT z.object(). */
  inputSchema?: Record<string, z.ZodTypeAny>;
  /** Flat Zod shape for structured output validation */
  outputSchema?: Record<string, z.ZodTypeAny>;
  annotations?: ToolAnnotations;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;
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

/** Per-resource MCP configuration overrides */
export interface McpResourceConfig {
  /** Which CRUD operations to expose (default: all enabled on the resource) */
  operations?: CrudOperation[];
  /** Override tool descriptions per operation */
  descriptions?: Partial<Record<CrudOperation, string>>;
  /** Fields to hide from MCP tool schemas (beyond schemaOptions.hiddenFields) */
  hideFields?: string[];
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
  /** Resources to exclude by name */
  exclude?: string[];
  /** Tool name prefix: 'crm' → 'crm_list_products' */
  toolNamePrefix?: string;
  /** Per-resource overrides */
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
  userId: string;
  organizationId?: string;
  /** User roles (global) — used by guard helpers like requireRole() */
  roles?: string[];
  /** Org-level roles — used by guard helpers */
  orgRoles?: string[];
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
