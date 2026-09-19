export type ProjectAccessMode = "read" | "write" | "admin";
export type OrgAccessMode = "read" | "write" | "admin";

export interface ProjectAccess {
  projectId: string;
  orgId: string | null;
  ownerUserId: string;
  visibility: string;
  // "reader" | "editor" are the grants (migration 0038) vocabulary —
  // returned when access came from a grant rather than ownership or
  // an org_members row.
  role:
    | "owner"
    | "admin"
    | "member"
    | "viewer"
    | "org_admin"
    | "org_member"
    | "reader"
    | "editor"
    | null;
}

export interface OrgAccess {
  orgId: string;
  role: "owner" | "admin" | "member";
}

export interface MemoryAccess {
  memoryId: string;
  orgId: string | null;
  projectId: string;
  ownerUserId: string;
  visibility: "personal" | "project" | "org";
  via: "owner" | "org_admin" | "project_admin";
}
