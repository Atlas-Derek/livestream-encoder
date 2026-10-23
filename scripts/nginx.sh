#!/usr/bin/env bash
# Runs nginx in the foreground with the repo-local config (npm run nginx). First writes var/nginx/playback.conf from
# PLAYBACK_SECRET: when it is set, /hls/ only serves URLs signed with it (src/api/playback.ts); unset, HLS is open.
# The API must be started with the same PLAYBACK_SECRET to hand out signed URLs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p var/nginx var/hls
secret="${PLAYBACK_SECRET:-}"
# Restricted so it can be written into nginx's config without quoting.
if [[ -n "$secret" && ! "$secret" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
  echo "PLAYBACK_SECRET must be at least 16 letters, digits, _ or -" >&2
  exit 1
fi
signed_only=0
[[ -n "$secret" ]] && signed_only=1
umask 077
cat > var/nginx/playback.conf <<CONF
# Written by scripts/nginx.sh from PLAYBACK_SECRET on every start; edits are lost.
map \$uri \$hls_secret { default "$secret"; }
map \$uri \$hls_signed_only { default $signed_only; }
CONF
echo "HLS playback: $([[ $signed_only = 1 ]] && echo 'signed URLs only' || echo 'open')"
exec nginx -p "$PWD" -c nginx/nginx.conf -g 'daemon off;'
