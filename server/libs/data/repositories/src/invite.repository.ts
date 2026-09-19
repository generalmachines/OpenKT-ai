import type { ActorContext } from "@openkt/core-context";

export type OrgRole = "owner" | "admin" | "member";
export type InviteMode = "targeted" | "open";

export interface AcceptedInviteRecord {
  kind: "org" | "project";
  orgId?: string;
  orgSlug?: string;
  projectId?: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export interface CreateOrgInviteInput {
  orgId: string;
  invitedBy: string;
  email: string | null;
  role: OrgRole;
  maxUses: number | null;
  isOpen: boolean;
  expiresAt: Date;
  token: string;
}

export interface OrgInviteSummary {
  id: string;
  orgId: string;
  email: string | null;
  role: OrgRole;
  mode: InviteMode;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
  token: string;
}

export interface OrgInvitePreview {
  orgId: string;
  orgName: string;
  role: OrgRole;
  // The inviter's display name — never their email (the preview is public).
  invitedByName: string | null;
  mode: InviteMode;
  expiresAt: string;
  remainingUses: number | null;
}

export interface InviteRepository {
  accept(context: ActorContext, token: string): Promise<AcceptedInviteRecord>;
  createOrgInvite(input: CreateOrgInviteInput): Promise<OrgInviteSummary>;
  listOrgInvites(orgId: string): Promise<OrgInviteSummary[]>;
  revokeOrgInvite(inviteId: string): Promise<void>;
  findOrgInvitePreview(token: string): Promise<OrgInvitePreview | null>;
  findOrgIdForInvite(inviteId: string): Promise<string | null>;
  findOrgIdForToken(token: string): Promise<string | null>;
}
