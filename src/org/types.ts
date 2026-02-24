/**
 * Organization types -- adapter interfaces for multi-tenant applications.
 * Arc defines the contract, apps implement it.
 */

export interface OrgDoc {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export interface MemberDoc {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

export interface InvitationDoc {
  id: string;
  orgId: string;
  email: string;
  role: string;
  invitedBy: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  expiresAt: Date;
  createdAt?: Date;
}

/** Core organization adapter -- apps implement this */
export interface OrgAdapter {
  createOrg(data: { name: string; slug: string; ownerId: string; [key: string]: unknown }): Promise<OrgDoc>;
  getOrg(id: string): Promise<OrgDoc | null>;
  getOrgBySlug(slug: string): Promise<OrgDoc | null>;
  updateOrg(id: string, data: Partial<OrgDoc>): Promise<OrgDoc | null>;
  deleteOrg(id: string): Promise<void>;
  listUserOrgs(userId: string): Promise<OrgDoc[]>;

  addMember(orgId: string, userId: string, role: string): Promise<MemberDoc>;
  removeMember(orgId: string, userId: string): Promise<void>;
  getMember(orgId: string, userId: string): Promise<MemberDoc | null>;
  listMembers(orgId: string): Promise<MemberDoc[]>;
  updateMemberRole(orgId: string, userId: string, role: string): Promise<MemberDoc | null>;

  invitations?: InvitationAdapter;
}

export interface InvitationAdapter {
  create(data: Omit<InvitationDoc, 'id' | 'createdAt'>): Promise<InvitationDoc>;
  getByToken(token: string): Promise<InvitationDoc | null>;
  accept(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  listPending(orgId: string): Promise<InvitationDoc[]>;
}

/** Statement-based permission check */
export interface OrgPermissionStatement {
  resource: string;
  action: string[];
}

/** Role definition with permissions */
export interface OrgRole {
  name: string;
  permissions: OrgPermissionStatement[];
}

export interface OrganizationPluginOptions {
  adapter: OrgAdapter;
  /** Built-in roles (default: owner, admin, member) */
  roles?: OrgRole[];
  /** Base path for org API routes (default: '/api/organizations') */
  basePath?: string;
  /** Enable invitation system */
  enableInvitations?: boolean;
}
