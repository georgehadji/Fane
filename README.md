# Fane

Fixes and a headless CLI for a local [Vane](https://github.com/ItzCrazyKns/Vane) install (the AI search engine formerly called Perplexica).

This is **not a fork** of Vane. It is a small toolkit for the official Docker image, aimed at making Vane usable by agents and API clients:

| What | Why |
|---|---|
| `cli/` | `vane "<question>"`: ask Vane from any shell or agent and get a cited answer plus sources (text or JSON). No extra server needed. |
| `patches/patch-toolcall-empty-args.js` | Fixes `Error: is empty`, which crashes or hangs every search with Anthropic/OpenAI models through OpenRouter ([Vane#1150](https://github.com/ItzCrazyKns/Vane/issues/1150)). |
| `patches/patch-always-search.js` | Fixes "could not find any relevant information" for general-knowledge questions. The classifier skips search, but the writer only answers from search results ([Vane#1211](https://github.com/ItzCrazyKns/Vane/issues/1211)). |
| `searxng/settings.yml` | SearXNG engine override for when the default engines are blocked (CAPTCHA or rate limits). Enables Bing, Yandex and Bing News. |

Tested against **Vane 1.12.2**, image `itzcrazykns1337/vane:latest` (digest `sha256:0b61bf0d4470…`), with models through OpenRouter.

## Requirements

- Docker with Vane running as a container named `vane`:
  ```bash
  docker run -d -p 3000:3000 -v vane-data:/home/vane/data --name vane --restart unless-stopped itzcrazykns1337/vane:latest
  ```
- At least one chat model and one embedding model configured in Vane (Settings → Models).
- Node.js 20 or later, for the CLI.

## 1. Apply the patches

The scripts match exact fragments of Vane 1.12.2's compiled build. On any other build they make no changes and exit non-zero. They back up every file they change (`*.bak`), and running them twice is safe.

```bash
docker cp patches/patch-toolcall-empty-args.js vane:/tmp/p1.js
docker cp patches/patch-always-search.js vane:/tmp/p2.js
docker exec -u 0 vane node /tmp/p1.js
docker exec -u 0 vane node /tmp/p2.js
docker restart vane
```

## 2. SearXNG engines (optional)

Use this only if searches return 0 sources. Check first by querying the bundled SearXNG directly:

```bash
docker exec vane node -e "fetch('http://localhost:8080/search?q=test&format=json').then(r=>r.json()).then(j=>console.log(j.results.length, j.unresponsive_engines))"
```

Before copying the file in, set a random `secret_key`. The placeholder would technically work, but it is public and therefore insecure.

```bash
KEY=$(openssl rand -hex 32)   # or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
sed -i "s/REPLACE_ME_RUN_THE_COMMAND_IN_README/$KEY/" searxng/settings.yml
docker cp searxng/settings.yml vane:/etc/searxng/settings.yml
docker exec -u 0 vane chown searxng:searxng /etc/searxng/settings.yml
docker restart vane
```

Engines that work depend on your IP address. To test a single engine, add `&engines=<name>` to the query above.

## 3. Install the CLI

```bash
npm install -g ./cli
vane --list-models
vane "What is the latest Node.js LTS version?"
vane "Who maintains SearXNG?" -m "gemini 3.8" -s web,academic -j
```

| Option | Default |
|---|---|
| `-m, --model` | `google/gemini-3.8-flash` (model key or name; partial matches work if unique) |
| `-e, --embedding` | `Xenova/all-MiniLM-L6-v2` |
| `-s, --sources` | `web` (`web`, `academic`, `discussions`) |
| `-o, --mode` | `speed` (`speed`, `balanced`, `quality`) |
| `-j, --json` | Print `{model, message, sources}` as JSON |
| `-t, --timeout` | `180` seconds |

Environment overrides: `VANE_URL`, `VANE_CHAT_MODEL`, `VANE_EMBEDDING_MODEL`, `VANE_CONTAINER`.

- If Vane is not reachable, the CLI runs `docker start` on the container and waits for it.
- If the answer has no sources, it prints a warning to stderr, so agents don't trust an answer that isn't based on search.
- Exit codes: `0` ok, `1` runtime error, `2` usage error.

## Known issues

- **Claude Sonnet + `balanced` mode via OpenRouter returns nothing.** The provider ends the first research turn with `finish_reason: content_filter` and no output. `speed` mode works, as does `balanced` with Haiku or Gemini. This is why the CLI defaults to `speed`.
- **Gemini 3.1 Pro + `balanced`** can take more than 180 seconds.
- **The patches don't survive image updates.** All changes live in the container's writable layer, so `docker rm` followed by `docker run` (an update) discards them. Re-run the scripts after updating. They will refuse to run once the build changes, which usually means upstream has changed that code, possibly with a fix.

## Credits

[Vane](https://github.com/ItzCrazyKns/Vane) by ItzCrazyKns, MIT license. The patch scripts contain short fragments of Vane's compiled output so they can match and replace them.
