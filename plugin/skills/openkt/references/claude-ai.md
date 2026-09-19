# Connect OpenKT in claude.ai, Claude Desktop, Claude mobile and Cowork

Status: **verified** against Anthropic's Help Center (support.claude.com articles 11175166 "custom connectors" and 12512180 "skills") and the Cowork plugin guide (claude.com/docs/cowork/guide/plugins) on 2026-09-19. These menus are renamed often; if a label differs, look for *Connectors*, *Plugins* and *Skills* under Customize or Settings.

A connector added on claude.ai is tied to the account, so it also appears in Claude Desktop and the mobile apps. Do **not** edit `claude_desktop_config.json` for this: that file is for local servers only.

## Add the connector

**Free, Pro, Max** (Free allows one custom connector):
1. Open **Customize → Connectors**.
2. Click **+**, then **Add custom connector**.
3. Name: `OpenKT`. URL: `https://mcp.openkt.ai/mcp` (or your team's server). Leave the advanced OAuth fields empty.
4. Click **Add**, then **Connect**, and sign in to OpenKT on the page that opens (email and password, or **Create an account**), then **Allow**.

**Team, Enterprise**: an owner adds it once under **Organization settings → Connectors → Add → Custom → Web**, with the same URL. Each member then opens **Customize → Connectors**, finds OpenKT and clicks **Connect** to sign in as themselves.

In a chat, open the **+** menu → **Connectors** and make sure OpenKT is switched on.

## Cowork: the plugin (connector + skill in one step)

**Customize → Plugins → Add marketplace** → `masti-ai/OpenKT-ai` → install **OpenKT**, and sign in when the connector asks. If the plugin's skill does not show up in a session, upload the plugin as a file instead: **Customize → Plugins →** upload `openkt-plugin.zip` (built by `scripts/build-plugin-zip.sh` in the repository).

## Add the skill

1. Zip the skill so that the archive contains the `openkt/` folder with `SKILL.md` inside it.
2. **Customize → Skills → + → Create skill → Upload a skill**, and choose the zip.
3. Skills need *Code execution and file creation* turned on: **Settings → Capabilities** on personal plans, **Organization settings → Skills** on Team and Enterprise. Owners can share a skill with the whole organisation.

The upload accepts only these frontmatter keys: `name, description, license, compatibility, metadata, allowed-tools`. This skill uses only those.

## Check

Ask: "Which OpenKT tools do you have?" You should see the `kt_` tools. Then run the round trip in [verify.md](verify.md). In these apps, saves and search results appear as OpenKT cards; the user picks the space in the card.
