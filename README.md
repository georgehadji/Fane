# Fane

Fixes and a headless CLI for a local [Vane](https://github.com/ItzCrazyKns/Vane) install (the AI search engine formerly called Perplexica).

The project page is [`docs/index.html`](docs/index.html): static HTML, CSS and one script, no build. To publish it, turn on GitHub Pages for the `docs` folder (Settings → Pages → Deploy from a branch → `main` → `/docs`). Its pictures are real runs of `vane --image` (one prompt, three tiers, four images each), and its receipt uses the prices and model names of those runs.

This is **not a fork** of Vane. It is a small toolkit for the official Docker image, aimed at making Vane usable by agents and API clients:

| What | Why |
|---|---|
| `cli/` | `vane "<question>"`: ask Vane from any shell or agent and get a cited answer plus sources (text or JSON). No extra server needed. |
| `patches/patch-image-ui.js` | No "Search images" / "Search videos" buttons under an answer made of generated images (they search the web for pictures about the question, and Vane's auto-search setting would click them for you). The image hook ends its answers with an invisible HTML comment; Vane's message component leaves the side column out when it sees it. A browser chunk, so a normal reload picks it up. Normal answers keep the buttons. |
| `patches/patch-image-serve.js` | Serves the images Fane generates (`cli/image/store.mjs` writes them next to Vane's `config.json`). Vane has no route for such files and does not serve files added to `public/` after it started, so this adds a GET to its `/api/uploads` route. Only Fane's own hashed file names are served. |
| `patches/patch-theme-toggle.js` | A one-click light/dark toggle in the sidebar, above the settings button. Vane already has both themes, but switching meant Settings → Preferences → Theme. The choice is saved like the setting. On phones the toggle sits next to the home page’s gear, and both are labelled 44px buttons. It also makes Vane's own settings gear (a plain `div`, unreachable by keyboard) a labelled button that opens with Enter or Space. |
| `patches/patch-ui-fane-link.js` | A "Fane" item in Vane's menu (sidebar and phone bottom bar), next to Home, Discover and Library, that opens the Fane project page in a new tab. The address is `FANE_PAGE_URL` in `patches/lib/vane.js` (GitHub Pages from `/docs`). A browser chunk, so a normal reload picks it up. |
| `patches/patch-colors.js` | A warm palette with one terracotta accent, in colors that pass WCAG contrast in both themes. Off-white and charcoal neutrals replace Vane’s cool GitHub greys; terracotta (`#9e4420` light, `#e0805a` dark) replaces the six accent hues Vane used (orange, sky, cyan, teal, two blues) for links, the focus ring, hovered and selected icons, the active sidebar item, a filled Discover tab and send buttons; the dark theme is a deep charcoal with lifted cards. A visible keyboard focus ring (Vane hid it), darker light-theme secondary text, a grey delete bin that turns red on hover, and a full-ink home heading. One block appended to the end of Vane's stylesheet, which is served with max-age=0, so a normal reload picks it up. |
| `patches/patch-discover-ellipsis.js` | A real ellipsis at the end of a cut Discover summary. The news feeds cut summaries with three periods ("but that..."); Vane's `/api/discover` route now ends them with a no-break space and "…". A server route, so it needs Vane restarted (`apply.mjs` does this). |
| `patches/patch-discover-greek.js` | Greek news in Discover. Vane searched three English sites per topic; each topic now also searches three Greek ones in Greek (tech: news247.gr, unboxholics.com, in.gr; finance: capital.gr, euro2day.gr, naftemporiki.gr; art: efsyn.gr, lifo.gr, kathimerini.gr; sports: sport24.gr, gazzetta.gr, sdna.gr; entertainment: flix.gr, protothema.gr, athinorama.gr), shuffled in with the English stories. A Greek search that fails only leaves its stories out. The home page's news widget is unchanged. A server route, so it needs Vane restarted. |
| `patches/patch-type.js` | Commissioner instead of Montserrat, Literata for answer text, and calmer answer headings. Montserrat, Vane's font, has no Greek, so Greek answers mixed a system font with Montserrat digits in every line. [Commissioner](https://github.com/kosbarts/Commissioner) (SIL Open Font License) draws Latin and Greek together, so every answer is one typeface; Montserrat stays as the fallback for Cyrillic and Vietnamese. Answer headings no longer outrank the question (title 28px instead of 36px, weight 700 instead of 800), paragraphs get 150% line spacing and less space between them, the sidebar labels are 12px instead of 10px, Discover card summaries 13px with 145% line spacing instead of 12px with 162%, Library chat titles wrap at about 60 characters (URLs too) instead of running the full row, and links get a 1px underline set a little below the letters. Appended to Vane's stylesheet with the fonts embedded (Vane serves no file added after it starts). Answers are set in [Literata](https://github.com/googlefonts/literata) (SIL Open Font License, `patches/fonts/OFL-literata.txt`), a serif made for reading on screens, with Greek: a serif to read, a sans (Commissioner) to operate; Fane’s status lines and code stay as they were. |
| `patches/patch-editorial-greek.js` | Greek in Vane's condensed serif (page titles, large Discover headlines) drawn in a matching light condensed serif instead of Times New Roman. PP Editorial has no Greek; a Greek-only face under its name, Noto Serif Display Light (SIL Open Font License, `patches/fonts/OFL-noto-serif-display.txt`) cut to a static 65% width, supplies those letters. Embedded in Vane's stylesheet. |
| `patches/patch-greek-lang.js` | Marks a Greek question and answer `lang="el"`. Vane's page says `lang="en"` everywhere, so screen readers read Greek answers with an English voice. Text with more Greek than Latin letters gets `el`; anything else keeps `en`. A browser chunk, so a normal reload picks it up. |
| `patches/patch-library-ago.js` | "26 seconds ago" in Library instead of "26 seconds Ago". A browser chunk, so a normal reload picks it up. |
| `patches/patch-icon-buttons.js` | Names Vane’s icon-only buttons (mode, sources, model, attach, send, share, delete, rewrite, copy, read aloud …) for screen readers and as tooltips, and makes them at least 32px, 44px on touch screens. A small script in the layout chunk names each from its icon. |
| `patches/patch-weather.js` | The home page’s weather card appears only with a real reading (it showed 0°C and humidity 0% when the location or the call failed) and grows to fit a two-line place name instead of cutting off its last line. |
| `patches/patch-chat-title.js` | A real ellipsis (…) in the chat header’s shortened title. |
| `patches/patch-mode-icons.js` | The answer-mode menu (Speed, Balanced, Quality) shows signal bars, one, two and three of three filled, instead of an orange bolt, a green slider and a blue filled star. The icons are grey; the mode in use and the question box’s mode button are terracotta, its row has an accent edge and `aria-pressed`, and Quality has no “Beta” tag (`patch-quality-mode` fixed it; it was the most accurate mode on all six benchmark questions). |
| `patches/patch-new-chat.js` | Fixes the Home button (and "+") keeping the previous chat on screen. Vane resets its chat state only when the URL carries a different chat id; Home goes to `/`, which has none, so the old messages stayed under the new address and the question box was missing. A browser chunk, so a normal reload picks it up. |
| `patches/patch-toolcall-empty-args.js` | Fixes `Error: is empty`, which crashes or hangs every search with Anthropic/OpenAI models through OpenRouter ([Vane#1150](https://github.com/ItzCrazyKns/Vane/issues/1150)). |
| `patches/patch-always-search.js` | Fixes "could not find any relevant information" for general-knowledge questions. The classifier skips search, but the writer only answers from search results ([Vane#1211](https://github.com/ItzCrazyKns/Vane/issues/1211)). |
| `patches/patch-quality-check.js` | Checks Quality answers against their sources before they are shown. The answer is collected instead of streamed, and one call on the chat's model (`cli/write/quality-check.mjs`) reads each cited sentence next to the sources it cites: a sentence they state only in part is corrected, one they don't state is removed. The web UI ends the answer with a status line ("Checked 22 cited sentences against their sources: 6 corrected, 4 removed."); `/api/search` returns the answer alone. Up to 40 sentences per answer; table rows aren't checked. If the check fails, the answer is shown as written. |
| `patches/patch-quality-mode.js` | Improves Quality mode. It keeps the top search snippets next to the scraped pages (upstream drops them, so quality got fewer sources than speed), falls back to the snippet when a page can't be scraped, caps the LLM calls per page, keeps extracted facts in page order, sets the research loop to 10 iterations (matching its prompt, down from 25), trims what the researcher re-reads each round, and makes answer length match the question instead of a forced 2000+ words. Its prompt told the researcher both to use up the whole budget and to aim for 4–7 searches; now it says 4–7 and to stop once more searches would only repeat what it has, and two rounds in a row that find no new page end the research. Measured on "Compare Rust and Go for building CLI tools" with Claude Haiku: 30 sources instead of 9, and 2,076 words instead of 3,313. A narrow question ("latest Node.js LTS") now gets 367 words. |
| `patches/patch-scholarly-sources.js` | Makes the Academic source dependable. The Academic toggle alone now enables paper search (upstream also needed the classifier to judge the question a "paper request", so "Is coffee bad for your heart?" got 0 sources). The model is told to write keyword queries, because arXiv, PubMed and Semantic Scholar return nothing for sentences. OpenAlex, Crossref and Semantic Scholar are searched too. Results carry `[authors \| year \| venue \| doi \| preprint (arXiv)]`, and the writer cites papers by author and year and flags preprints. Paywalled publisher links are swapped for the arXiv copy when one exists. Measured with Claude Haiku, Academic only: the coffee question went from 0 to 20 sources; "How do transformers handle long context efficiently?" in speed mode went from 20 to 40 sources, with 31 author-year citations. |
| `patches/patch-social-sources.js` | Makes the Social source work. Upstream it searched only SearXNG's Reddit engine, which ships disabled and which Reddit blocks (JSON API 403), so every Social-only answer had 0 sources. It now searches Hacker News, Lemmy, Stack Overflow, Super User and Ask Ubuntu, and reaches Reddit through `site:reddit.com` web searches, keeping only reddit.com results. Also: the Social toggle alone enables it, the model is told to write keyword queries, results carry `[platform \| date]`, and the writer treats posts as opinions (consensus, disagreement, dates). Measured with Claude Haiku, Social only: "What do people think about mechanical keyboards for programming?" went from 0 to 14 sources, and "Best mechanical keyboard switches for typing" from 0 to 18 (speed) or 80 (quality). |
| `patches/patch-web-search.js` | Web search fixes. Balanced mode now reads the top 3 result pages (at most 2 extraction calls each) instead of answering from 160-character snippets. Quality mode's extra snippets are ranked by relevance like speed mode's. Result embeddings are computed in one batched call per query. Measured on "What is the best budget laptop for students?" with Claude Haiku: balanced gave 983 words with 6 concrete prices instead of 666 words (48s instead of 32s); quality had 0 Greek-language sites instead of 11 of 46, and took 97s instead of 116s. |
| `searxng/settings.yml` | SearXNG engine override for when the default engines are blocked (CAPTCHA or rate limits). Enables Bing, Yandex and Bing News, plus OpenAlex and Crossref for the Academic source and Hacker News for the Social source. Sets the search language (`default_lang: 'en'`, change it to yours), because Vane sends none and Bing otherwise localises to the server's IP country. Turns off engines that are blocked here (Brave, DuckDuckGo, Startpage, Google, Wolfram Alpha), which cut SearXNG query time from 2–6s to 0.5–1s. Re-check them with `scripts/engine-check.mjs` on your network. |

Tested against **Vane 1.12.2**, image `itzcrazykns1337/vane:latest` (digest `sha256:0b61bf0d4470…`), with models through OpenRouter.

## Requirements

- Docker with Vane running as a container named `vane`:
  ```bash
  docker run -d -p 127.0.0.1:3000:3000 -v vane-data:/home/vane/data --name vane --restart unless-stopped itzcrazykns1337/vane:latest
  ```
  Keep the `127.0.0.1:`. Vane has no login, and `GET /api/config` returns the API keys of its providers, so a port open on every interface hands them to anyone on your network. A container started with `-p 3000:3000` has to be recreated to change this (`docker rm -f vane`, then the command above; the `vane-data` volume keeps the settings).
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

**Limits for the web UI.** Vane has no login, so what its chat can spend is capped by environment variables of the container (set them in `docker-compose.yml`, or with `-e` on `docker run`; empty means the default):

| Variable | Meaning | Default |
|---|---|---|
| `FANE_MAX_COST` | USD one article, code or brainstorm run may spend; the next model call is refused once it is reached (images have their own count limit) | none |
| `FANE_DEADLINE_MIN` | Minutes one chat request may run in total; `0` turns it off | 30 |
| `FANE_IMAGE_STORE_MB` | Megabytes the stored images may take; the oldest are removed first, so an old answer's link to one can go dead | 1024 |

Closing the tab stops the paid calls of a run: the next one is refused and the one in flight is aborted. Vane's own research that already started finishes.

## 2. SearXNG engines

`searxng/settings.yml` enables Bing, Yandex and Bing News, plus OpenAlex and Crossref for academic search and Hacker News for social search. Reddit's own engine is blocked by Reddit, so the Social source reaches Reddit through `site:reddit.com` web searches; on this network only Yandex honours `site:`. Which engines work depends on your IP address. Check the whole set (one query per engine, so don't loop it):

```bash
node scripts/engine-check.mjs
node scripts/engine-check.mjs --engines mojeek,qwant   # try specific engines, prints the YAML to enable the ones that work
```

**CORE (optional).** [CORE](https://core.ac.uk) indexes open-access papers, 57 million of them with full text. Its SearXNG engine needs a free API key, which you get by registering at https://core.ac.uk/services/api. Set it in the environment the installer runs in, then install again:

```bash
export CORE_API_KEY=...         # PowerShell: $env:CORE_API_KEY = "..."
node scripts/apply.mjs          # or: docker compose up -d (passes CORE_API_KEY to the container)
```

- **Where the key goes:** the installers write it into the installed settings only, never into `searxng/settings.yml`, and print nothing but "CORE on". Without the variable the engine stays off.
- **How it is used:** CORE is one of the Academic source's engines. CORE returns a paper's whole text as the search snippet, and the scholarly patch cuts any result text to 2,000 characters.
- **Checking it:** `vane --doctor` runs one CORE query.
- **Rate limit:** CORE allows 5 requests per 10 seconds. When a research sends more, SearXNG suspends the engine for a while.

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

### Free models (freellmapi)

[freellmapi](https://github.com/tashfeenahmed/freellmapi) is a self-hosted gateway over the free tiers of many providers (Gemini, Groq, Cerebras, OpenRouter `:free` and others), with its own failover between them. Add it to Vane (Settings → Models) as an OpenAI-compatible provider with Base URL `http://host.docker.internal:3001/v1` and its `freellmapi-…` key; Fane finds it by that key.

- **Without an OpenRouter provider**, articles, posts, code and brainstorming (in the web UI, and the CLI with `--key-from-vane`) run on freellmapi's free models that passed Fane's trials, best score first, among those freellmapi can serve at that moment. Every chain ends in freellmapi's own router: `auto:fast` (Speed), `auto` (Balanced, its active chain) or `auto:smart` (Quality). With no trial results, every phase runs on that router entry. Images still need OpenRouter.
- **Next to OpenRouter**, those free chains follow every OpenRouter chain, and the whole run moves to them when OpenRouter answers 401 or 402 (bad key, no credits).
- **A chain entry `free:<model>`** goes to freellmapi: `vane --article "..." --article-model free:auto:smart`, or one of its model ids (`free:gemini-3.8-flash`).

Put freellmapi's models through the trials (no cost; results saved as `free:<id>` next to the OpenRouter ones, and a model that only failed to answer, a rate limit or a timeout, is not saved, so the next run tries it again):

```bash
node scripts/article-trial.mjs --free --concurrency 3
node scripts/code-trial.mjs --free --concurrency 3
```

Run them again after adding provider keys to freellmapi. The answer names the model that wrote it (`free:gemini-3.8-flash`, or for a router entry the model freellmapi chose, `free:groq/llama-3.3-70b`). Free calls cost $0. Quality drops late in the day as the best free tiers run out; freellmapi gives up a call after 45 s of failover (`FALLBACK_TIME_BUDGET_MS`), so raise that for long Quality or Greek articles.

### Image generation (`--image`)

`vane --image "<prompt>"` generates images through OpenRouter directly, without Vane or a search. A plain `vane "create an image of …"` (also "draw/generate/make a picture/logo/poster …") does the same, since Vane's answer pipeline can only write text; the word after the noun decides, so "create an image classifier in PyTorch" or "make a drawing app" stay searches. Use `--no-auto-image` to search instead.

Count and shape can be written in the prompt, in the CLI and in the web UI: "make 2 images of …", "three different pictures of …", "a widescreen photo of …", "a tall image of …", "a 16:9 …". Only unambiguous forms count ("a wide shot", "3 cats" and "a square table" are about the scene). `-n` and `--aspect` win over words in the prompt.

**In Vane's web UI** (`patches/patch-image-chat.js`), an image request typed into the chat box ("create an image of Donald Duck and his nieces in the playground") is answered with the generated images. It uses the same pipeline and the OpenRouter key from Vane's own provider settings. Any other question gets the usual answer. The answer is a 2×2 grid, each image labelled with its model and price, followed by one line with the total cost and time ("4 images · ~$0.065 · 47s"). While the models work the answer shows each image as soon as it is ready, with a count ("2 of 4 ready"). Each image opens full size on click.

**Follow-up edits:** right after an answer with images, a message that reads like an edit ("make it a watercolour", "now at night", "add a red hat", "make the third one darker"; not a question, and not another task such as "Use Python to sort a list" or "Make a list of …") makes new images from the earlier image instead of starting over: it is sent as a reference to image-editing models (4 images, each from a different model), your words go to the models as written, and the answer says which image was edited ("Edited image 3 of the previous answer"). Each edited image is shown to the cheap text model next to the original, and one that shows a different scene is rejected, so the next model in its chain tries: in one run both first choices timed out and the fallbacks, which the catalogue lists as taking image input, drew a new picture instead of the edit (the check is one call of about $0.0003 per image; if the check itself fails, the image is kept). "the second one", "image 3" and "#2" pick the image; the first is the default. A message that is itself an image request ("create an image of …") or a question ("why …") is not an edit. The earlier image is read from the files described below, so it has to still be there. When nothing could be made, the answer says why in plain words (no credits, rejected key, refused prompt, models busy) with the raw errors folded under "Details". Each image is stored as a file in `/home/vane/data/fane-images` (the data volume, so it survives restarts; named by the SHA-256 of its content) and the answer links to it, so an answer is about 1 KB instead of several MB, and the images load lazily and open full size. `patches/patch-image-serve.js` adds a GET to Vane's `/api/uploads` route that serves them (works without a restart; only Fane's own file names are served, with `nosniff` and a sandbox CSP). Anyone who can reach Vane can open an image whose link they know; the names are unguessable but not secret. Nothing deletes old images: clear the folder when it grows. If an image cannot be stored it is embedded in the answer as before. Fane's image modules must be in the container: Compose mounts `cli/image`, and `scripts/apply.mjs` copies it. The method is ported from [reasoner](https://github.com/georgehadji/reasoner):

1. **Intent:** the prompt is classified into a family (`vector`, `photoreal`, `text_in_image`, `design`, `general`, `reference_edit`). A cheap text model does this (`VANE_IMAGE_TEXT_MODEL`), with keyword rules as the fallback. `--family` overrides it.
2. **Model choice:** from OpenRouter's live catalogue of image-output models (61 priced, 12 labs on 2026-10-27), with price normalised to USD per image. Every request makes **4 images from 4 different models** (`-n` changes the number), from different labs where possible. The tier is a price band of the family's models: `budget` the cheapest third, `value` (default) the middle third, `premium` the dearest third. The bands do not overlap, so each tier uses different models; inside a band the most capable come first (capability is ranked by the size word and version in the model id). In Vane's web UI the optimization mode picks the tier: **Speed = budget, Balanced = value, Quality = premium**. Quality costs the most (about $0.4 for 4 images on 2026-10-27). Each image has its own chain of up to 4 fallback models, and no model appears in two chains. SVG models serve only `vector`.
3. **Prompt enhancement** by the cheap text model (`--no-enhance` skips it).
4. **Generation:** the 4 chains run in parallel; a chain moves to its next model only when the previous one failed. Pure generators (Flux, Recraft, Seedream, …) go to OpenRouter's Image API. Chat models that draw (Gemini, GPT) go to chat completions with `modalities: ["image","text"]` and `image_config`, and their text reply is kept. For a non-square `--aspect`, chat models are sent to the Image API first, because chat completions silently drops the ratio for GPT (a 16:9 request came back 1024×1024). If a provider lists the ratios it accepts ("Accepted: 1:1, 3:2, 2:3"), the nearest one is used: GPT gets 3:2 for 16:9.
5. **Retries:** if a chain runs out after refusals, a policy-safe rewrite (by the model, then local rules for protected characters and studios) is tried for the missing images only; images already made are kept. A `401` or `402` stops every chain immediately, since it affects every model alike.
6. Images are saved to `--out-dir` (default `./vane-images` for images) and never overwrite existing files.

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

Image links that a provider returns are downloaded only over HTTPS, never from private or loopback addresses or IPv6 address literals, with every redirect re-checked and a 20 MB cap. Unlike reasoner, Fane does not strip AI-provenance metadata (C2PA) from generated images.

### Articles (`--article`)

`vane --article "<topic>"` writes a cited article, in English or Greek. A request that starts like `write an article about …` or `γράψε ένα άρθρο για …` does this automatically (`--no-auto-article` searches instead). The method is ported from the article pipeline in [reasoner](https://github.com/georgehadji/reasoner): sources, outline, draft, fact-check, critique, developmental edit, style and copy edit, final audit. The sources come from Vane's own research; the writing runs on OpenRouter (needs `OPENROUTER_API_KEY` or `--key-from-vane`). The phases follow Vane's mode (`-o`, or `--tier budget|value|premium`):

| Mode | Phases (model calls) |
|---|---|
| `speed` | outline, draft (2) |
| `balanced` | + fact-check, critique, revision, one polish pass (6) |
| `quality` | + separate style and copy edit, final audit with one retry (8, +4 on a retry) |

A text that ends up more than a quarter over the requested length is cut back by an extra call, and by a second one when the first still leaves it more than 10% over (a Quality run once grew a 543-word draft to 899 words for a target of 500, and one trim call only got it to 651). A non-English topic adds one cheap call that writes English search queries, because most sources are English. Every phase has a chain of models (`--article-model a/x,b/y`: the first is primary, the rest are fallbacks). A cut-off, empty or "thinking" answer moves on to the next model, and a phase that fails after the draft is skipped and listed under `degraded`, never reported as a clean run.

Checks that need no model run on every mode: citations to sources that do not exist (removed and reported), numbers that are in no cited source, text length, leaked reasoning, and a count of stock phrases ("a testament to", «καθοριστικό ρόλο», «αναδεικνύοντας…»). For Greek they also catch Latin look-alike letters inside Greek words (repaired), straight quotes, `?` instead of `;` and polytonic accents. The sources list at the end is written by code from the real sources, so a model cannot invent a URL. The Greek stock-phrase list and the Greek writing rules are written in Greek, not translated.

```bash
vane --article "tidal power in Greece" --words 900 --out tidal.md
vane "γράψε ένα άρθρο για την παλιρροϊκή ενέργεια" -o quality --article-model vendor/model-a,vendor/model-b   # slugs from vane --list-openrouter
vane --edit-article tidal.md "make it shorter, about 600 words" --out tidal-short.md
vane --edit-article tidal.md "add a paragraph about costs"      # searches with Vane first, then cites what it found
```

`--edit-article <file>` changes an article that `--article` wrote, the same way as a follow-up in Vane's chat (below).

**Which models.** Without `--article-model`, each phase gets a chain of models from the price band of the mode: Speed the cheapest third of the models that passed the trial, Balanced the middle, Quality the dearest. Neighbouring phases (draft, critique, fact-check …) start with models from different labs, and each chain has up to three fallbacks from the same band. `vane --list-article-models -o quality --lang el` shows the chains.

OpenRouter's catalogue says nothing about writing quality or Greek, so a model is only used by default after it passed a live trial (`node scripts/article-trial.mjs --key-from-vane`, results in `cli/write/trial.json`): a short article in English and in Greek with the real prompt, and a JSON answer. A pass means not cut off, no leaked reasoning, the right language, valid citations and no Latin letters in Greek words. Among the models that pass, a score decides which come first: stock phrases, numbers that are in no source, uncited sentences, the miss on the length, flat sentence rhythm and Greek typography faults (stock phrases alone did not separate them: all 27 that passed the first trial had none on its 150-word sample, so the trial now writes 350 words on a topic that invites them, from sources full of numbers). The trial of 2026-10-27 tried 40 models for about $1.06; 27 passed all three. Models that think (Mistral Large 4, Cohere Command A+, Elorian Glimpse, and others) spent the whole token budget thinking and returned no text, so every call asks for low reasoning effort (`REASONING` in `cli/write/models.mjs`); with that, 9 more models passed. A Speed Greek article of about 400 words took 47 s and cost about $0.006.

**In Vane's web UI** (`patches/patch-article-chat.js`): the same request typed into the chat is answered with the article. Vane's mode picks the phases and the price band (Speed, Balanced, Quality). The sources come from Vane's own research on your chat model, so its usual "Research Progress" panels appear; the answer then shows status lines in the language of the article, the draft as soon as it exists, and the finished article with a one-line summary (words, sources, cost, time, mode) and any weak spot (a skipped phase, a failed check). Citations are superscript links to the real sources (`¹ ²`), not `[1]`: Vane turns every `[n]` into a chip for its own research sources, which are numbered differently. The modules are mounted from `cli/write` at `/fane/write` (Compose) or copied there by `node scripts/apply.mjs`; `vane --doctor` checks they are present. Measured in the web UI: an English Speed article of 638 words took 28 s and cost $0.003; a Greek one took 1 m 48 s (four research calls, now one, plus an outline that was cut off, see CLAUDE.md). **Follow-up edits:** right after an article, a message that reads like an edit ("make it shorter, about 300 words", "rewrite the introduction", "translate it to English", "κάνε το πιο σύντομο"; not a question, thanks or praise, which Vane answers as usual) changes that article with one model call (same sources, no new facts) and answers with the new version, a new summary line and the same checks. A request that adds something ("add a paragraph about costs", "expand the history section", «πρόσθεσε…») first runs one Vane research and gives the model the pages it found, which it may cite; the article's old sources stay numbered as before. A question, or an edit after an answer that is not one of Fane's articles, goes to Vane as usual. A requested length is followed only roughly: "about 300 words" gave 461 words in the live check. The sources list of a web answer is written as HTML links: Vane rewrites every `[…]` of an answer that has sources and splits it at its commas, so a title such as "The interaction between the Earth, moon and sun" showed as "[The interaction between the Earth]" and a link.

### LinkedIn and Facebook posts (`--post`)

`vane --post linkedin|facebook "<topic>"` writes a social post with the same research and fact-check as an article. These requests do it automatically, in the CLI and in Vane's chat:

- "write a LinkedIn post about …";
- "draft a post for Facebook on …";
- «γράψε μια ανάρτηση για …».

A post request that names no platform gets the LinkedIn rules. «Ανάρτηση για το blog μου» is still an article.

**Phases:**

| Mode | Phases |
|---|---|
| Speed | draft only |
| Balanced, Quality | draft, fact-check and polish; a revision only when a claim failed |

There is no outline, structural critique or audit, because a post has no sections. The mode still picks the price band of the models.

**What the post follows** (from 2026 figures, mostly tool vendors'):

| | LinkedIn | Facebook |
|---|---|---|
| Hard limit | 3,000 characters | none in practice |
| Shown before "see more" | about 210 characters | about 125 characters on mobile |
| Target length | about 220 words | about 120 words |

- The point goes in the first line, inside the fold.
- Plain text in short paragraphs: no headings, Markdown or Unicode "bold" letters (screen readers spell those out).
- No engagement bait ("Agree?", «Συμφωνείτε;»).
- No invented personal stories.
- LinkedIn gets at most 3 hashtags; Facebook none.
- No links in the post. A link in a LinkedIn post body cut median reach by 18.8% in a study of about 1.3 million posts, and Meta has been testing a cap on organic link posts. So the `[n]` markers the fact-check needs are removed, and the sources are printed as a **first comment** to paste under the post.

**Checks:**
- Fail: over the character limit, or fake bold.
- Warn: a first line past the fold, Markdown, a link, too many hashtags.
- Post bait counts as a stock phrase.

`--words` takes 60–450 for LinkedIn and 30–350 for Facebook. A live LinkedIn post on heat pumps (Balanced) came out at 222 words and 1,396 characters, with 9 of 9 claims supported, for $0.028.

```bash
vane "write a LinkedIn post about heat pumps in cold climates" -o balanced
vane --post facebook "tidal power in Orkney" --words 90 --out post.txt
```

### Code (`--code`)

`vane --code "<request>"` writes code: the files, a review, tests and a README. Requests that start like these do it automatically, in the CLI and in Vane's chat (`--no-auto-code` searches instead):

- "write a Python script that …", "create a CLI tool for …", "make a React component called …";
- "implement quicksort in Rust" (any request that names its language);
- «γράψε ένα πρόγραμμα που …», «φτιάξε μια συνάρτηση σε Python …».

"Write an article on machine learning in Python" stays an article, and "write a LinkedIn post about my library" stays a post.

The method is reasoner's coding flow ([`coding.py`](https://github.com/georgehadji/reasoner/blob/main/src/reasoner/application/flows/coding.py)):

1. **Documentation:** one Vane research on the request.
2. **Spec:** the language, the smallest set of files, each file's exports and imports, the error strategy, the security notes and the test command.
3. **Files:** one call per file, four at a time, at most 12 files, against a "production code contract" (types, specific errors, input validation, no secrets, nothing unfinished).
4. **Known vulnerabilities** of the stack (Quality only).
5. **Review:** a hostile review for security and quality, with findings rated critical, high or medium.
6. **Fixes:** one call per file with a critical or high finding, or that does not parse.
7. **Tests:** a regression test for each finding.
8. **README:** written by code from the spec and the review, with no model call.

| Mode | Phases |
|---|---|
| `speed` | spec, files |
| `balanced` | + documentation, review, fixes, tests |
| `quality` | + known vulnerabilities for the review |

Where Fane differs from reasoner:

- The files, the fixes and the tests come back as fenced code, not JSON. Code inside a JSON string broke on escaping, and reasoner kept the raw text as a fallback.
- The review and the fixes see whole files. Reasoner's review saw the first 800 characters of each file, and its final step was asked to return files whose content it was never given.

**Nothing generated is run.** Each file is only parsed: `node --check` for JavaScript, Python's `ast.parse` for Python, `JSON.parse` for JSON. Other languages show as "not checked", never as passing. A file that does not parse goes to the fix step. A fix that breaks the parse of a file that parsed is refused, and so is one that drops half the file; the earlier file is kept and the finding stays listed as not fixed.

Other checks warn about a TODO or stub, or about something that looks like a hard-coded key or password.

The paths a model proposes are checked before anything is written: no absolute path, `..`, `.git` or Windows device name. The files go to `--out-dir`, which must be new or empty. Without it they go to `./vane-code/<request>`, and a folder that already exists gets a number. Nothing is overwritten.

```bash
vane "write a Python script that renames photos by the date they were taken" -o balanced
vane --code "a CLI in Node.js that converts CSV to JSON" -o quality --out-dir csv2json
vane --list-code-models -o balanced
```

**Which models.** Default chains come from a coding trial (`node scripts/code-trial.mjs --key-from-vane`, results in `cli/code/trial.json`).

- Each candidate writes `duration.mjs` with the real prompt, and the function must pass 17 of 18 fixed cases.
- The candidates also answer the spec prompt as JSON.
- The candidates are each lab's newest models plus the newest code specialist of each lab (Codex, Qwen Coder, Devstral, and so on). The article trial leaves those out.
- The generated function runs in its own Node process with Node's permission model on (no file writes, no child processes) and a 10 s limit.

The mode picks the price band as for articles. `--code-model a/x,b/y` sets the models.

The trial of 2026-10-28 tried 45 models for $0.63:

- 23 passed the code task, and 22 of those also answered the spec as JSON.
- Six thinking models used their whole 12,000-token budget and returned no code, among them Kimi K2.7 Code.
- Qwen3 Coder Next passed 14 of 18 cases.

**Measured live:**

- **CLI, Balanced:** "write a Python script that renames the photos in a folder by the date they were taken, read from EXIF" made 5 model calls, cost $0.06 and took 263 s, giving one 222-line script and 518 lines of tests.
  - The review caught an import of a Pillow module that does not exist (the script would not have started), and the fix step repaired it.
  - Three medium findings stayed listed as not fixed.
- **Web UI, Balanced:** a JavaScript function took 1 m 25 s and cost $0.008. `arr[i]` and `[1, 3, 2]` showed intact, although the answer had sources.

**In Vane's web UI** (`patches/patch-code-chat.js`), the same request is answered in the chat:

- Each file is shown in Vane's code view, followed by the tests, the README, the review (what was fixed, what was not) and the documentation pages used.
- A status line gives files, tests, the parse results, cost, time and mode.
- Vane's chat page rewrites every `[x]` in an answer: into citation chips when the answer has sources, and `[1]` into nothing when it has none. That breaks `a[0]` and `[a, b]`, so the patch's second target leaves answers carrying the code marker alone.
- The modules are mounted from `cli/code` at `/fane/code`, or copied there by `node scripts/apply.mjs`.

Follow-up edits of code ("make it async") are not supported yet: the request goes to Vane as usual.

### Brainstorm (`--brainstorm`)

`vane --brainstorm "<problem>"` gives ranked ideas, the best of them worked out, one recommendation and a plan. Requests that start like these do it automatically, in the CLI and in Vane's chat (`--no-auto-brainstorm` searches instead):

- "brainstorm …", "give me 10 ideas for …", "suggest names for …", "list ways to …";
- «δώσε μου ιδέες για …», «πρότεινε τρόπους να …», «καταιγισμός ιδεών για …».

Questions ("what are good ideas for dinner?") and bare topics stay searches. So does "suggest alternatives to Photoshop", which asks for products that exist.

The method is reasoner's brainstorming flow ([`brainstorming.py`](https://github.com/georgehadji/reasoner/blob/main/src/reasoner/application/flows/brainstorming.py)), built on Verbalized Sampling:

1. **Existing work:** one Vane research on the problem (Balanced, Quality).
2. **Rounds of ideas:** 5 ideas a round. Each idea comes with the probability that a typical model would give it, and at least 2 a round must be below 0.10. Naming the probability makes the model see its obvious ideas and reach past them. Each round sees the titles of the earlier ones.
3. **Themes and scores:** near-duplicates merged, the rest grouped in 3 to 5 themes, every idea scored 0–10 on novelty, impact and feasibility.
4. **Development** of the best ideas: a use case, 3 to 5 steps, the risks, and how success is measured.
5. **Synthesis:** which idea to pursue and why, insights that only show when the ideas are seen together, a plan with time frames and go/no-go points, the riskiest assumption, the likely bias of the idea set, and open questions.

| Mode | Phases |
|---|---|
| `speed` | 2 rounds, themes and scores, synthesis |
| `balanced` | + existing work, 3 rounds, 3 ideas developed |
| `quality` | as Balanced, with 4 rounds and 4 ideas developed |

Where Fane differs from reasoner:

- **Existing work is used.** Reasoner searched for prior art and then gave it to no prompt. Here the rounds are told what already exists, and the scoring gives an idea that already exists a novelty of 3 or less and names the source.
- **Code picks the ideas to develop.** Reasoner developed the first three ideas the model marked "keep", in the order of its themes, whatever their scores. Fane ranks by score (novelty 0.4, impact 0.35, feasibility 0.25), takes the best of each theme in turn so three variants of one idea are not developed, and skips ideas with feasibility below 3.
- **Ids come from code.** An answer that names an idea of its own invention is ignored, so nothing made up reaches the result. In the text, ids are replaced by the ideas' titles.
- **The answer is written by code** from the scored ideas, with the recommendation first. A round, the development or the synthesis that fails is listed as a note, and the rest is still shown.

Greek answers get the article pipeline's spelling repairs (Latin look-alike letters, the dropped final ν).

```bash
vane "brainstorm ways a small bookshop can win back readers from online stores"
vane --brainstorm "names for a bakery in Thessaloniki" -o speed --out names.md
```

**Which models.** The models that passed the article trial (`cli/write/trial.json`), in the mode's price band: brainstorming needs good prose in the language and JSON answers, which that trial checks. When no model passed for Greek, the English pool is used. `--brainstorm-model a/x,b/y` sets the models.

**Measured live:**

- **CLI, Balanced:** "ways a small independent bookshop can win back readers from online stores" took 6 model calls, $0.04 and 171 s. It gave 15 ideas in 4 themes, 8 pages of existing work, and 3 ideas developed from 3 different themes, with a recommendation and a 3-step plan.
- **Web UI, Speed, Greek:** «δώσε μου ιδέες για να μειώσει ένα δημοτικό σχολείο τα πλαστικά μιας χρήσης» took 1 m 44 s and $0.010, giving 10 ideas in 4 themes. That run showed ids such as "R1I1" in the text, which led to the title replacement above.

**In Vane's web UI** (`patches/patch-brainstorm-chat.js`), the idea titles appear as each round lands, then the whole answer. Square brackets in model text become parentheses, because Vane's chat page rewrites every `[x]` of an answer. The modules are mounted from `cli/brainstorm` at `/fane/brainstorm`, or copied there by `node scripts/apply.mjs`.

Follow-up requests ("develop the third one") are not supported yet: the request goes to Vane as usual.

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

### Article benchmark

`scripts/article-bench.mjs` writes the articles in `bench/articles.json` (three English and three Greek topics, 600 words each) with `vane --article --json`. A fixed judge model (`--judge`, default `openai/gpt-6.1-terra-pro`, which no Quality chain uses) then fact-checks and audits each final article with the pipeline's own prompts. The pipeline's own scores change when its prompts change, and its fact-check sees the draft, not the final text. The judge's scores don't have those problems, so they are the ones to compare.

Per article it records:

- time and cost;
- words against the target;
- sources cited and their sites;
- stock phrases per 1,000 words;
- failed checks and skipped steps;
- the pipeline's own claim support and audit score, and the judge's.

The summary has medians per topic and an `ALL` row per mode. Results go to `bench/results/articles-<time>.json` and the articles to the folder of the same name, so you can read them.

```bash
node scripts/article-bench.mjs --key-from-vane                                   # Quality, 1 run, all topics
node scripts/article-bench.mjs --key-from-vane --only symplectic,ocean-el
node scripts/article-bench.mjs --key-from-vane --baseline bench/articles-baseline.json --fail-on-regression
```

Every article is paid. One 500-word Greek Quality article cost about $0.37, and the judge adds a few cents. `--budget` (default $5) stops before the next article once the spend has passed it. A failed article reports no cost, so its spend is not counted.

A regression means any of these: more failed runs, judged claim support or audit down 0.1, stock phrases up 2 per 1,000 words, the length miss up 15 points, cost up 50%, or time up 50% and by more than a minute. Balanced chains use the default judge, so benchmark Balanced with another `--judge`.

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
