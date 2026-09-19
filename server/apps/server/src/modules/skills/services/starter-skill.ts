// The one skill every new account starts with, so the Skills screen is never
// empty and there is a real file to open, read and edit. Keep it short, and
// keep it true: every tool named here exists on this server.
export const STARTER_SKILL_TITLE = "How to use OpenKT";

export const STARTER_SKILL_MD = `---
name: how-to-use-openkt
description: How to work with OpenKT, the team's shared context. Use when the user asks what OpenKT is, how to save or find something in it, or how to share a space or a skill.
---

# How to use OpenKT

OpenKT keeps what a team learns — decisions, facts, how-tos — so nobody has to explain the same thing twice. Any AI tool connected to it can read and add to it.

## In a connected tool

1. Call \`kt_session_start\` when work begins. It returns a session id and a brief of the space.
2. Call \`kt_recall\` before non-trivial work, and whenever the user mentions a decision, a customer, a system or "like last time".
3. Call \`kt_save_memory\` when something durable is settled. One short, self-contained statement each. Never save secrets.
4. Call \`kt_session_end\` with a two or three sentence summary when the work is done.

## Where things go

- Everything is filed in a space. With no space named, it goes to the user's personal space, which only they can read.
- \`kt_list_projects\` lists the spaces the user can read.
- A space, a session or a skill is shared by email, as reader or editor. Only its owner changes who has access.

## Skills

A skill is a small folder of text files: a \`SKILL.md\` like this one, plus optional reference files. Every save is a new version, and an old version can be restored.

- \`kt_list_skills\` lists the skills the user can use; \`kt_get_skill\` returns one in full. Follow it when the user asks to do something "the way we do it".
- \`kt_save_skill\` creates a skill, or saves a new version of one the user may edit.

This skill is yours: edit it, or archive it once you know your way around.
`;
