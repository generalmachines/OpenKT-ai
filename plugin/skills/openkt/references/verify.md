# Verify the connection with a round trip

Run this after connecting, and whenever the user asks whether OpenKT is working. It writes one harmless personal note and removes it again.

1. **Tools present.** Confirm the `kt_` tools are listed. If not, the server is not connected or not signed in; go back to the client's reference.
2. **Identity.** Call `kt_list_projects()`. It should return without an auth error. Tell the user how many spaces they can see. Zero is fine for a new account — the personal space always exists.
3. **Save.** Call `kt_save_memory` with
   `content`: `OpenKT setup check <today's date, time>: connection verified from <client name>.`
   `kind`: `fact` · `visibility`: `personal` · no `project`.
   Keep the returned id.
4. **Recall.** Call `kt_recall(query: "OpenKT setup check")` (or `kt_search_memories` with the same query). Indexing is asynchronous: if the note is not there, wait a few seconds and try once more. Seeing the note come back proves read, write and sign-in all work.
5. **Clean up.** Call `kt_forget_memory` with the id from step 3 so the test note does not linger. If the user would rather keep it, leave it; it is visible only to them.
6. **Report** in two or three lines: connected as whom (if the server says), how many spaces, round trip passed or where it failed.

If step 3 fails with a permission error, sign-in worked but the account cannot write: the workspace owner has to grant access. If step 2 fails with 401/unauthorized, repeat the sign-in for this client.

## What to tell the user afterwards

- From now on, at the start of a piece of work this assistant opens an OpenKT session and reads the team's brief for the relevant space.
- It looks things up before non-trivial work, and says where recalled context came from.
- It saves decisions, facts, how-tos, open questions, actions and ideas as they come up — short statements, never secrets — to the space you choose, or to your personal space when unsure. It asks at most once per conversation where things should go.
- At the end it closes the session with a short summary. Teammates' tools can then find what was learned, within the access you allowed.
- You stay in control: "save that", "don't save this", "what does OpenKT know about X", "forget that" all work.
