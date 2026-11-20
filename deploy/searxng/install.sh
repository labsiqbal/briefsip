#!/bin/sh
# Install or update the loopback SearXNG used by Minarbot web_search.
# Runtime files live in ~/.config/minarbot/searxng; the secret never enters git.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
dst=${MINARBOT_SEARXNG_DIR:-$HOME/.config/minarbot/searxng}
mkdir -p "$dst"; chmod 700 "$dst"
cp "$src/compose.yaml" "$src/settings.yml" "$dst/"
if [ ! -f "$dst/env" ]; then
  umask 077
  printf 'SEARXNG_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$dst/env"
fi
docker compose -f "$dst/compose.yaml" up -d
for i in $(seq 1 30); do
  if curl -fsS -m 5 'http://127.0.0.1:8890/search?q=minarbot&format=json' >/dev/null; then
    echo "SearXNG ready: http://127.0.0.1:8890"; exit 0
  fi
  sleep 2
done
echo "SearXNG did not answer on 127.0.0.1:8890" >&2; exit 1
