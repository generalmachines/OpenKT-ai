---
description: Close the OpenKT session with a summary a teammate could read cold
argument-hint: [anything to add to the summary]
---

Close the current OpenKT session. Extra notes from the user: $ARGUMENTS

1. Find the OpenKT `session_id` from earlier in this conversation. If there is none, say that no OpenKT session is open, offer `/openkt:kt-save` for anything worth keeping, and stop. Never guess an id.
2. Look back over the conversation for decisions, facts, how-tos, open questions and actions that were never saved. Save each with `kt_save_memory` first (short, self-contained, no secrets, in the space this session uses).
3. Write a summary of 3–6 sentences: what was worked on, what was decided, what changed, what is still open and who has the next step. Include the user's notes above. No secrets, no verbatim private data, no transcript.
4. Call `kt_session_end(session_id, summary)`.
5. Tell the user in two lines what was kept and where it was filed.
