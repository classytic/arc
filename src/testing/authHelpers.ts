/**
 * Better Auth Test Helpers
 *
 * Reusable primitives for testing Arc apps that use Better Auth.
 * Extracted from common patterns in app-level test setups.
 *
 * @example Basic helpers
 * ```typescript
 * import { createBetterAuthTestHelpers } from '@classytic/arc/testing';
 *
 * const auth = createBetterAuthTestHelpers();
 * const signup = await auth.signUp(app, { email: 'test@example.com', password: 'pass', name: 'Test' });
 * const headers = auth.authHeaders(signup.token, orgId);
 * ```
 *
 * @example Full org setup
 * ```typescript
 * import { setupBetterAuthOrg } from '@classytic/arc/testing';
 *
 * const ctx = await setupBetterAuthOrg({
 *   createApp: () => createAppInstance(),
 *   org: { name: 'Test Corp', slug: 'test-corp' },
 *   users: [
 *     { key: 'admin', email: 'admin@test.com', password: 'pass', name: 'Admin', role: 'admin', isCreator: true },
 *     { key: 'member', email: 'user@test.com', password: 'pass', name: 'User', role: 'member' },
 *   ],
 *   addMember: async (data) => { await auth.api.addMember({ body: data }); return { statusCode: 200 }; },
 * });
 *
 * // ctx.app, ctx.orgId, ctx.users.admin.token, ctx.teardown()
 * ```
 */

import type { FastifyInstance } from "fastify";

// ============================================================================
// Types
// ============================================================================

export interface BetterAuthTestHelpersOptions {
  /** Base path for auth routes (default: '/api/auth') */
  basePath?: string;
}

export interface AuthResponse {
  statusCode: number;
  token: string;
  user: any;
  body: any;
}

export interface OrgResponse {
  statusCode: number;
  orgId: string;
  body: any;
}

export interface BetterAuthTestHelpers {
  signUp(
    app: FastifyInstance,
    data: { email: string; password: string; name: string },
  ): Promise<AuthResponse>;
  signIn(app: FastifyInstance, data: { email: string; password: string }): Promise<AuthResponse>;
  createOrg(
    app: FastifyInstance,
    token: string,
    data: { name: string; slug: string },
  ): Promise<OrgResponse>;
  setActiveOrg(
    app: FastifyInstance,
    token: string,
    orgId: string,
  ): Promise<{ statusCode: number; body: any }>;
  authHeaders(token: string, orgId?: string): Record<string, string>;
}

export interface TestUserContext {
  token: string;
  userId: string;
  email: string;
}

export interface TestOrgContext<T = Record<string, TestUserContext>> {
  app: FastifyInstance;
  orgId: string;
  users: T;
  teardown: () => Promise<void>;
}

export interface SetupUserConfig {
  /** Key used to reference this user in the context (e.g. 'admin', 'member') */
  key: string;
  email: string;
  password: string;
  name: string;
  /** Organization role assigned after joining */
  role: string;
  /** If true, this user creates the org (becomes org owner). Exactly one user should have this. */
  isCreator?: boolean;
}

export interface SetupBetterAuthOrgOptions {
  /** Factory function to create the Fastify app instance */
  createApp: () => Promise<FastifyInstance>;
  /** Organization to create */
  org: { name: string; slug: string };
  /** Users to create and add to the organization */
  users: SetupUserConfig[];
  /**
   * Callback to add a member to the org.
   * Apps wire Better Auth differently — some use auth.api.addMember, others use HTTP.
   */
  addMember: (data: {
    organizationId: string;
    userId: string;
    role: string;
  }) => Promise<{ statusCode: number }>;
  /**
   * Optional hook for app-specific initialization after all users are set up.
   * Use this for things like recruiter→account manager hierarchy.
   */
  afterSetup?: (ctx: TestOrgContext) => Promise<void>;
  /** Override auth helper options (e.g. custom basePath) */
  authHelpers?: BetterAuthTestHelpersOptions;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Safely parse a JSON response body.
 * Returns null if parsing fails.
 */
export function safeParseBody(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ============================================================================
// Better Auth Test Helpers Factory
// ============================================================================

/**
 * Create stateless Better Auth test helpers.
 *
 * All methods take the app instance as a parameter, making them
 * safe to use across multiple test suites.
 */
export function createBetterAuthTestHelpers(
  options: BetterAuthTestHelpersOptions = {},
): BetterAuthTestHelpers {
  const basePath = options.basePath ?? "/api/auth";

  return {
    async signUp(app, data) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/sign-up/email`,
        payload: data,
      });
      const token = res.headers["set-auth-token"] as string | undefined;
      const body = safeParseBody(res.body);
      return {
        statusCode: res.statusCode,
        token: token || "",
        user: body?.user || body,
        body,
      };
    },

    async signIn(app, data) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/sign-in/email`,
        payload: data,
      });
      const token = res.headers["set-auth-token"] as string | undefined;
      const body = safeParseBody(res.body);
      return {
        statusCode: res.statusCode,
        token: token || "",
        user: body?.user || body,
        body,
      };
    },

