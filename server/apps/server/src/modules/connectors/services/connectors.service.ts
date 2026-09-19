import { Injectable } from "@nestjs/common";

import { PersonalTokensService } from "../../personal-tokens/services/personal-tokens.service";

// Builds pre-formatted install configs for every supported MCP client
// in one call. Mints a single fresh PAT named after the request so the
// user can revoke that one connector later without breaking others.
//
// The MCP_URL is hard-coded to the canonical production endpoint —
// dev / staging callers should hit /v1/me/connectors against their
// own deployment, the URL is derived from the request host below.

interface BuildArgs {
  userId: string;
  tokenName: string;
  baseUrl: string; // e.g. "https://api.openkt.ai"
}

export interface ConnectorBundle {
  mcp_url: string;
  pat: {
    id: string;
    raw_token: string;
    prefix: string;
    name: string;
    expires_at: Date | null;
  };
  clients: {
    claude_ai: {
      label: string;
      docs: string;
      // What the user pastes into Claude.ai → Settings → Connectors.
      manual: { url: string; auth_header: string };
    };
    claude_code: {
      label: string;
      // One-line CLI command. `claude mcp add` writes to local user
      // scope by default; the --scope=user form makes the server
      // available across every project the user opens.
      command: string;
    };
    cursor: {
      label: string;
      // cursor:// deep link — clicking opens Cursor's "Install MCP
      // server?" prompt with the config pre-filled.
      deep_link: string;
    };
    vscode: {
      label: string;
      // vscode:// deep link, same idea.
      deep_link: string;
    };
    codex: {
      label: string;
      // Raw TOML snippet for ~/.codex/config.toml. Codex doesn't
      // support deep links yet; the snippet is the shortest path.
      toml: string;
    };
  };
}

@Injectable()
export class ConnectorsService {
  constructor(private readonly tokens: PersonalTokensService) {}

  async build(args: BuildArgs): Promise<ConnectorBundle> {
    const issued = await this.tokens.create({
      userId: args.userId,
      name: args.tokenName,
      // Connector tokens are interactive-client backed. 90 days is the
      // GitHub Copilot / Linear default — short enough to surface
      // dormant tokens during the next quarterly review, long enough
      // not to nag users every week.
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    const mcpUrl = `${args.baseUrl.replace(/\/$/, "")}/mcp`;
    const authHeader = `Authorization: Bearer ${issued.rawToken}`;

    // Cursor deep link: name + base64(json) per their docs.
    const cursorConfig = {
      type: "http",
      url: mcpUrl,
      headers: { Authorization: `Bearer ${issued.rawToken}` },
    };
    const cursorDeepLink =
      "cursor://anysphere.cursor-deeplink/mcp/install?name=openkt&config=" +
      Buffer.from(JSON.stringify(cursorConfig)).toString("base64url");

    // VS Code deep link: url-encoded JSON
    const vscodeDeepLink =
      "vscode://mcp/install?" +
      encodeURIComponent(
        JSON.stringify({
          name: "openkt",
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${issued.rawToken}` },
        }),
      );

    return {
      mcp_url: mcpUrl,
      pat: {
        id: issued.id,
        raw_token: issued.rawToken,
        prefix: issued.prefix,
        name: issued.name,
        expires_at: issued.expiresAt,
      },
      clients: {
        claude_ai: {
          label: "Claude.ai (web)",
          docs: "https://claude.ai → Settings → Connectors → Add custom connector",
          manual: { url: mcpUrl, auth_header: authHeader },
        },
        claude_code: {
          label: "Claude Code (CLI)",
          command:
            `claude mcp add --transport http openkt ${mcpUrl} ` +
            `--header "Authorization: Bearer ${issued.rawToken}" ` +
            `--scope user`,
        },
        cursor: { label: "Cursor", deep_link: cursorDeepLink },
        vscode: { label: "VS Code", deep_link: vscodeDeepLink },
        codex: {
          label: "Codex (OpenAI)",
          toml: [
            "[mcp_servers.openkt]",
            `url = "${mcpUrl}"`,
            "transport = \"http\"",
            "",
            "[mcp_servers.openkt.headers]",
            `Authorization = "Bearer ${issued.rawToken}"`,
          ].join("\n"),
        },
      },
    };
  }
}
