#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/.."

npm run build >/dev/null

bash test/smoke/health.sh
bash test/smoke/service-auth.sh
bash test/smoke/error-envelope.sh
bash test/smoke/optional-user-auth.sh
bash test/smoke/memory-read.sh

echo "all smoke scripts completed"
