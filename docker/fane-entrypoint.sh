#!/bin/sh
# Runs inside the Vane container before the image's own entrypoint (see docker-compose.yml).
# Re-applies the Fane patches and SearXNG settings on every start, so they survive
# container re-creation and image updates.
set -e

# A patch that no longer matches (new Vane build) exits non-zero without touching files.
# Warn and keep going: an unpatched Vane is better than a Vane that will not start.
for p in /fane/patches/patch-*.js; do
  node "$p" || echo "fane: WARNING: $p did not apply; running unpatched" >&2
done

# Fresh random secret_key on every start, written over the whole secret_key line, so the
# repo file is the only place that knows its placeholder.
key=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
sed "s/^\([[:space:]]*secret_key:\).*/\1 '$key'/" /fane/searxng/settings.yml > /etc/searxng/settings.yml
chown searxng:searxng /etc/searxng/settings.yml

exec docker-entrypoint.sh "$@"
