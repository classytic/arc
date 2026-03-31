/**
 * Organization Plugin -- Full org management with REST endpoints
 *
 * Creates these routes:
 * - POST   /api/organizations                          -- Create org
 * - GET    /api/organizations                          -- List user's orgs
 * - GET    /api/organizations/:orgId                   -- Get org
 * - PATCH  /api/organizations/:orgId                   -- Update org
 * - DELETE /api/organizations/:orgId                   -- Delete org
 * - GET    /api/organizations/:orgId/members           -- List members
 * - POST   /api/organizations/:orgId/members           -- Add member
 * - PATCH  /api/organizations/:orgId/members/:userId   -- Update role
 * - DELETE /api/organizations/:orgId/members/:userId   -- Remove member
 *
 * @example
 * import { organizationPlugin } from '@classytic/arc/org';
 *
 * await fastify.register(organizationPlugin, {
 *   adapter: myMongooseOrgAdapter,
 *   basePath: '/api/organizations',
 *   enableInvitations: false,
 * });
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import fp from "fastify-plugin";
import type { UserBase } from "../permissions/types.js";
import type { MemberDoc, OrganizationPluginOptions, OrgRole } from "./types.js";

// ---------------------------------------------------------------------------
// Fastify type augmentations
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyInstance {
    /** Middleware: require the caller to hold one of the listed org roles */
    requireOrgRole: (roles: string[]) => RouteHandlerMethod;
  }
}

// ---------------------------------------------------------------------------
// Default roles
// ---------------------------------------------------------------------------

