#!/bin/bash
# Builds whisper.cpp's `whisper-cli` at the tag pinned in src/main/models/models.manifest.json
# → resources/whisper/whisper-cli. Static (no dylibs to ship), Metal on, the Metal shader library
# embedded in the binary (no loose .metallib). macOS only; CI runs this on macos-14 and caches
# resources/whisper keyed on the tag.
set -euo pipefail
cd "$(dirname "$0")/.."
MANIFEST=src/main/models/models.manifest.json
REPO=$(node -p "require('./$MANIFEST').whisper.repo")
TAG=$(node -p "require('./$MANIFEST').whisper.tag")
COMMIT=$(node -p "require('./$MANIFEST').whisper.commit")
OUT=resources/whisper
STAMP="$OUT/.whisper-build.json"

if [ -x "$OUT/whisper-cli" ] && [ -f "$STAMP" ] && [ "$(node -p "require('./$STAMP').commit")" = "$COMMIT" ]; then
  echo "$OUT/whisper-cli is already built from $TAG ($COMMIT)"
  exit 0
fi

SRC=$(mktemp -d)/whisper.cpp
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" "https://github.com/$REPO" "$SRC"
GOT=$(git -C "$SRC" rev-parse HEAD)
if [ "$GOT" != "$COMMIT" ]; then echo "tag $TAG is at $GOT, pinned commit is $COMMIT"; exit 1; fi

cmake -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$SRC/build" -j --config Release --target whisper-cli

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$SRC/build/bin/whisper-cli" "$OUT/whisper-cli"
cp "$SRC/LICENSE" "$OUT/LICENSE"
chmod 755 "$OUT/whisper-cli"
printf '{"repo":"%s","tag":"%s","commit":"%s"}\n' "$REPO" "$TAG" "$COMMIT" > "$STAMP"
ls -la "$OUT"
otool -L "$OUT/whisper-cli"
# Static means: nothing but system libraries and frameworks.
if otool -L "$OUT/whisper-cli" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/)'; then echo "whisper-cli links a non-system library"; exit 1; fi
