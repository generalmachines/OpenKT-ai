---
description: Save a decision, fact, how-to, question, action or idea to OpenKT
argument-hint: [what to save] [to <space>]
---

Save to OpenKT: $ARGUMENTS

1. If text was given, that is what to save. If not, propose the one to three most important unsaved items from this conversation (decisions first) and let the user confirm or edit them.
2. Rewrite each item as a short statement that stands alone: full names, absolute dates, the reason where there is one. One idea per item.
3. Refuse to save secrets (passwords, keys, tokens, connection strings) or verbatim private data; offer to save where the secret lives, or the takeaway, instead.
4. Pick the `kind`: decision, fact, how-to, question, action, idea or issue.
5. Choose the space. Use the one the user named, or the one this conversation already uses. If it is unclear, call `kt_list_projects`, offer only the spaces the user can write to plus "only me", and ask once. With no answer, save with `visibility: "personal"`.
6. Call `kt_save_memory(content, kind, project?, session_id?, visibility?)`, passing the current OpenKT `session_id` if you have one.
7. Confirm in one line: what was saved and where.

If the `kt_` tools are not available, tell the user to run `/mcp` and sign in to the `openkt` server, or run `/openkt:kt-setup`.
