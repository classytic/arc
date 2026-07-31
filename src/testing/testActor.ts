/**
 * Test-only actor installation — how a package's HTTP tests say "run this
 * request as a manager in org X".
 *
 * Identity in arc comes from `request.scope` and only from `request.scope`;
 * headers like `x-role` are not identity. That rule left tests with no seam —
 * `bootModuleApp` boots with `auth: false`, so every injected request arrived as
 * `PUBLIC_SCOPE` and any role-gated route answered 401 with no supported way to
 * be somebody.
 *
 * The `x-test-actor` header is a TRANSPORT for the test's intent, not a trusted
 * claim. The authenticator that reads it is installed by `bootModuleApp` alone,
 * behind the `@classytic/arc/testing` entrypoint; `createApp` never registers
 * it, so no production build turns a forged header into identity. It is
 * per-request rather than boot-only because the interesting authorization tests
 * are the ones where a cashier is refused what a manager is allowed.
 *
 * Gate the routes under test with arc's own primitives — `requireRoles`,
 * `requireOrgMembership`, `allOf(...)`. A test-specific gate would be a second
 * implementation of authorization whose semantics could drift from the one
 * actually shipping.
 */

import { getUserId, type RequestScope } from "../scope/types.js";

/** The header the testing harness uses to carry a request's actor. */
export const TEST_ACTOR_HEADER = "x-test-actor";

/**
 * What a test wants to be. An `organizationId` produces a `member` scope (the
 * org-scoped case); without one the actor is `authenticated`.
 */
export interface TestActor {
  /**
   * Defaults to a synthetic id derived from the roles. Pass one explicitly when
   * a test distinguishes two actors — ownership and audit assertions do, and
   * two actors sharing roles would otherwise share an id.
   */
  userId?: string;
  /** Global roles — what `requireRoles` reads. */
  roles?: string[];
  /** Tenant. Present ⇒ a `member` scope. */
  organizationId?: string;
  /** Org-level roles from membership records. Defaults to `roles`. */
  orgRoles?: string[];
  teamId?: string;
  /** App-defined dimensions (branch, project, region) read via `getScopeContext`. */
  context?: Record<string, string>;
  /**
   * Elevated (platform-admin) scope. The value is the `elevatedBy` audit string
   * arc requires — an elevated scope must record who granted it. `true` is
   * shorthand for `'test'`.
   *
   * An elevated scope carries no roles: elevation is a different kind of actor,
   * not a role. A test needing a role gate AND elevation wants `member`.
   */
  elevated?: string | boolean;
}

/**
 * Build the headers that make an injected request act as `actor`.
 *
 * A string is shorthand for a single role. `null` means "stay public", so a test
 * can prove an endpoint is reachable anonymously.
 *
 * @example
 * ```ts
 * t.app.inject({ method: 'GET', url: '/pos/shifts/current',
 *   headers: testActorHeaders('manager', ORG) });
 * ```
 */
export function testActorHeaders(
  actor: TestActor | string | null,
  organizationId?: string,
): Record<string, string> {
  if (actor === null) return {};
  const org = organizationId !== undefined ? { organizationId } : {};
  const spec: TestActor =
    typeof actor === "string" ? { roles: [actor], ...org } : { ...actor, ...org };
  return { [TEST_ACTOR_HEADER]: JSON.stringify(spec) };
}

/**
 * Turn a spec into a `RequestScope`.
 *
 * `orgRoles` defaults to `roles`: a test that says "manager" means it at both
 * levels, and making the caller repeat itself only produces tests that pass a
 * global gate and mysteriously fail an org one.
 */
export function scopeFromTestActor(spec: TestActor): RequestScope {
  const roles = spec.roles ?? [];
  // A present-but-synthetic id. Code that reasonably insists on knowing who
  // acted (an audit stamp, an ownership resolver) throws `Authentication
  // required` on an actor with roles and no identity — correct in production,
  // pure friction in a test whose point is a role gate. Derived from the roles
  // so it is deterministic and visibly synthetic in any record it lands on.
  const userId = spec.userId ?? `test-${roles.join("-") || "anon"}`;

  if (spec.elevated !== undefined && spec.elevated !== false) {
    return {
      kind: "elevated",
      userId,
      elevatedBy: spec.elevated === true ? "test" : spec.elevated,
      ...(spec.organizationId !== undefined ? { organizationId: spec.organizationId } : {}),
      ...(spec.context !== undefined ? { context: Object.freeze({ ...spec.context }) } : {}),
    };
  }

  if (spec.organizationId !== undefined) {
    return {
      kind: "member",
      userId,
      userRoles: roles,
      organizationId: spec.organizationId,
      orgRoles: spec.orgRoles ?? roles,
      ...(spec.teamId !== undefined ? { teamId: spec.teamId } : {}),
      ...(spec.context !== undefined ? { context: Object.freeze({ ...spec.context }) } : {}),
    } as RequestScope;
  }

  return { kind: "authenticated", userId, userRoles: roles };
}

/**
 * Build the `auth` option that makes the test actor arc's authenticator.
 *
 * It must be an authenticator, not a hook. Fastify encapsulates plugins and
 * modules register DURING `createApp`, so a hook added to the root instance
 * afterwards never runs for their routes — every request still resolves as
 * public and every role gate still answers 401, which reads exactly like a
 * broken authorization rule in the code under test. Registering as
 * `auth: { type: 'authenticator' }` puts the scope where arc's own auth would,
 * at the phase arc expects, so tenant filtering and permission checks behave
 * identically to production.
 *
 * `defaultActor` applies to requests carrying no header. A malformed header
 * REJECTS rather than falling back to public — a test that meant to be an admin
 * and got quietly demoted is the most expensive way to fail.
 */
export function testActorAuth(defaultActor?: TestActor): {
  type: "authenticator";
  authenticate: (request: unknown) => Promise<void>;
} {
  const authenticate = async (request: unknown): Promise<void> => {
    const req = request as {
      headers: Record<string, unknown>;
      scope?: RequestScope;
      user?: unknown;
    };
    const raw = req.headers[TEST_ACTOR_HEADER];
    let spec: TestActor | undefined = defaultActor;

    if (typeof raw === "string") {
      try {
        spec = JSON.parse(raw) as TestActor;
      } catch {
        throw new Error(
          `[arc-testing] malformed ${TEST_ACTOR_HEADER} header: ${raw}. ` +
            "Build it with testActorHeaders() rather than by hand.",
        );
      }
    }

    // No spec ⇒ leave the request alone; arc then treats it as public, which is
    // what `testActorHeaders(null)` is for.
    if (spec === undefined) return;

    req.scope = scopeFromTestActor(spec);
    // Also set `request.user`: arc's auth phase treats a missing user as
    // unauthenticated and answers `arc.unauthorized` BEFORE any permission check
    // runs, so the scope alone produced a 401 indistinguishable from a genuine
    // authorization failure. A production authenticator establishes both.
    // Nothing reads identity FROM `user` for authorization decisions — that is
    // the scope's job — this only answers "is anybody there". Same id as the
    // scope, because the two disagreeing is a debugging trap with no upside.
    req.user = {
      id: getUserId(req.scope) ?? "test-anon",
      ...(spec.roles !== undefined ? { role: spec.roles } : {}),
      ...(spec.organizationId !== undefined ? { organizationId: spec.organizationId } : {}),
    };
  };

  return { type: "authenticator", authenticate };
}
