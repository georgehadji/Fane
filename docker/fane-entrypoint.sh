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

# The CORE academic engine is switched on only with a key (same rule as scripts/searxng-settings.mjs).
# The pattern keeps the key from breaking the YAML line or this sed.
if [ -n "${CORE_API_KEY:-}" ]; then
  if printf '%s' "$CORE_API_KEY" | grep -Eq '^[A-Za-z0-9._-]{8,200}$'; then
    sed -i "/- name: core\.ac\.uk/,/inactive:/{s/api_key:.*/api_key: '$CORE_API_KEY'/;s/inactive:.*/inactive: false/}" /etc/searxng/settings.yml
  else
    echo "fane: WARNING: CORE_API_KEY has unexpected characters; the CORE engine stays off" >&2
  fi
fi
chown searxng:searxng /etc/searxng/settings.yml

exec docker-entrypoint.sh "$@"
