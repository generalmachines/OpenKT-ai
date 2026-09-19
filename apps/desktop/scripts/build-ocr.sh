#!/bin/bash
# Compiles native/ocr/main.swift → resources/ocr/openkt-ocr (macOS only; CI runs this on macos-14).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources/ocr
swiftc -O -target arm64-apple-macos13 -o resources/ocr/openkt-ocr native/ocr/main.swift -framework Vision -framework AppKit
chmod 755 resources/ocr/openkt-ocr
ls -la resources/ocr
otool -L resources/ocr/openkt-ocr
