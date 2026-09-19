#!/usr/bin/env bash
# Build dist/openkt-plugin.zip: the Claude plugin in plugin/, packaged for a manual upload
# (Cowork / Claude Desktop: Customize → Plugins → upload; Team/Enterprise: Organization settings →
# Plugins → Add plugins → Upload a file). The manifest sits at the zip root (.claude-plugin/plugin.json),
# next to .mcp.json (the hosted OpenKT MCP server), skills/, commands/ and hooks/.
#
#   scripts/build-plugin-zip.sh            → dist/openkt-plugin.zip
#
# Built from the committed files only (git archive of HEAD), so local edits never leak into it; the
# plugin folder's own marketplace.json is left out (a marketplace is not part of a plugin package).
# Validates with `claude plugin validate` when the claude CLI is on PATH.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

out="dist/openkt-plugin.zip"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

git archive --format=tar HEAD plugin | tar -x -C "${work}"
rm -f "${work}/plugin/.claude-plugin/marketplace.json"

if command -v claude >/dev/null 2>&1; then
  claude plugin validate "${work}/plugin/.claude-plugin/plugin.json" --strict
  claude plugin validate "${work}/plugin" --strict
fi

mkdir -p dist
rm -f "${out}"
(cd "${work}/plugin" && zip -q -r -X "${OLDPWD}/${out}" . -x '*.DS_Store')
echo "${out}  $(du -h "${out}" | cut -f1)  $(unzip -Z1 "${out}" | wc -l | tr -d ' ') files  plugin $(jq -r '.name + "@" + .version' plugin/.claude-plugin/plugin.json)"
