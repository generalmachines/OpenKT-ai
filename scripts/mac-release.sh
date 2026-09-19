#!/usr/bin/env bash
# OpenKT — build the Mac app on this Mac and publish it.
#
#   curl -fsSL https://raw.githubusercontent.com/masti-ai/OpenKT-ai/main/scripts/mac-release.sh | bash
#   (or, from a checkout:  bash scripts/mac-release.sh)
#
# What it does, in order:
#   1. checks the tools (Xcode Command Line Tools, Node 22, cmake, the AWS CLI + credentials)
#   2. clones or updates the code in ~/OpenKT-ai (override with OPENKT_SRC=/path)
#   3. builds OpenKT-<version>-arm64.dmg + .zip (unsigned preview build)
#   4. uploads them to s3://openkt-downloads-724772068721/desktop/releases/<version>/
#   5. writes desktop/latest.json (what the in-app updater reads) and replaces
#      desktop/OpenKT-latest-arm64.dmg (what "Try free on Mac" on openkt.ai downloads)
#
# Options (environment variables):
#   AWS_PROFILE=deepwork     the AWS profile to upload with (default: your default profile)
#   OPENKT_SRC=~/code/OpenKT-ai   where the code lives
#   OPENKT_REF=main          branch or commit to build
#   OPENKT_SKIP_UPLOAD=1     build only
#   OPENKT_UPLOAD_KIT=<url>  publish WITHOUT AWS credentials on this Mac: a one-time upload link made by
#                            `python3 scripts/release-upload-kit.py` on a machine that has them
set -euo pipefail

REPO_URL="https://github.com/masti-ai/OpenKT-ai.git"
SRC="${OPENKT_SRC:-$HOME/OpenKT-ai}"
REF="${OPENKT_REF:-main}"
ACCOUNT="724772068721"
BUCKET="openkt-downloads-724772068721"
REGION="ap-south-1"
BASE_URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/desktop"
KIT_URL="${OPENKT_UPLOAD_KIT:-}"
KIT_FILE=""

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

# Everything runs inside main(), so bash has read the whole script before running any of it
# (safe to pipe from curl: nothing below can swallow the rest of the script from stdin).
main() {

# ---------------------------------------------------------------- 1. tools
say "Checking tools"
[ "$(uname -s)" = "Darwin" ] || die "Run this on a Mac."
[ "$(uname -m)" = "arm64" ] || die "Build on an Apple silicon Mac (the app is arm64)."
xcode-select -p >/dev/null 2>&1 || die "Install the Xcode Command Line Tools first: xcode-select --install  (then run this again)"
command -v brew >/dev/null 2>&1 || die "Install Homebrew first: https://brew.sh"
command -v cmake >/dev/null 2>&1 || brew install cmake
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  brew list node@22 >/dev/null 2>&1 || brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
[ "$(node_major)" -ge 22 ] || die "Node 22 or newer is needed (found $(node -v 2>/dev/null || echo none))."
if [ -n "$KIT_URL" ]; then
  KIT_FILE=$(mktemp)
  curl -fsS "$KIT_URL" -o "$KIT_FILE" || die "The upload link did not open (expired or mistyped?). Ask for a new one."
  node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1]));if(new Date(k.expires_at)<new Date())process.exit(1)' "$KIT_FILE" || die "The upload link has expired. Ask for a new one."
  echo "publishing with an upload link (no AWS login needed)"
elif [ -z "${OPENKT_SKIP_UPLOAD:-}" ]; then
  command -v aws >/dev/null 2>&1 || brew install awscli
  got=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || die "AWS credentials don't work. Set AWS_PROFILE=<your deepwork profile>, or publish without AWS using an upload link (OPENKT_UPLOAD_KIT, see the top of this script)."
  [ "$got" = "$ACCOUNT" ] || die "These AWS credentials are for account $got; the download bucket is in $ACCOUNT. Set AWS_PROFILE to that account's profile."
fi
echo "node $(node -v) · cmake $(cmake --version | head -1 | awk '{print $3}') · upload: $([ -n "$KIT_URL" ] && echo 'upload link' || echo "aws ${AWS_PROFILE:-default}")"

# ---------------------------------------------------------------- 2. code
say "Getting the code ($REF) in $SRC"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --quiet origin
  git -C "$SRC" checkout --quiet "$REF"
  git -C "$SRC" pull --quiet --ff-only origin "$REF" 2>/dev/null || true
else
  git clone --quiet "$REPO_URL" "$SRC"
  git -C "$SRC" checkout --quiet "$REF"
