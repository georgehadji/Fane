# Fane

Fixes and a headless CLI for a local [Vane](https://github.com/ItzCrazyKns/Vane) install (the AI search engine formerly called Perplexica).

This is **not a fork** of Vane. It is a small toolkit for the official Docker image, aimed at making Vane usable by agents and API clients:

| What | Why |
|---|---|
| `cli/` | `vane "<question>"`: ask Vane from any shell or agent and get a cited answer plus sources (text or JSON). No extra server needed. |
| `patches/patch-theme-toggle.js` | A one-click light/dark toggle in the sidebar, above the settings button. Vane already has both themes, but switching meant Settings → Preferences → Theme. The choice is saved like the setting (desktop sidebar only). |
| `patches/patch-toolcall-empty-args.js` | Fixes `Error: is empty`, which crashes or hangs every search with Anthropic/OpenAI models through OpenRouter ([Vane#1150](https://github.com/ItzCrazyKns/Vane/issues/1150)). |
| `patches/patch-always-search.js` | Fixes "could not find any relevant information" for general-knowledge questions. The classifier skips search, but the writer only answers from search results ([Vane#1211](https://github.com/ItzCrazyKns/Vane/issues/1211)). |
| `patches/patch-quality-mode.js` | Improves Quality (Beta) mode. It keeps the top search snippets next to the scraped pages (upstream drops them, so quality got fewer sources than speed), falls back to the snippet when a page can't be scraped, caps the LLM calls per page, keeps extracted facts in page order, sets the research loop to 10 iterations (matching its prompt, down from 25), trims what the researcher re-reads each round, and makes answer length match the question instead of a forced 2000+ words. Measured on "Compare Rust and Go for building CLI tools" with Claude Haiku: 30 sources instead of 9, and 2,076 words instead of 3,313. A narrow question ("latest Node.js LTS") now gets 367 words. |
| `patches/patch-scholarly-sources.js` | Makes the Academic source dependable. The Academic toggle alone now enables paper search (upstream also needed the classifier to judge the question a "paper request", so "Is coffee bad for your heart?" got 0 sources). The model is told to write keyword queries, because arXiv, PubMed and Semantic Scholar return nothing for sentences. OpenAlex, Crossref and Semantic Scholar are searched too. Results carry `[authors \| year \| venue \| doi \| preprint (arXiv)]`, and the writer cites papers by author and year and flags preprints. Paywalled publisher links are swapped for the arXiv copy when one exists. Measured with Claude Haiku, Academic only: the coffee question went from 0 to 20 sources; "How do transformers handle long context efficiently?" in speed mode went from 20 to 40 sources, with 31 author-year citations. |
| `patches/patch-social-sources.js` | Makes the Social source work. Upstream it searched only SearXNG's Reddit engine, which ships disabled and which Reddit blocks (JSON API 403), so every Social-only answer had 0 sources. It now searches Hacker News, Lemmy, Stack Overflow, Super User and Ask Ubuntu, and reaches Reddit through `site:reddit.com` web searches, keeping only reddit.com results. Also: the Social toggle alone enables it, the model is told to write keyword queries, results carry `[platform \| date]`, and the writer treats posts as opinions (consensus, disagreement, dates). Measured with Claude Haiku, Social only: "What do people think about mechanical keyboards for programming?" went from 0 to 14 sources, and "Best mechanical keyboard switches for typing" from 0 to 18 (speed) or 80 (quality). |
| `patches/patch-web-search.js` | Web search fixes. Balanced mode now reads the top 3 result pages (at most 2 extraction calls each) instead of answering from 160-character snippets. Quality mode's extra snippets are ranked by relevance like speed mode's. Result embeddings are computed in one batched call per query. Measured on "What is the best budget laptop for students?" with Claude Haiku: balanced gave 983 words with 6 concrete prices instead of 666 words (48s instead of 32s); quality had 0 Greek-language sites instead of 11 of 46, and took 97s instead of 116s. |
| `searxng/settings.yml` | SearXNG engine override for when the default engines are blocked (CAPTCHA or rate limits). Enables Bing, Yandex and Bing News, plus OpenAlex and Crossref for the Academic source and Hacker News for the Social source. Sets the search language (`default_lang: 'en'`, change it to yours), because Vane sends none and Bing otherwise localises to the server's IP country. Turns off engines that are blocked here (Brave, DuckDuckGo, Startpage, Google, Wolfram Alpha), which cut SearXNG query time from 2–6s to 0.5–1s. Re-check them with `scripts/engine-check.mjs` on your network. |

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
docker cp patches vane:/tmp/fane-patches      # the whole folder: patches share patches/lib/
for p in patches/patch-*.js; do docker exec -u 0 vane node "/tmp/fane-patches/${p#patches/}"; done
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
sed "s/^\([[:space:]]*secret_key:\).*/\1 '$KEY'/" searxng/settings.yml > /tmp/settings.yml
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
| `--verify` | Check every cited sentence against the sources it cites (see below) |
| `--min-support <0-1>` | With `--verify`: exit 1 if the supported share of cited sentences is lower |
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

### Image generation (`--image`)

`vane --image "<prompt>"` generates images through OpenRouter directly, without Vane or a search. A plain `vane "create an image of …"` (also "draw/generate/make a picture/logo/poster …") does the same, since Vane's answer pipeline can only write text. Use `--no-auto-image` to search instead.

Count and shape can be written in the prompt, in the CLI and in the web UI: "make 2 images of …", "three different pictures of …", "a widescreen photo of …", "a tall image of …", "a 16:9 …". Only unambiguous forms count ("a wide shot", "3 cats" and "a square table" are about the scene). `-n` and `--aspect` win over words in the prompt.

**In Vane's web UI** (`patches/patch-image-chat.js`), an image request typed into the chat box ("create an image of Donald Duck and his nieces in the playground") is answered with the generated images. It uses the same pipeline and the OpenRouter key from Vane's own provider settings. Any other question gets the usual answer. The answer is a 2×2 grid, each image labelled with its model and price, followed by one line with the total cost and time ("4 images · ~$0.065 · 47s"). While the models work the answer shows how many are ready and which models finished ("2 of 4 ready"); the images themselves appear together at the end, because every answer update re-sends the whole answer. Each image opens full size on click. When nothing could be made, the answer says why in plain words (no credits, rejected key, refused prompt, models busy) with the raw errors folded under "Details". The images are embedded in the answer as data URLs, so they stay in the chat history (1–4 MB each). Fane's image modules must be in the container: Compose mounts `cli/image`, and `scripts/apply.mjs` copies it. The method is ported from [reasoner](https://github.com/georgehadji/reasoner):

1. **Intent:** the prompt is classified into a family (`vector`, `photoreal`, `text_in_image`, `design`, `general`, `reference_edit`). A cheap text model does this (`VANE_IMAGE_TEXT_MODEL`), with keyword rules as the fallback. `--family` overrides it.
2. **Model choice:** from OpenRouter's live catalogue of image-output models (61 priced, 12 labs on 2026-10-27), with price normalised to USD per image. Every request makes **4 images from 4 different models** (`-n` changes the number), from different labs where possible. The tier is a price band of the family's models: `budget` the cheapest third, `value` (default) the middle third, `premium` the dearest third. The bands do not overlap, so each tier uses different models; inside a band the most capable come first (capability is ranked by the size word and version in the model id). In Vane's web UI the optimization mode picks the tier: **Speed = budget, Balanced = value, Quality = premium**. Quality costs the most (about $0.4 for 4 images on 2026-10-27). Each image has its own chain of up to 4 fallback models, and no model appears in two chains. SVG models serve only `vector`.
3. **Prompt enhancement** by the cheap text model (`--no-enhance` skips it).
4. **Generation:** the 4 chains run in parallel; a chain moves to its next model only when the previous one failed. Pure generators (Flux, Recraft, Seedream, …) go to OpenRouter's Image API. Chat models that draw (Gemini, GPT) go to chat completions with `modalities: ["image","text"]` and `image_config`, and their text reply is kept. For a non-square `--aspect`, chat models are sent to the Image API first, because chat completions silently drops the ratio for GPT (a 16:9 request came back 1024×1024). If a provider lists the ratios it accepts ("Accepted: 1:1, 3:2, 2:3"), the nearest one is used: GPT gets 3:2 for 16:9.
5. **Retries:** if a chain runs out after refusals, a policy-safe rewrite (by the model, then local rules for protected characters and studios) is tried for the missing images only; images already made are kept. A `401` or `402` stops every chain immediately, since it affects every model alike.
6. Images are saved to `--out-dir` (default `./vane-images`) and never overwrite existing files.

```bash
export OPENROUTER_API_KEY=sk-or-...           # or pass --key-from-vane to use Vane's OpenRouter provider key
vane --image "a red fox in fresh snow, morning light"   # 4 images, e.g. FLUX.2 Max, Qwen, Krea, GPT Image (~$0.09)
vane --image "minimal SVG logo for a coffee shop" -n 2
vane --image "cinematic photo of Athens at dusk" --tier premium --aspect 16:9 --size 2K
vane --image "make it a watercolour" --ref photo.jpg -j
vane --list-image-models chat                   # the chat models that draw: price per image, families
vane --image "a lighthouse at sunset" --via chat -n 2          # only chat models (picked GPT + Gemini)
vane --image "a lighthouse at sunset" --image-model google/gemini-3-pro-image,openai/gpt-5-image
```

Image links that a provider returns are downloaded only over HTTPS, never from private or loopback addresses, with every redirect re-checked and a 20 MB cap. Unlike reasoner, Fane does not strip AI-provenance metadata (C2PA) from generated images.

### Citation check (`--verify`)

`--verify` checks the answer against the text of the sources Vane returned, with no extra model calls. A cited sentence counts as supported when at least 30% of its content words appear in one of the sources it cites, and every multi-digit number in it appears in a cited source. The report lists weakly supported sentences, numbers not found in their sources, citation numbers that have no source, and how many sentences have no citation. With `-j` it is in the `verification` field.

```bash
vane "What is the latest Node.js LTS version?" --verify
vane "question" -j --min-support 0.8     # exit 1 below 80%, for agents
```

It catches citations to the wrong source, invented or changed numbers, and broken citation numbers. It can't judge meaning: a sentence that reuses the source's words but reverses its claim still passes, and a correct paraphrase can show as weak. On 4 test answers, correct sources scored 81–100% and deliberately mismatched sources 0–21%.

## Benchmark

`scripts/bench.mjs` runs the questions in `bench/questions.json` through the CLI with `--verify` and records time, words, sources, distinct sites, citations used, citation support and the share of non-Latin source titles. It saves the results to `bench/results/` and compares them against a baseline.

```bash
node scripts/bench.mjs -m claude-haiku-5-5                                   # speed mode, 1 run
node scripts/bench.mjs --modes speed,balanced --runs 3 -m claude-haiku-5-5
node scripts/bench.mjs -m claude-haiku-5-5 --modes speed,balanced --baseline bench/baseline.json --fail-on-regression
```

Each run is a real query. `bench/baseline.json` holds one run per question in speed and balanced mode with Claude Haiku (2026-10-27). Single runs vary: one `coffee/speed` run scored 0.038 support, while 3 reruns gave a median of 0.864. Use `--runs 3` before trusting a regression. A regression means more failed runs, 25% fewer sources, citation support down 0.1, time up 50% and more than 10s, or non-Latin titles up 10 points.

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