const DEFAULT_ROLES: OrgRole[] = [
  {
    name: "owner",
    permissions: [{ resource: "*", action: ["*"] }],
  },
  {
    name: "admin",
    permissions: [
      { resource: "org", action: ["read", "update"] },
      { resource: "members", action: ["*"] },
    ],
  },
  {
    name: "member",
    permissions: [
      { resource: "org", action: ["read"] },
      { resource: "members", action: ["read"] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a UserBase from the request (set by auth plugin). */
function getUser(request: FastifyRequest): UserBase | undefined {
  return (request as FastifyRequest & { user?: UserBase }).user;
}

/** Get user id (supports both `id` and `_id`). */
function getUserId(user: UserBase): string | undefined {
  const raw = user.id ?? user._id;
  return raw ? String(raw) : undefined;
}

/** Standard JSON error reply. */
function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): void {
  void reply.code(statusCode).send({ success: false, code, error: message });
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

const organizationPlugin: FastifyPluginAsync<OrganizationPluginOptions> = async (
  fastify: FastifyInstance,
  opts: OrganizationPluginOptions,
) => {
  const {
    adapter,
    roles = DEFAULT_ROLES,
    basePath = "/api/organizations",
    enableInvitations = false,
  } = opts;

  // Collect valid role names for quick validation
  const validRoleNames = new Set(roles.map((r) => r.name));

  // --------------------------------------------------
  // requireOrgRole decorator
  // --------------------------------------------------

  /**
   * Create a preHandler that:
   * 1. Ensures the request is authenticated
   * 2. Looks up the caller's membership in the org identified by `:orgId`
   * 3. Verifies the caller holds one of the required roles
   */
  fastify.decorate(
    "requireOrgRole",
    function requireOrgRole(requiredRoles: string[]): RouteHandlerMethod {
      return async function requireOrgRoleHandler(
        request: FastifyRequest,
        reply: FastifyReply,
      ): Promise<void> {
        const user = getUser(request);
        if (!user) {
          sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
          return;
        }

        const userId = getUserId(user);
        if (!userId) {
          sendError(reply, 401, "UNAUTHORIZED", "Unable to determine user identity");
          return;
        }

        const { orgId } = request.params as { orgId?: string };
        if (!orgId) {
          sendError(reply, 400, "MISSING_ORG_ID", "Organization ID is required");
          return;
        }

        const member = await adapter.getMember(orgId, userId);
        if (!member) {
          sendError(reply, 403, "NOT_A_MEMBER", "You are not a member of this organization");
          return;
        }

        const hasRole = requiredRoles.includes(member.role);
        if (!hasRole) {
          sendError(
            reply,
            403,
            "INSUFFICIENT_ROLE",
            `This action requires one of these roles: ${requiredRoles.join(", ")}`,
          );
          return;
        }
      };
    },
  );

  // --------------------------------------------------
  // Auth helper -- optional authenticate decorator
  // --------------------------------------------------

  /** Wrap preHandlers so that authenticate is called first (if available). */
  // Return type is `any` to satisfy Fastify 5.8+'s tightened preHandler types.
  // All middleware conforms at runtime (returns void/Promise<void>).
  function withAuth(...extra: RouteHandlerMethod[]): any {
    const handlers: RouteHandlerMethod[] = [];
    const inst = fastify as FastifyInstance & { authenticate?: RouteHandlerMethod };
    if (typeof inst.authenticate === "function") {
      handlers.push(inst.authenticate);
    }
    handlers.push(...extra);
    return handlers;
  }

  // --------------------------------------------------
  // Slug helper
  // --------------------------------------------------

  function generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // --------------------------------------------------
  // Organization routes
  // --------------------------------------------------

  /**
   * POST / -- Create organization
   *
   * Body: { name: string; slug?: string; [key: string]: unknown }
   * The authenticated user becomes the owner.
   */
  fastify.post(
    basePath,
    { preHandler: withAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getUser(request);
      if (!user) {
        sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
        return;
      }

      const userId = getUserId(user);
      if (!userId) {
        sendError(reply, 401, "UNAUTHORIZED", "Unable to determine user identity");
        return;
      }

      const body = request.body as
        | { name?: string; slug?: string; [key: string]: unknown }
        | undefined;
      if (!body?.name) {
        sendError(reply, 400, "VALIDATION_ERROR", "Organization name is required");
        return;
      }

      const slug = body.slug ?? generateSlug(body.name);

      // Check slug uniqueness
      const existing = await adapter.getOrgBySlug(slug);
      if (existing) {
        sendError(reply, 409, "SLUG_TAKEN", `An organization with slug '${slug}' already exists`);
        return;
      }

      const org = await adapter.createOrg({ ...body, name: body.name, slug, ownerId: userId });

      // Auto-add creator as owner
      await adapter.addMember(org.id, userId, "owner");

      void reply.code(201).send({ success: true, data: org });
    },
  );

  /**
   * GET / -- List the authenticated user's organizations
   */
  fastify.get(
    basePath,
    { preHandler: withAuth() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getUser(request);
      if (!user) {
        sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
        return;
      }

      const userId = getUserId(user);
      if (!userId) {
        sendError(reply, 401, "UNAUTHORIZED", "Unable to determine user identity");
        return;
      }

      const orgs = await adapter.listUserOrgs(userId);
      void reply.send({ success: true, data: orgs });
    },
  );

  /**
   * GET /:orgId -- Get a single organization
   */
  fastify.get(
    `${basePath}/:orgId`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin", "member"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId } = request.params as { orgId: string };
      const org = await adapter.getOrg(orgId);

      if (!org) {
        sendError(reply, 404, "NOT_FOUND", "Organization not found");
        return;
      }

      void reply.send({ success: true, data: org });
    },
  );

  /**
   * PATCH /:orgId -- Update organization
   */
  fastify.patch(
    `${basePath}/:orgId`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId } = request.params as { orgId: string };
      const body = request.body as Partial<Record<string, unknown>> | undefined;

      if (!body || Object.keys(body).length === 0) {
        sendError(reply, 400, "VALIDATION_ERROR", "Request body must not be empty");
        return;
      }

      // Prevent changing ownerId or id through PATCH
      const { ownerId: _ownerId, id: _id, ...updates } = body;

      const org = await adapter.updateOrg(orgId, updates);
      if (!org) {
        sendError(reply, 404, "NOT_FOUND", "Organization not found");
        return;
      }

      void reply.send({ success: true, data: org });
    },
  );

  /**
   * DELETE /:orgId -- Delete organization (owner only)
   */
  fastify.delete(
    `${basePath}/:orgId`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId } = request.params as { orgId: string };

      const org = await adapter.getOrg(orgId);
      if (!org) {
        sendError(reply, 404, "NOT_FOUND", "Organization not found");
        return;
      }

      await adapter.deleteOrg(orgId);
      void reply.send({ success: true, message: "Organization deleted" });
    },
  );

  // --------------------------------------------------
  // Member routes
  // --------------------------------------------------

  /**
   * GET /:orgId/members -- List members
   */
  fastify.get(
    `${basePath}/:orgId/members`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin", "member"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId } = request.params as { orgId: string };
      const members = await adapter.listMembers(orgId);
      void reply.send({ success: true, data: members });
    },
  );

  /**
   * POST /:orgId/members -- Add a member
   *
   * Body: { userId: string; role: string }
   */
  fastify.post(
    `${basePath}/:orgId/members`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId } = request.params as { orgId: string };
      const body = request.body as { userId?: string; role?: string } | undefined;

      if (!body?.userId || !body.role) {
        sendError(reply, 400, "VALIDATION_ERROR", "userId and role are required");
        return;
      }

      if (!validRoleNames.has(body.role)) {
        sendError(
          reply,
          400,
          "INVALID_ROLE",
          `Invalid role '${body.role}'. Valid roles: ${[...validRoleNames].join(", ")}`,
        );
        return;
      }

      // Prevent duplicate membership
      const existing = await adapter.getMember(orgId, body.userId);
      if (existing) {
        sendError(reply, 409, "ALREADY_MEMBER", "User is already a member of this organization");
        return;
      }

      const member = await adapter.addMember(orgId, body.userId, body.role);
      void reply.code(201).send({ success: true, data: member });
    },
  );

  /**
   * PATCH /:orgId/members/:userId -- Update a member's role
   *
   * Body: { role: string }
   */
  fastify.patch(
    `${basePath}/:orgId/members/:userId`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId, userId } = request.params as { orgId: string; userId: string };
      const body = request.body as { role?: string } | undefined;

      if (!body?.role) {
        sendError(reply, 400, "VALIDATION_ERROR", "role is required");
        return;
      }

      if (!validRoleNames.has(body.role)) {
        sendError(
          reply,
          400,
          "INVALID_ROLE",
          `Invalid role '${body.role}'. Valid roles: ${[...validRoleNames].join(", ")}`,
        );
        return;
      }

      // Prevent demoting the last owner
      const currentMember = await adapter.getMember(orgId, userId);
      if (!currentMember) {
        sendError(reply, 404, "NOT_FOUND", "Member not found");
        return;
      }

      if (currentMember.role === "owner" && body.role !== "owner") {
        const members = await adapter.listMembers(orgId);
        const ownerCount = members.filter((m: MemberDoc) => m.role === "owner").length;
        if (ownerCount <= 1) {
          sendError(
            reply,
            400,
            "LAST_OWNER",
            "Cannot change the role of the last owner. Transfer ownership first.",
          );
          return;
        }
      }

      const member = await adapter.updateMemberRole(orgId, userId, body.role);
      if (!member) {
        sendError(reply, 404, "NOT_FOUND", "Member not found");
        return;
      }

      void reply.send({ success: true, data: member });
    },
  );

  /**
   * DELETE /:orgId/members/:userId -- Remove a member
   */
  fastify.delete(
    `${basePath}/:orgId/members/:userId`,
    { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin"])) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orgId, userId } = request.params as { orgId: string; userId: string };

      const member = await adapter.getMember(orgId, userId);
      if (!member) {
        sendError(reply, 404, "NOT_FOUND", "Member not found");
        return;
      }

      // Prevent removing the last owner
      if (member.role === "owner") {
        const members = await adapter.listMembers(orgId);
        const ownerCount = members.filter((m: MemberDoc) => m.role === "owner").length;
        if (ownerCount <= 1) {
          sendError(
            reply,
            400,
            "LAST_OWNER",
            "Cannot remove the last owner. Transfer ownership or delete the organization.",
          );
          return;
        }
      }

      await adapter.removeMember(orgId, userId);
      void reply.send({ success: true, message: "Member removed" });
    },
  );

  // --------------------------------------------------
  // Invitation routes (optional)
  // --------------------------------------------------

  if (enableInvitations && adapter.invitations) {
    const inv = adapter.invitations;

    /**
     * POST /:orgId/invitations -- Create invitation
     *
     * Body: { email: string; role: string; expiresAt?: string }
     */
    fastify.post(
      `${basePath}/:orgId/invitations`,
      { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin"])) },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const user = getUser(request);
        const userId = user ? getUserId(user) : undefined;
        if (!userId) {
          sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
          return;
        }

        const { orgId } = request.params as { orgId: string };
        const body = request.body as
          | { email?: string; role?: string; expiresAt?: string }
          | undefined;

        if (!body?.email || !body.role) {
          sendError(reply, 400, "VALIDATION_ERROR", "email and role are required");
          return;
        }

        if (!validRoleNames.has(body.role)) {
          sendError(
            reply,
            400,
            "INVALID_ROLE",
            `Invalid role '${body.role}'. Valid roles: ${[...validRoleNames].join(", ")}`,
          );
          return;
        }

        const defaultExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : defaultExpiry;

        const invitation = await inv.create({
          orgId,
          email: body.email,
          role: body.role,
          invitedBy: userId,
          status: "pending",
          expiresAt,
        });

        void reply.code(201).send({ success: true, data: invitation });
      },
    );

    /**
     * GET /:orgId/invitations -- List pending invitations
     */
    fastify.get(
      `${basePath}/:orgId/invitations`,
      { preHandler: withAuth(fastify.requireOrgRole(["owner", "admin"])) },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { orgId } = request.params as { orgId: string };
        const invitations = await inv.listPending(orgId);
        void reply.send({ success: true, data: invitations });
      },
    );

    /**
     * POST /invitations/:invitationId/accept -- Accept invitation
     */
    fastify.post(
      `${basePath}/invitations/:invitationId/accept`,
      { preHandler: withAuth() },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { invitationId } = request.params as { invitationId: string };
        await inv.accept(invitationId);
        void reply.send({ success: true, message: "Invitation accepted" });
      },
    );

    /**
     * POST /invitations/:invitationId/reject -- Reject invitation
     */
    fastify.post(
      `${basePath}/invitations/:invitationId/reject`,
      { preHandler: withAuth() },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { invitationId } = request.params as { invitationId: string };
        await inv.reject(invitationId);
        void reply.send({ success: true, message: "Invitation rejected" });
      },
    );
  }

  fastify.log?.debug?.(
    { basePath, roles: [...validRoleNames], invitations: enableInvitations },
    "Organization plugin registered",
  );
};

export default fp(organizationPlugin, {
  name: "arc-organization",
  fastify: "5.x",
});

export { organizationPlugin };
