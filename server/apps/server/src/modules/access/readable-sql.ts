import { sql, type SQL } from "drizzle-orm";

// "What may this person read", as SQL subqueries for the recall/search path,
// so a query over every readable space filters inside the same statement that
// ranks (architecture.md §2 "Read path": filter before rank).
//
// The rules are exactly those of requireProjectAccess(…, "read")
// (libs/auth/authorization/src/access-policy.ts and
// ProjectScopeService.requireProjectAccess): the owner; a member of the
// space's org with role owner/admin/member; a reader/editor/owner grant on the
// space or on its org. Keep the three in step.
export function readableProjectIdsSql(userId: string): SQL {
  return sql`(
    SELECT p.id FROM projects p
     WHERE p.owner_user_id = ${userId}::uuid
        OR (p.org_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM org_members om
               WHERE om.org_id = p.org_id
                 AND om.user_id = ${userId}::uuid
                 AND om.role IN ('owner', 'admin', 'member')))
        OR EXISTS (
              SELECT 1 FROM grants g
               WHERE g.subject_type = 'user'
                 AND g.subject_id = ${userId}::uuid
                 AND g.role IN ('reader', 'editor', 'owner')
                 AND ((g.resource_type = 'project' AND g.resource_id = p.id)
                   OR (p.org_id IS NOT NULL AND g.resource_type = 'org' AND g.resource_id = p.org_id)))
  )`;
}

// Sessions granted to this person one by one (Spec 01 §2 visible_sessions):
// their facts are readable even when the space they live in is not.
export function grantedSessionIdsSql(userId: string): SQL {
  return sql`(
    SELECT g.resource_id FROM grants g
     WHERE g.subject_type = 'user'
       AND g.subject_id = ${userId}::uuid
       AND g.resource_type = 'session'
       AND g.role IN ('reader', 'editor', 'owner')
  )`;
}