    async createOrg(app, token, data) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/organization/create`,
        headers: { authorization: `Bearer ${token}` },
        payload: data,
      });
      const body = safeParseBody(res.body);
      return {
        statusCode: res.statusCode,
        orgId: body?.id,
        body,
      };
    },

    async setActiveOrg(app, token, orgId) {
      const res = await app.inject({
        method: "POST",
        url: `${basePath}/organization/set-active`,
        headers: { authorization: `Bearer ${token}` },
        payload: { organizationId: orgId },
      });
      return {
        statusCode: res.statusCode,
        body: safeParseBody(res.body),
      };
    },

    authHeaders(token, orgId?) {
      const h: Record<string, string> = { authorization: `Bearer ${token}` };
      if (orgId) h["x-organization-id"] = orgId;
      return h;
    },
  };
}

// ============================================================================
// Composite Org Setup
// ============================================================================

/**
 * Set up a complete test organization with users.
 *
 * Creates the app, signs up users, creates an org, adds members,
 * and returns a context object with tokens and a teardown function.
 *
 * @example
 * ```typescript
 * const ctx = await setupBetterAuthOrg({
 *   createApp: () => createAppInstance(),
 *   org: { name: 'Test Corp', slug: 'test-corp' },
 *   users: [
 *     { key: 'admin', email: 'admin@test.com', password: 'pass', name: 'Admin', role: 'admin', isCreator: true },
 *     { key: 'member', email: 'user@test.com', password: 'pass', name: 'User', role: 'member' },
 *   ],
 *   addMember: async (data) => {
 *     await auth.api.addMember({ body: data });
 *     return { statusCode: 200 };
 *   },
 * });
 *
 * // Use in tests:
 * const res = await ctx.app.inject({
 *   method: 'GET',
 *   url: '/api/products',
 *   headers: auth.authHeaders(ctx.users.admin.token, ctx.orgId),
 * });
 *
 * // Cleanup:
 * await ctx.teardown();
 * ```
 */
export async function setupBetterAuthOrg(
  options: SetupBetterAuthOrgOptions,
): Promise<TestOrgContext> {
  const {
    createApp,
    org,
    users: userConfigs,
    addMember,
    afterSetup,
    authHelpers: helpersOptions,
  } = options;

  const helpers = createBetterAuthTestHelpers(helpersOptions);

  // Validate: exactly one creator
  const creators = userConfigs.filter((u) => u.isCreator);
  if (creators.length !== 1) {
    throw new Error(
      `setupBetterAuthOrg: Exactly one user must have isCreator: true (found ${creators.length})`,
    );
  }

  // 1. Create app
  const app = await createApp();
  await app.ready();

  // 2. Sign up all users
  const signups = new Map<string, AuthResponse>();
  for (const userConfig of userConfigs) {
    const signup = await helpers.signUp(app, {
      email: userConfig.email,
      password: userConfig.password,
      name: userConfig.name,
    });
    if (signup.statusCode !== 200) {
      throw new Error(
        `setupBetterAuthOrg: Failed to sign up ${userConfig.email} (status ${signup.statusCode})`,
      );
    }
    signups.set(userConfig.key, signup);
  }

  // 3. Create org (by the creator)
  const creatorConfig = creators[0]!;
  const creatorSignup = signups.get(creatorConfig.key)!;
  const orgResult = await helpers.createOrg(app, creatorSignup.token, org);
  if (orgResult.statusCode !== 200) {
    throw new Error(`setupBetterAuthOrg: Failed to create org (status ${orgResult.statusCode})`);
  }
  const orgId = orgResult.orgId;

  // 4. Add non-creator members
  for (const userConfig of userConfigs) {
    if (userConfig.isCreator) continue;
    const signup = signups.get(userConfig.key)!;
    const result = await addMember({
      organizationId: orgId,
      userId: signup.user?.id,
      role: userConfig.role,
    });
    if (result.statusCode !== 200) {
      throw new Error(
        `setupBetterAuthOrg: Failed to add member ${userConfig.email} (status ${result.statusCode})`,
      );
    }
  }

  // 5. Set active org + re-login to get fresh tokens
  await helpers.setActiveOrg(app, creatorSignup.token, orgId);

  const users: Record<string, TestUserContext> = {};
  for (const userConfig of userConfigs) {
    if (userConfig.isCreator) {
      const signup = signups.get(userConfig.key)!;
      users[userConfig.key] = {
        token: signup.token,
        userId: signup.user?.id,
        email: userConfig.email,
      };
    } else {
      // Re-login to get token with org context
      const login = await helpers.signIn(app, {
        email: userConfig.email,
        password: userConfig.password,
      });
      await helpers.setActiveOrg(app, login.token, orgId);
      users[userConfig.key] = {
        token: login.token,
        userId: signups.get(userConfig.key)?.user?.id,
        email: userConfig.email,
      };
    }
  }

  const ctx: TestOrgContext = {
    app,
    orgId,
    users,
    async teardown() {
      await app.close();
    },
  };

  // 6. Run app-specific post-setup
  if (afterSetup) {
    await afterSetup(ctx);
  }

  return ctx;
}
