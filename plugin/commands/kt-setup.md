---
description: Connect, check or repair OpenKT in this client
argument-hint: [server URL if self-hosted]
---

Set up or check OpenKT. Server URL if given: $ARGUMENTS (otherwise the hosted server this plugin connects, `https://mcp.openkt.ai/mcp`).

1. Check whether the OpenKT `kt_` tools are available.
   - Available → go to step 3.
   - Not available → this plugin already declares the `openkt` MCP server, so the usual cause is a missing sign-in. Ask the user to run `/mcp`, choose **openkt** and complete the browser login. If the server is not listed there at all, ask them to run `/plugin`, confirm the OpenKT plugin is enabled, and then `/reload-plugins`.
2. Self-hosted server: the plugin connects the hosted server only. Add the team's own server next to it with `claude mcp add --transport http --scope user openkt-self <url>` (show the command and get a yes first), then `/mcp` → sign in.
3. If the server offers a `kt_setup` tool, call it and follow what it returns; the server knows its own current steps.
4. Run the round trip in the OpenKT skill's `references/verify.md`: list spaces, save a personal test note, recall it, remove it.
5. Report: connected or not, how many spaces, round trip result, and what happens from now on (session at the start, recall before work, save at decision points, summary at the end).

Never ask for a password or token in chat, and never run a downloaded script.
