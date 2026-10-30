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

# Keyed engines: switched on only with a key, by the rules of scripts/searxng-settings.mjs (renderSettings).
# switch_on <key> <variable> <label> <engine name> <field> <value prefix>; one call per KEYED_ENGINES entry there.
# A pasted or CRLF-edited key is trimmed at both ends, as scripts/apply.mjs does with .trim(). Only [A-Za-z0-9._-],
# 8 to 200 long, so the key cannot break the YAML line or this sed. A case pattern, not grep: grep tests one line at
# a time and let a key with a newline through.
switch_on() {
  key=$1
  key=${key#"${key%%[![:space:]]*}"}
  key=${key%"${key##*[![:space:]]}"}
  [ -n "$key" ] || return 0
  case "$key" in
    *[!A-Za-z0-9._-]*) ok=no ;;
    *) if [ "${#key}" -ge 8 ] && [ "${#key}" -le 200 ]; then ok=yes; else ok=no; fi ;;
  esac
  if [ "$ok" = yes ]; then
    sed -i "/- name: $4/,/inactive:/{s/$5:.*/$5: '$6$key'/;s/inactive:.*/inactive: false/}" /etc/searxng/settings.yml
  else
    echo "fane: WARNING: $2 has unexpected characters; the $3 engine stays off" >&2
  fi
}
switch_on "${BRAVE_API_KEY:-}" BRAVE_API_KEY Brave 'brave api' X-Subscription-Token ''
switch_on "${TAVILY_API_KEY:-}" TAVILY_API_KEY Tavily 'tavily' Authorization 'Bearer '
switch_on "${PERPLEXITY_API_KEY:-}" PERPLEXITY_API_KEY Perplexity 'perplexity' Authorization 'Bearer '
switch_on "${CORE_API_KEY:-}" CORE_API_KEY CORE 'core.ac.uk' api_key ''
chown searxng:searxng /etc/searxng/settings.yml

exec docker-entrypoint.sh "$@"
