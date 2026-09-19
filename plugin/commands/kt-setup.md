---
description: Connect, check or repair OpenKT in this client
argument-hint: [server URL if self-hosted]
---

Set up or check OpenKT. Server URL if given: $ARGUMENTS (otherwise the plugin's configured URL, default `https://mcp.openkt.ai/mcp`).

1. Check whether the OpenKT `kt_` tools are available.
   - Available → go to step 3.
   - Not available → this plugin already declares the `openkt` MCP server, so the usual cause is a missing sign-in. Ask the user to run `/mcp`, choose **openkt** and complete the browser login. If the server is not listed there at all, ask them to run `/plugin`, confirm the OpenKT plugin is enabled, and then `/reload-plugins`.
2. Self-hosted server: the URL is the plugin option `server_url`. The user changes it under `/plugin` → OpenKT → configure, or by reinstalling with `claude plugin install openkt@openkt --config server_url=<url>`. Do not edit settings files for them without showing the change and getting a yes.
3. If the server offers a `kt_setup` tool, call it and follow what it returns; the server knows its own current steps.
4. Run the round trip in the OpenKT skill's `references/verify.md`: list spaces, save a personal test note, recall it, remove it.
5. Report: connected or not, how many spaces, round trip result, and what happens from now on (session at the start, recall before work, save at decision points, summary at the end).

Never ask for a password or token in chat, and never run a downloaded script.
