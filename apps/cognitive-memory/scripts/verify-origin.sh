#!/usr/bin/env bash
# Verifies the production origin handling against a running `next start`.
#
# The deployment is behind a proxy: the request URL is the internal one and the
# public host only exists in the forwarded headers. That is what Vercel does,
# and it is what the old hardcoded localhost got wrong.
#
#   pnpm --filter cognitive-memory build && ./scripts/verify-origin.sh
#
set -uo pipefail

cd "$(dirname "$0")/.."

PORT=3999
DB=/tmp/cogmem-origin-verify.sqlite
rm -f "$DB"

export BETTER_AUTH_SECRET="verification-secret-not-a-real-one"
export COGNITIVE_MEMORY_DATABASE_PATH="$DB"
export NODE_ENV=production

if [ ! -d .next ]; then
  echo "no .next build — run 'pnpm build' first" >&2
  exit 1
fi

npx next start -p "$PORT" >/tmp/cogmem-origin-verify.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/health"; then break; fi
  sleep 0.5
done

COGNITIVE_MEMORY_VERIFY_BASE_URL="http://127.0.0.1:$PORT" npx tsx scripts/verify-origin.ts
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "--- server log ---" >&2
  tail -40 /tmp/cogmem-origin-verify.log >&2
fi

exit "$STATUS"