fi
cd "$SRC"
[ -z "$(git status --porcelain -- apps/desktop/package.json)" ] || die "apps/desktop/package.json has local changes; commit or discard them first."
COMMIT=$(git rev-parse HEAD)
# Every build gets a newer version, so the in-app updater always sees it as an update.
VERSION="0.3.$(date -u +%y%m%d%H%M)"
[ -z "$KIT_FILE" ] || VERSION=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$KIT_FILE")
echo "commit ${COMMIT:0:7} · version $VERSION"

# ---------------------------------------------------------------- 3. build
say "Building OpenKT $VERSION (about 10 minutes the first time)"
trap 'git -C "$SRC" checkout --quiet -- apps/desktop/package.json 2>/dev/null || true' EXIT
node -e 'const f="apps/desktop/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$VERSION"
npm ci --no-audit --no-fund
npm run build -w @openkt/agents
rm -rf apps/desktop/release
(cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac)
DMG=$(ls -t apps/desktop/release/*.dmg 2>/dev/null | head -1)
ZIP=$(ls -t apps/desktop/release/*.zip 2>/dev/null | head -1)
[ -f "$DMG" ] && [ -f "$ZIP" ] || die "The build did not produce a .dmg and a .zip (see apps/desktop/release)."
echo "built: $DMG"

if [ -n "${OPENKT_SKIP_UPLOAD:-}" ]; then
  say "Done (not uploaded). Open it: open \"$DMG\""
  exit 0
fi

# ---------------------------------------------------------------- 4. upload the release
say "Uploading to s3://$BUCKET/desktop/releases/$VERSION/"
KEY_DMG="desktop/releases/$VERSION/OpenKT-$VERSION-arm64.dmg"
KEY_ZIP="desktop/releases/$VERSION/OpenKT-$VERSION-arm64.zip"
LONG="public, max-age=31536000, immutable"
# put <file> <kit entry: dmg|zip|latest_dmg|feed> <s3 key> <content-type> <cache-control>
put() {
  if [ -n "$KIT_FILE" ]; then
    local url ct cc
    url=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]].url' "$KIT_FILE" "$2")
    ct=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]].content_type' "$KIT_FILE" "$2")
    cc=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]].cache_control' "$KIT_FILE" "$2")
    curl -fsS -X PUT -T "$1" -H "Content-Type: $ct" -H "Cache-Control: $cc" "$url" -o /dev/null || die "Upload of $3 failed (link expired?)."
  else
    aws s3 cp "$1" "s3://$BUCKET/$3" --region "$REGION" --only-show-errors --content-type "$4" --cache-control "$5"
  fi
}
put "$DMG" dmg "$KEY_DMG" application/x-apple-diskimage "$LONG"
put "$ZIP" zip "$KEY_ZIP" application/zip "$LONG"

# ---------------------------------------------------------------- 5. publish (the feed goes LAST, so a half-uploaded release is never advertised)
say "Publishing latest.json and the openkt.ai download"
FEED=$(mktemp)
NOTES=$(git log -8 --no-merges --format=%s | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split("\n").filter(Boolean))))')
node -e '
const fs = require("fs"), crypto = require("crypto");
const [version, commit, base, dmg, zip, keyDmg, keyZip, notes, out] = process.argv.slice(1);
const file = (p, key) => ({ url: `${base.replace(/\/desktop$/, "")}/${key}`, sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"), size: fs.statSync(p).size });
fs.writeFileSync(out, JSON.stringify({ version, channel: "stable", released_at: new Date().toISOString(), commit, notes: JSON.parse(notes), min_os: "13.3", files: { zip: file(zip, keyZip), dmg: file(dmg, keyDmg) } }, null, 2) + "\n");
' "$VERSION" "$COMMIT" "$BASE_URL" "$DMG" "$ZIP" "$KEY_DMG" "$KEY_ZIP" "$NOTES" "$FEED"
put "$DMG" latest_dmg desktop/OpenKT-latest-arm64.dmg application/x-apple-diskimage no-cache
put "$FEED" feed desktop/latest.json application/json no-cache

# ---------------------------------------------------------------- check
code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "$BASE_URL/OpenKT-latest-arm64.dmg")
live=$(curl -s "$BASE_URL/latest.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).version' 2>/dev/null || echo "?")
[ "$live" = "$VERSION" ] || die "Uploaded, but latest.json says $live (expected $VERSION)."
say "Published OpenKT $VERSION"
echo "  download (openkt.ai → Try free on Mac): $BASE_URL/OpenKT-latest-arm64.dmg  [$code]"
echo "  update feed: $BASE_URL/latest.json"
echo "  install on this Mac:  open \"$DMG\"  → drag to Applications → xattr -dr com.apple.quarantine /Applications/OpenKT.app"
}

main "$@" </dev/null
