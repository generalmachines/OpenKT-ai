#!/usr/bin/env bash
# Publishes one desktop release to the S3 feed. Run by the `release` job in .github/workflows/desktop.yml
# (main only, after build + every smoke job is green). Order matters: the versioned files and the stable
# DMG first, `latest.json` LAST — a half-uploaded release is never advertised.
#
#   VERSION=0.3.128 BUCKET=… BASE_URL=https://…/desktop ZIP=… DMG=… COMMIT=<sha> [DRY_RUN=1] release-publish.sh
#
# DRY_RUN=1 prints the uploads (aws s3 cp --dryrun) and the feed without writing anything.
set -euo pipefail

: "${VERSION:?}" "${BUCKET:?}" "${BASE_URL:?}" "${ZIP:?}" "${DMG:?}" "${COMMIT:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
BASE_URL="${BASE_URL%/}"
PREFIX="desktop"
S3=(--only-show-errors)
[ "${DRY_RUN:-0}" = "1" ] && S3=(--dryrun)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The app only accepts files from the host its feed URL is pinned to (src/main/update/feed.ts).
PINNED_HOST="$(sed -n "s|^export const DEFAULT_FEED_URL = 'https://\([^/]*\)/.*|\1|p" "$DESKTOP/src/main/update/feed.ts")"
BASE_HOST="$(printf '%s' "$BASE_URL" | sed -n 's|^https://\([^/]*\)/.*|\1|p')"
if [ -z "$PINNED_HOST" ] || [ "$PINNED_HOST" != "$BASE_HOST" ]; then
  echo "::error::DOWNLOADS_BASE_URL host ($BASE_HOST) is not the host the app trusts ($PINNED_HOST)"; exit 1
fi
if [ "$BASE_URL" != "https://$BASE_HOST/$PREFIX" ]; then
  echo "::error::DOWNLOADS_BASE_URL must end in /$PREFIX (got $BASE_URL)"; exit 1
fi

# Never publish backwards (an older run finishing after a newer one).
PREV_VERSION=""; PREV_COMMIT=""
if curl -fsS --max-time 20 -H 'cache-control: no-cache' "$BASE_URL/latest.json" -o "$WORK/prev.json"; then
  PREV_VERSION="$(jq -r '.version // ""' "$WORK/prev.json")"
  PREV_COMMIT="$(jq -r '.commit // ""' "$WORK/prev.json")"
fi
echo "live feed: ${PREV_VERSION:-none} (${PREV_COMMIT:-no commit}) → publishing $VERSION ($COMMIT)"
NEWEST="$(printf '%s\n%s\n' "$PREV_VERSION" "$VERSION" | sort -V | tail -1)"
if [ -n "$PREV_VERSION" ] && { [ "$PREV_VERSION" = "$VERSION" ] || [ "$NEWEST" != "$VERSION" ]; }; then
  echo "::warning::the feed already offers $PREV_VERSION; not publishing $VERSION over it"
  exit 0
fi

# Release notes: commit subjects since the previous release that touched the app.
if [ -n "$PREV_COMMIT" ] && git cat-file -e "$PREV_COMMIT^{commit}" 2>/dev/null; then
  git log --no-merges --format=%s "$PREV_COMMIT..$COMMIT" -- apps/desktop packages/agents > "$WORK/subjects.txt"
else
  git log --no-merges --format=%s -n 30 "$COMMIT" -- apps/desktop packages/agents > "$WORK/subjects.txt"
fi
MIN_OS="$(sed -n 's/^ *minimumSystemVersion: *"\{0,1\}\([0-9.]*\)"\{0,1\}.*/\1/p' "$DESKTOP/electron-builder.yml" | head -1)"
node "$HERE/release-feed.mjs" --version "$VERSION" --base-url "$BASE_URL" --commit "$COMMIT" --zip "$ZIP" --dmg "$DMG" --subjects "$WORK/subjects.txt" --min-os "${MIN_OS:-13.3}" > "$WORK/latest.json"
cat "$WORK/latest.json"

LONG="public, max-age=31536000, immutable"
KEY="$PREFIX/releases/$VERSION"
aws s3 cp "${S3[@]}" "$ZIP" "s3://$BUCKET/$KEY/OpenKT-$VERSION-arm64.zip" --cache-control "$LONG" --content-type application/zip
aws s3 cp "${S3[@]}" "$DMG" "s3://$BUCKET/$KEY/OpenKT-$VERSION-arm64.dmg" --cache-control "$LONG" --content-type application/x-apple-diskimage
aws s3 cp "${S3[@]}" "$DMG" "s3://$BUCKET/$PREFIX/OpenKT-latest-arm64.dmg" --cache-control no-cache --content-type application/x-apple-diskimage \
  --content-disposition 'attachment; filename="OpenKT.dmg"'

if [ "${DRY_RUN:-0}" != "1" ]; then
  # Advertise only what the public can actually download, at the promised size.
  for f in "releases/$VERSION/OpenKT-$VERSION-arm64.zip:$ZIP" "releases/$VERSION/OpenKT-$VERSION-arm64.dmg:$DMG"; do
    url="$BASE_URL/${f%%:*}"; want="$(wc -c < "${f#*:}" | tr -d ' ')"
    got="$(curl -fsSI --max-time 20 "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
    [ "$got" = "$want" ] || { echo "::error::$url is not publicly readable at $want bytes (got '${got:-nothing}')"; exit 1; }
  done
fi

# LAST: the feed itself.
aws s3 cp "${S3[@]}" "$WORK/latest.json" "s3://$BUCKET/$PREFIX/latest.json" --cache-control no-cache --content-type application/json

{
  echo "### Released OpenKT $VERSION"
  echo "- feed: $BASE_URL/latest.json"
  echo "- first install: $BASE_URL/OpenKT-latest-arm64.dmg"
  echo "- notes:"; jq -r '.notes[] | "  - " + .' "$WORK/latest.json"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
if [ "${DRY_RUN:-0}" = "1" ]; then echo "dry run: nothing was written"; else echo "published $VERSION"; fi
