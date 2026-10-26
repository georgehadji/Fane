# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Not a fork of Vane (https://github.com/ItzCrazyKns/Vane). A small toolkit around the official Docker image `itzcrazykns1337/vane`, pinned in `docker-compose.yml` to the digest the patches were verified against (Vane 1.12.2). No dependencies. See `README.md` for install and usage.

## Architecture

Pieces that run in different places:

- `cli/vane.mjs` runs on the host. Single-file Node 20+ ESM CLI (zero deps, `node:util` `parseArgs`). Flow: `GET {url}/api/providers`, resolve model names (exact key, exact name, unique substring, else OpenRouter slug), then `POST /api/search` (NDJSON when `--stream`). If Vane is unreachable it runs `docker start <container>` once and waits up to 90s. Exit codes: 0 ok, 1 runtime error (or no sources with `--require-sources`), 2 usage error (`UsageError` plus parseArgs codes). It only runs `main()` when executed, so tests can import its exports.
  - OpenRouter: Vane keeps custom models per provider (`POST/DELETE /api/providers/{id}/models` with `{type,key,name}`). The CLI finds the provider by name ("openrouter"), validates a slug against the public catalog `https://openrouter.ai/api/v1/models`, and registers it. `/api/config` is read only for the provider's `baseURL` (it also contains API keys: never log or keep them).
  - `--doctor` shells out to `docker`; its `PATCH_MARKERS` duplicate the `to` strings of the patch scripts. Keep them in sync when a patch changes.
- `patches/*.js` are CommonJS scripts that run inside the container as root. They string-replace exact fragments of Vane's minified `.next/server/...` bundles. Contract for any patch: check all targets first and change nothing on a mismatch (exit 1), write a `*.bak` backup, be idempotent ("already patched"). The minified names (`c.classification.skipSearch`, `g.A()`) are build-specific; on a new Vane build the fragments must be re-derived. `patch-quality-mode.js` has several targets in `chunks/641.js` (research tool, research loop, writer prompt) and compiles the result with `vm.Script` before writing; new multi-target patches should follow it. `patch-scholarly-sources.js` also edits `chunks/641.js`, so patch file order matters: it sorts after `patch-quality-mode.js` and its one target that depends on the quality patch is marked `optional`. A `to` string must never be a substring of its `from` (the idempotency check would skip it); add a `/*fane:...*/` marker when a fix only deletes code. Its injected `ENRICH` function is unit-tested by extracting it from the patch source (`cli/test/scholarly.test.mjs`). `patch-social-sources.js` runs last of the three and has `alts` (with and without the scholarly patch). When a later patch edits text inside an earlier patch's `to`, give the earlier target a `marker` (a substring the later patch leaves alone) or re-running the earlier patch fails with "found 0". CI runs two full passes in file order to catch this. Inside minified callbacks, watch for shadowed single-letter names (e.g. `b` is both the research config and a `forEach` index).
- `searxng/settings.yml` ends up at `/etc/searxng/settings.yml` in the container. Its `secret_key` is a placeholder that is replaced with a random value at install time, never in the repo file.
- Two ways to install the patches and settings, both must keep working:
  - `docker-compose.yml` + `docker/fane-entrypoint.sh`: the script runs as the container entrypoint on every start (patches, render settings with a random key, then `exec docker-entrypoint.sh`). A failing patch warns and Vane starts unpatched.
  - `scripts/apply.mjs`: the same for an existing `docker run` container (idempotent, restarts only on change, then runs `--doctor`).
- `scripts/engine-check.mjs` queries each SearXNG engine once from inside the container.
- CI (`.github/workflows/ci.yml`) runs the unit tests, applies each patch twice inside the pinned image, and runs `node --check` on every bundle that has a `.bak` (so every patch must write one). Changing the digest in `docker-compose.yml` must go with patch updates that keep this job green.

## Commands

```bash
npm test --prefix cli                # node --test, cli/test/*.test.mjs (pure functions only; no Docker or Vane needed)
node --test --test-name-pattern="resolveModel" cli/test/vane.test.mjs   # tests by name
npm install -g ./cli                 # installs the `vane` bin (links to the repo)
vane --doctor                        # full health check, exit 1 on a failure
node scripts/apply.mjs               # (re)apply patches + SearXNG settings to a running `vane` container
docker compose up -d                 # alternative: patched Vane from the pinned digest
node scripts/engine-check.mjs [--engines a,b]
```

## Environment gotchas (Windows)

- The CLI default model `google/gemini-3.8-flash` is registered automatically only if the Vane OpenRouter provider exists. Otherwise pass `-m` or set `VANE_CHAT_MODEL` after checking `vane --list-models`.
- The Vane provider called "Openrouter Fane" on the dev machine is an OpenAI-type provider whose Base URL is `https://api.openai.com/v1`, so OpenRouter models time out. `vane --doctor` warns about this; fixing it means entering an OpenRouter key in Vane's UI (do not do that for the user).
- In Git Bash, `export MSYS_NO_PATHCONV=1` before ad-hoc `docker exec ... /path` commands, or paths get rewritten. Files passed to `docker cp` must be somewhere `docker.exe` can see (not `mktemp` paths). The Node scripts use `execFile` and do not have this problem.
- In PowerShell, `npm` fails with an execution-policy error; use `npm.cmd` or Git Bash.
- Vane's research step sometimes returns zero sources for a query that worked a minute earlier; use `--require-sources` when that matters.
- Brave, DuckDuckGo and Startpage are blocked from the dev machine's IP (CAPTCHA or rate limit, also through a VPN). Bing and Yandex work intermittently. Do not try to bypass the CAPTCHAs; restart the container to clear SearXNG's suspension timers after changing network.
- `docker/*.sh` must stay LF (`.gitattributes` enforces it); CRLF breaks the container entrypoint.
