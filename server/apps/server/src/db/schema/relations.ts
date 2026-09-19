import { relations } from "drizzle-orm";

import { memories, memoryTags, tags, memoryAccesses } from "./memories";
import { memberKnowledge } from "./member-knowledge";
import { orgs, orgMembers } from "./orgs";
import { profiles } from "./profiles";
import { projects } from "./projects";
import { teamBriefings } from "./team";

// Drizzle relations are query-builder hints, not runtime FKs.
// They enable `db.query.memories.findMany({ with: { tags: true } })`
// without writing the join by hand.

export const orgsRelations = relations(orgs, ({ many }) => ({
  members: many(orgMembers),
  projects: many(projects),
  memories: many(memories),
}));

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  org: one(orgs, { fields: [orgMembers.orgId], references: [orgs.id] }),
  profile: one(profiles, { fields: [orgMembers.userId], references: [profiles.userId] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  org: one(orgs, { fields: [projects.orgId], references: [orgs.id] }),
  ownerProfile: one(profiles, { fields: [projects.ownerUserId], references: [profiles.userId] }),
  memories: many(memories),
  briefings: many(teamBriefings),
  memberKnowledge: many(memberKnowledge),
}));

export const memoriesRelations = relations(memories, ({ one, many }) => ({
  project: one(projects, { fields: [memories.projectId], references: [projects.id] }),
  org: one(orgs, { fields: [memories.orgId], references: [orgs.id] }),
  ownerProfile: one(profiles, { fields: [memories.ownerUserId], references: [profiles.userId] }),
  memoryTags: many(memoryTags),
  accesses: many(memoryAccesses),
}));

export const memoryTagsRelations = relations(memoryTags, ({ one }) => ({
  memory: one(memories, { fields: [memoryTags.memoryId], references: [memories.id] }),
  tag: one(tags, { fields: [memoryTags.tagId], references: [tags.id] }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  memoryTags: many(memoryTags),
}));

export const memoryAccessesRelations = relations(memoryAccesses, ({ one }) => ({
  memory: one(memories, { fields: [memoryAccesses.memoryId], references: [memories.id] }),
  actorProfile: one(profiles, { fields: [memoryAccesses.actorUserId], references: [profiles.userId] }),
}));

export const teamBriefingsRelations = relations(teamBriefings, ({ one }) => ({
  project: one(projects, { fields: [teamBriefings.projectId], references: [projects.id] }),
  org: one(orgs, { fields: [teamBriefings.orgId], references: [orgs.id] }),
}));

export const memberKnowledgeRelations = relations(memberKnowledge, ({ one }) => ({
  project: one(projects, { fields: [memberKnowledge.projectId], references: [projects.id] }),
  org: one(orgs, { fields: [memberKnowledge.orgId], references: [orgs.id] }),
  profile: one(profiles, {
    fields: [memberKnowledge.userId],
    references: [profiles.userId],
  }),
}));
