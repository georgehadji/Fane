# Fane

Fixes and a headless CLI for a local [Vane](https://github.com/ItzCrazyKns/Vane) install (the AI search engine formerly called Perplexica).

This is **not a fork** of Vane. It is a small toolkit for the official Docker image, aimed at making Vane usable by agents and API clients:

| What | Why |
|---|---|
| `cli/` | `vane "<question>"`: ask Vane from any shell or agent and get a cited answer plus sources (text or JSON). No extra server needed. |
| `patches/patch-toolcall-empty-args.js` | Fixes `Error: is empty`, which crashes or hangs every search with Anthropic/OpenAI models through OpenRouter ([Vane#1150](https://github.com/ItzCrazyKns/Vane/issues/1150)). |
| `patches/patch-always-search.js` | Fixes "could not find any relevant information" for general-knowledge questions. The classifier skips search, but the writer only answers from search results ([Vane#1211](https://github.com/ItzCrazyKns/Vane/issues/1211)). |
| `patches/patch-quality-mode.js` | Improves Quality (Beta) mode. It keeps the top search snippets next to the scraped pages (upstream drops them, so quality got fewer sources than speed), falls back to the snippet when a page can't be scraped, caps the LLM calls per page, keeps extracted facts in page order, sets the research loop to 10 iterations (matching its prompt, down from 25), trims what the researcher re-reads each round, and makes answer length match the question instead of a forced 2000+ words. Measured on "Compare Rust and Go for building CLI tools" with Claude Haiku: 30 sources instead of 9, and 2,076 words instead of 3,313. A narrow question ("latest Node.js LTS") now gets 367 words. |
| `patches/patch-scholarly-sources.js` | Makes the Academic source dependable. The Academic toggle alone now enables paper search (upstream also needed the classifier to judge the question a "paper request", so "Is coffee bad for your heart?" got 0 sources). The model is told to write keyword queries, because arXiv, PubMed and Semantic Scholar return nothing for sentences. OpenAlex, Crossref and Semantic Scholar are searched too. Results carry `[authors \| year \| venue \| doi \| preprint (arXiv)]`, and the writer cites papers by author and year and flags preprints. Paywalled publisher links are swapped for the arXiv copy when one exists. Measured with Claude Haiku, Academic only: the coffee question went from 0 to 20 sources; "How do transformers handle long context efficiently?" in speed mode went from 20 to 40 sources, with 31 author-year citations. |
| `patches/patch-social-sources.js` | Makes the Social source work. Upstream it searched only SearXNG's Reddit engine, which ships disabled and which Reddit blocks (JSON API 403), so every Social-only answer had 0 sources. It now searches Hacker News, Lemmy, Stack Overflow, Super User and Ask Ubuntu, and reaches Reddit through `site:reddit.com` web searches, keeping only reddit.com results. Also: the Social toggle alone enables it, the model is told to write keyword queries, results carry `[platform \| date]`, and the writer treats posts as opinions (consensus, disagreement, dates). Measured with Claude Haiku, Social only: "What do people think about mechanical keyboards for programming?" went from 0 to 14 sources, and "Best mechanical keyboard switches for typing" from 0 to 18 (speed) or 80 (quality). |
| `searxng/settings.yml` | SearXNG engine override for when the default engines are blocked (CAPTCHA or rate limits). Enables Bing, Yandex and Bing News, plus OpenAlex and Crossref for the Academic source and Hacker News for the Social source. |

Tested against **Vane 1.12.2**, image `itzcrazykns1337/vane:latest` (digest `sha256:0b61bf0d4470…`), with models through OpenRouter.

## Requirements

- Docker with Vane running as a container named `vane`:
  ```bash
  docker run -d -p 3000:3000 -v vane-data:/home/vane/data --name vane --restart unless-stopped itzcrazykns1337/vane:latest
  ```
- At least one chat model and one embedding model configured in Vane (Settings → Models).
- Node.js 20 or later, for the CLI.

## 1. Patches and SearXNG settings

Pick one.

**A. Docker Compose (recommended).** Runs Vane pinned to the verified image digest, and re-applies the patches and SearXNG settings on every start, so image updates and `docker rm` no longer undo them. It generates a fresh random `secret_key` at each start. It reuses the `vane-data` volume from the `docker run` command above.

```bash
docker rm -f vane      # only if you started it with `docker run`; your data stays in the vane-data volume
docker compose up -d
```

**B. Apply to an existing container.** Idempotent: copies the patches and settings in, generates a random `secret_key` (the repo file keeps its placeholder), restarts only if something changed, then runs `vane --doctor`.

```bash
node scripts/apply.mjs            # add --no-searxng to skip the SearXNG settings
```

The patch scripts match exact fragments of Vane 1.12.2's compiled build. On any other build they make no changes and exit non-zero. They back up every file they change (`*.bak`).

<details>
<summary>Manual steps</summary>

```bash
docker cp patches/patch-toolcall-empty-args.js vane:/tmp/p1.js
docker cp patches/patch-always-search.js vane:/tmp/p2.js
docker exec -u 0 vane node /tmp/p1.js
docker exec -u 0 vane node /tmp/p2.js
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
sed "s/REPLACE_ME_RUN_THE_COMMAND_IN_README/$KEY/" searxng/settings.yml > /tmp/settings.yml
docker cp /tmp/settings.yml vane:/etc/searxng/settings.yml
docker exec -u 0 vane chown searxng:searxng /etc/searxng/settings.yml
docker restart vane
```

On Windows Git Bash, prefix with `export MSYS_NO_PATHCONV=1` and write the temp file somewhere `docker.exe` can see. `scripts/apply.mjs` avoids both problems.
</details>

## 2. SearXNG engines

`searxng/settings.yml` enables Bing, Yandex and Bing News, plus OpenAlex and Crossref for academic search and Hacker News for social search. Reddit's own engine is blocked by Reddit, so the Social source reaches Reddit through `site:reddit.com` web searches; on this network only Yandex honours `site:`. Which engines work depends on your IP address. Check the whole set (one query per engine, so don't loop it):

```bash
node scripts/engine-check.mjs
node scripts/engine-check.mjs --engines mojeek,qwant   # try specific engines, prints the YAML to enable the ones that work
```

If an engine reports `CAPTCHA` or `too many requests`, the engine has flagged your IP (shared VPN ranges often are). Restart the container to clear SearXNG's suspension timers after changing network.

## 3. Install the CLI

```bash
npm install -g ./cli
vane --doctor
vane --list-models
vane "What is the latest Node.js LTS version?"
vane "Who maintains SearXNG?" -m "gemini 3.8" -s web,academic -j
vane "Explain HTTP/3" --stream --require-sources
```

On Windows PowerShell, `npm` may be blocked by the execution policy. Use `npm.cmd`, or run the command from Git Bash.

| Option | Default |
|---|---|
| `-m, --model` | `google/gemini-3.8-flash` (model key, name, or OpenRouter slug; partial matches work if unique) |
| `-e, --embedding` | `Xenova/all-MiniLM-L6-v2` |
| `-s, --sources` | `web` (`web`, `academic`, `discussions`) |
| `-o, --mode` | `speed` (`speed`, `balanced`, `quality`) |
| `-j, --json` | Print `{model, message, sources}` as JSON |
| `--stream` | Print the answer as it is generated (not with `--json`) |
| `--require-sources` | Exit 1 if the answer has no sources |
| `-t, --timeout` | `180` seconds, `600` with `--mode quality` |
| `--doctor` | Check Docker, container, models, patches and SearXNG; exit 1 on a failed check |

Environment overrides: `VANE_URL`, `VANE_CHAT_MODEL`, `VANE_EMBEDDING_MODEL`, `VANE_CONTAINER`, `VANE_SOURCES`, `VANE_MODE`.

- If Vane is not reachable, the CLI runs `docker start` on the container and waits for it.
- If the built-in default model is not in your Vane, the CLI uses the only chat model if there is exactly one, or lists what is available.
- A search that fails with HTTP 5xx or a connection reset is retried once. Timeouts are not retried.
- If the answer has no sources, it prints a warning to stderr, so agents don't trust an answer that isn't based on search. Add `--require-sources` to make that a non-zero exit.
- Exit codes: `0` ok, `1` runtime error (or no sources with `--require-sources`), `2` usage error.

### OpenRouter models

Any model on OpenRouter works with `-m vendor/model`. If Vane does not know the slug yet, the CLI checks it against OpenRouter's public catalog and registers it in Vane's OpenRouter provider, so typos are never saved.

```bash
vane --list-openrouter gemini             # search the catalog (id, context size, input price)
vane "question" -m anthropic/claude-haiku-4.5
vane --add-model google/gemini-3.8-flash  # register without running a query
vane --remove-model google/gemini-3.8-flash
```

This needs a Vane provider whose name contains "openrouter" (override with `--provider <name>`), configured in Vane (Settings → Models) as an OpenAI-compatible provider with **Base URL `https://openrouter.ai/api/v1`** and your OpenRouter API key. `vane --doctor` and `--add-model` warn when the provider points somewhere else.

## Development

```bash
npm test --prefix cli    # unit tests (node --test, no dependencies)
```

CI (`.github/workflows/ci.yml`) runs the tests and applies each patch twice inside the pinned image digest, so a patch/image mismatch fails the build. To move to a newer Vane, change the digest in `docker-compose.yml`, fix the patches until CI passes, and update the "Tested against" line.

## Known issues

- **Claude Sonnet + `balanced` mode via OpenRouter returns nothing.** The provider ends the first research turn with `finish_reason: content_filter` and no output. `speed` mode works, as does `balanced` with Haiku or Gemini. This is why the CLI defaults to `speed`.
- **Gemini 3.1 Pro + `balanced`** can take more than 180 seconds.
- **With `docker run` setups the patches don't survive image updates.** All changes live in the container's writable layer, so `docker rm` followed by `docker run` discards them. Use the Compose setup (section 1A), or re-run `node scripts/apply.mjs` after updating. The patches refuse to apply once the build changes, which usually means upstream has changed that code, possibly with a fix. The Compose entrypoint then warns in `docker logs` and starts Vane unpatched.
- **OpenRouter models fail if the provider's Base URL is not OpenRouter.** An OpenAI-type provider left on `https://api.openai.com/v1` rejects OpenRouter keys and requests hang until the timeout. Run `vane --doctor`.

## Credits

[Vane](https://github.com/ItzCrazyKns/Vane) by ItzCrazyKns, MIT license. The patch scripts contain short fragments of Vane's compiled output so they can match and replace them.
