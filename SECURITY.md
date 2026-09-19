# Security policy

OpenKT stores a team's working context and decides who may read it. A flaw in access control or sign-in is the most serious bug this project can have, and reports are taken seriously.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can read the report.

Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can:

- what is affected (a path in this repository, an endpoint, an MCP tool) and the commit you tested;
- the steps to reproduce, or a proof of concept;
- what an attacker gains — for example, reading context without a grant.

The maintainers will acknowledge the report, keep you informed while it is investigated, and credit you in the fix unless you prefer otherwise. The project has no bug bounty.

## Never post secrets

Do not paste access tokens, API keys, `.env` contents, database URLs or real team data into issues, pull requests or logs, and do not include them in a vulnerability report. Redact them. If a secret has been exposed, revoke it first, then report.

## In scope

- The server in `server/`: sign-in and OAuth, access tokens and their scopes, grants and the access scope that filters retrieval, the MCP endpoint and its tools, the REST API.
- Anything that lets a person or a tool read, change or infer context, pages or sessions they hold no grant for.
- Injection through captured content: session text, pasted documents or connector data that makes an agent in `packages/agents` act outside its one job, store a secret, or write where it should not.
- The plugin and skill in `plugin/`, including the hook script.
- The MCP Apps card bundle in `packages/mcp-cards`: escaping its sandbox, reaching the network, or performing a write the user did not confirm.
- The desktop app in `apps/desktop`: the Electron main process, the preload bridge and IPC.
- Secrets or credentials committed to this repository.

## Out of scope

- Vulnerabilities in third-party services and AI tools that OpenKT connects to. Report those to their vendors.
- A self-hosted deployment's own configuration: a database open to the internet, a weak model endpoint, missing TLS.
- Findings that require an already compromised machine or a malicious workspace owner.
- Denial of service by volume, and reports from automated scanners with no demonstrated impact.

## Supported versions

OpenKT has not made a release yet. Fixes land on `main`.
