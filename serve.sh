#!/usr/bin/env bash
# Start the bucket viewer: a static page that lists and streams straight from the public S3 bucket.
# Usage: ./serve.sh [port]     then open http://localhost:<port>/
set -euo pipefail
PORT="${1:-8765}"
DIR="$(cd "$(dirname "$0")/static" && pwd)"
URL="http://localhost:${PORT}/"
echo "Serving $DIR at $URL  (Ctrl-C to stop)"
( sleep 0.7; command -v open >/dev/null && open "$URL" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR"
