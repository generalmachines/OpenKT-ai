import type { ActorContext } from "@openkt/core-context";

export interface OrgSummaryRecord {
  id: string;
  slug: string;
  name: string;
  plan: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
}

export interface OrgDetailRecord {
  id: string;
  slug: string;
  name: string;
  plan: string | null;
  createdAt: string;
  updatedAt: string;
  viewerRole: OrgSummaryRecord["role"] | null;
}

export interface OrgMemberRecord {
  userId: string;
  role: OrgSummaryRecord["role"];
  joinedAt: string;
  // Always null: members see names and roles, never each other's emails (Spec 04).
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface CreateOrgRecord {
  slug: string;
  name: string;
}

export interface OrgRepository {
  create(context: ActorContext, input: CreateOrgRecord): Promise<OrgSummaryRecord>;
  listMine(context: ActorContext): Promise<OrgSummaryRecord[]>;
  findBySlug(context: ActorContext, slug: string): Promise<OrgDetailRecord | null>;
  listMembers(context: ActorContext, orgId: string): Promise<OrgMemberRecord[]>;
  findIdBySlug(context: ActorContext, slug: string): Promise<string | null>;
}
