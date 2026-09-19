# Connect OpenKT in ChatGPT

Status: **partly verified** on 2026-09-19 against https://developers.openai.com/apps-sdk/deploy/connect-chatgpt and the developer-mode guide. OpenAI's Help Center pages could not be read (HTTP 403), so the workspace-admin path and the exact sign-in clicks are unconfirmed. ChatGPT's settings move often: if a label differs, look for *Developer mode* and *Apps / Connectors*.

Requirements: ChatGPT on the web with a Plus, Pro, Business, Enterprise or Education account. On Business, Enterprise and Education an admin may have to allow developer mode or add the app for the workspace first (unconfirmed path).

1. **Settings → Security and login → Developer mode**: turn it on.
2. Open https://chatgpt.com/plugins and press **+** to create a connection.
3. Name: `OpenKT`. Description: `Shared team context: recall what the team knows, save decisions`. MCP server URL: `https://mcp.openkt.ai/mcp` (include the `/mcp` path; use your team's server if self-hosted). Authentication: **OAuth**.
4. Create the connection, sign in to OpenKT when the browser asks, and review the tool list.
5. In a new chat, add OpenKT from the tools menu. After the server changes its tools, use **Refresh** on the connection.

## The skill

ChatGPT supports skills (type `@` to pick one), but OpenAI documents distributing them inside plugins; no way to upload a standalone skill folder was found. Until there is one, paste the contents of `SKILL.md` into **Settings → Personalization → Custom instructions**, or into the instructions of a Project you use for team work. (Workaround, not an official skill install.)

## Check

Ask: "Which OpenKT tools do you have?" Then run the round trip in [verify.md](verify.md). ChatGPT renders OpenKT's cards for saves and search results.
