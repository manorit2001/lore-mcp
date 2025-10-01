# lore-mcp

MCP server exposing tools to search and fetch messages and threads from the lore.kernel.org mailing list archives. Optionally integrates with the `lei` CLI (from public-inbox) if present for richer queries and local caching.

## Why this approach

- HTTP-first: Uses public-inbox Atom search (`x=A`) + raw/t.mbox.gz endpoints for portability. No native deps required at runtime beyond Node.
- Optional `lei`: If `lei` is installed, the server will use it for `search_lore` to leverage faster, more expressive queries and local caches.
- Focused tools: Search, fetch message, fetch thread. Keep the MCP simple and composable for downstream LLM reasoning.

## Tools & CLI Equivalents

Each MCP tool has a matching CLI command. Examples below mirror the live integration coverage in `test/cli.integration.test.js`, which exercises the CLI against lore.kernel.org and highlights how the JSON payload you'd send over MCP lines up with the CLI arguments.

### `search_lore` ↔ `npm run cli -- search`
- What it does: runs a public-inbox query (prefers `lei` when available, otherwise falls back to Atom).
- MCP call:
  ```json
  {
    "tool": "search_lore",
    "arguments": { "query": "s:regression d:2024-01-01..", "limit": 5, "scope": "linux-kernel" }
  }
  ```
- CLI equivalent:
  ```bash
  npm run cli -- search --q 's:regression d:2024-01-01..' --scope linux-kernel --n 5
  ```
- Returns: array of `{ subject, from?, date?, url, messageId?, list? }`.

### `get_message_raw` ↔ `npm run cli -- message`
- Fetches headers + body for a single message (adds `/raw` behind the scenes).
- MCP call:
  ```json
  {
    "tool": "get_message_raw",
    "arguments": { "url": "https://lore.kernel.org/r/<msgid>" }
  }
  ```
- CLI equivalent:
  ```bash
  npm run cli -- message --url https://lore.kernel.org/r/<msgid>
  # or: npm run cli -- message --mid '<msgid>' --scope linux-kernel
  ```
- Output: `{ headers: Record<string,string|string[]>, body: string, messageId?, url? }`.

### `get_thread_mbox` ↔ `npm run cli -- thread`
- Downloads the compressed `t.mbox.gz`, expands it, returns an array of messages.
- MCP call:
  ```json
  {
    "tool": "get_thread_mbox",
    "arguments": { "url": "https://lore.kernel.org/r/<msgid>", "maxMessages": 50, "maxBodyBytes": 20000 }
  }
  ```
- CLI equivalent:
  ```bash
  npm run cli -- thread --url https://lore.kernel.org/r/<msgid> --maxMessages 10 --maxBodyBytes 20000
  ```
- Each item mirrors `get_message_raw`, with optional truncation when you pass `maxMessages` / `maxBodyBytes`.

### `get_thread_summary` ↔ `npm run cli -- summary`
- Generates a compact, non-LLM summary (`summarizeThread`) with optional quote stripping and token budgeting.
- MCP call:
  ```json
  {
    "tool": "get_thread_summary",
    "arguments": {
      "url": "https://lore.kernel.org/r/<msgid>",
      "maxMessages": 40,
      "stripQuoted": true,
      "shortBodyBytes": 1200,
      "tokenBudget": 8000
    }
  }
  ```
- CLI equivalent:
  ```bash
  # Full compact view
  npm run cli -- summary --url https://lore.kernel.org/r/<msgid> --maxMessages 40 --stripQuoted --tokenBudget 8000
  # Header-only, de-duplicated view
  npm run cli -- summary --url https://lore.kernel.org/r/<msgid> --format normalized
  ```
- Output: `{ items: [{ subject, from?, date?, messageId?, kind, body, hasDiff, trailers: [...] }] }` or the normalized form.

### `summarize_thread_llm` ↔ `npm run cli -- summarize-thread`
- Runs an abstractive LLM pass with map/reduce fallback for long threads. Auto-detects providers (OpenAI, Anthropic, Google Gemini, LiteLLM, Ollama, command, mock).
- MCP call:
  ```json
  {
    "tool": "summarize_thread_llm",
    "arguments": {
      "url": "https://lore.kernel.org/r/<msgid>",
      "strategy": "auto",
      "provider": "litellm",
      "model": "gpt-4o-mini",
      "contextTokens": 120000,
      "maxOutputTokens": 1200
    }
  }
  ```
- CLI equivalent:
  ```bash
  npm run cli -- summarize-thread --url https://lore.kernel.org/r/<msgid> \
    --provider litellm --model gpt-4o-mini --maxMessages 0 --strategy auto --timings
  ```
- Returns structured JSON `{ overview, key_points?, decisions?, open_questions?, action_items?, version_notes?, participants?, model?, usage?, raw? }`.

### `get_patchset` ↔ `npm run cli -- patchset`
- Collapses `[PATCH vX Y/Z]` series into aggregate stats and optional truncated diffs.
- MCP call:
  ```json
  {
    "tool": "get_patchset",
    "arguments": {
      "url": "https://lore.kernel.org/r/<msgid>",
      "statOnly": false,
      "includeDiffs": true,
      "maxFiles": 20,
      "maxHunksPerFile": 5,
      "maxHunkLines": 200,
      "tokenBudget": 8000
    }
  }
  ```
- CLI equivalent:
  ```bash
  # Stats only (fastest)
  npm run cli -- patchset --url https://lore.kernel.org/r/<msgid> --statOnly
  # Include truncated diffs with a soft token cap
  npm run cli -- patchset --url https://lore.kernel.org/r/<msgid> --includeDiffs --tokenBudget 6000
  ```
- Output: `Patchset` object with `series`, `patches[]`, and `aggregate` diff stats (and optionally truncated `diffs`).

### `list_scopes` ↔ `npm run cli -- scopes`
- Scrapes the root lore index and returns `{ scope, url, title?, updated? }[]`.
- MCP call: `{ "tool": "list_scopes" }`
- CLI equivalent: `npm run cli -- scopes`

### `lore_help` ↔ `npm run cli -- help:lore`
- Prints the public-inbox search cheat sheet bundled in `src/instructions.ts`.
- MCP call: `{ "tool": "lore_help" }`
- CLI equivalent: `npm run cli -- help:lore`

### CLI-only helpers
- `npm run cli -- help` – command overview (mirrors this section).
- `npm run cli -- cache …` – populate a Maildir on disk (defaults to `./maildir`).

## Setup

Requirements: Node.js >= 18.17

### Run the MCP server

Recommended (build first, then run the compiled JS):

```bash
npm install
npm run build
npm start      # runs: node dist/index.js
```

Development (run TypeScript directly via ts-node ESM loader):

```bash
npm run dev    # runs: node --loader ts-node/esm src/index.ts
```

Notes:
- Do not run `node src/index.ts` directly — Node cannot execute `.ts` files without a loader.
- The server speaks MCP over stdio and can be registered in any MCP-compatible client.

### CLI

Build first, then run the CLI:

```bash
npm run build
npm run cli -- help
npm run cli -- help:lore
npm run cli -- search --q 's:regression d:2024-01-01.. l:linux-kernel' --n 5
npm run cli -- message --mid 20210101123456.1234-1-foo@bar --scope lkml
npm run cli -- thread --mid 20210101123456.1234-1-foo@bar --scope lkml --maxMessages 10 --maxBodyBytes 20000
npm run cli -- summary --mid 20210101123456.1234-1-foo@bar --format normalized   # fastest header-only summary
npm run cli -- scopes

### Cache to Maildir

Create a local Maildir with messages (or full threads) for a query without requiring `lei`:

```
npm run build
npm run cli -- cache --q 's:regression d:2024-01-01..' --scope linux-kernel --n 25 --maildir ./maildir
# Fetch full threads instead of individual messages:
npm run cli -- cache --q 's:regression d:2024-01-01..' --scope linux-kernel --n 10 --threads --maildir ./maildir
```

Options:
- `--q, --query` public-inbox query
- `--n, --limit` number of search hits to fetch
- `--scope` mailing list scope (e.g. `linux-kernel`, `lkml`); defaults to `all`
- `--threads` fetch full `t.mbox.gz` threads for each hit
- `--maildir` destination Maildir path (default: `./maildir`)
- `--concurrency` parallel fetches (default: 2)
```

The CLI follows the same behavior as tools: tries `lei` for search when available, otherwise uses Atom (`x=A`).

### Optional: Install `lei`

`lei` comes from the public-inbox project.
When installed and on `PATH`, `search_lore` will prefer it for query execution:

```bash
lei --version
```

## Configuration

Environment variables:

- `LORE_BASE` (default: `https://lore.kernel.org`)
- `LORE_SCOPE` (default: `all`) – set to a specific list like `linux-kernel` to scope searches.
- `LORE_SCOPES_TTL_MS` (default: `600000`) – cache TTL for `list_scopes` results in milliseconds.
 - `LORE_MSG_TTL_MS` (default: `86400000`) – in-memory + disk TTL for single message fetches.
 - `LORE_THREAD_TTL_MS` (default: `86400000`) – in-memory + disk TTL for thread mbox fetches.
 - `LORE_CACHE_DIR` or `LORE_MCP_CACHE_DIR` – root directory for persistent artifact cache. Defaults to `${XDG_CACHE_HOME}/lore-mcp` or `~/.cache/lore-mcp`.
 - `LORE_DISABLE_DISK_CACHE=1` – disable persistent artifact caching.

### Artifact caching

When fetching by message-id or URL, the MCP now also caches fetched artifacts on disk:

- Raw message bodies are stored under `<cache>/raw/<msgid>.raw`.
- Thread archives are stored under `<cache>/threads/<msgid>.t.mbox.gz`.

Disk caches honor the same TTLs as in-memory caches (`LORE_MSG_TTL_MS`, `LORE_THREAD_TTL_MS`). Set `LORE_DISABLE_DISK_CACHE=1` to turn this off.

## Compact retrieval and token budgeting

For LLM workflows, prefer compact tools before expanding to raw threads:

- Stage 1: `search_lore` → show headers only.
- Stage 2: `get_patchset` with `statOnly: true` to preview scope of change.
- Stage 3: `get_thread_summary` with `stripQuoted: true` and optionally `tokenBudget: <N>` to review key feedback.
- Stage 4: `get_patchset` with `includeDiffs: true`, a `tokenBudget`, and small caps (`maxFiles`, `maxHunksPerFile`, `maxHunkLines`) to inspect diffs.
- Stage 5: `get_thread_mbox` for full context when necessary.

Token budget model (soft):
- `tokenBudget` is approximate (~4 chars per token) and allows ~10% overflow to avoid over-truncation.
- For summaries: trims bodies and reduces item count to fit.
- For patchsets with diffs: prunes trailing diffs and trims last diff to fit.

Caching to Maildir (default ON):
- Any of `get_message_raw`, `get_thread_mbox`, `get_thread_summary`, `get_patchset` will cache messages to a Maildir by default.
- Disable per-call with `cacheToMaildir: false` or globally via `LORE_MCP_CACHE_MAILDIR=0`.
- Destination path:
  - `maildir` input param, or
  - `LORE_MCP_MAILDIR` env var, or
  - defaults to `./maildir` (created if missing; standard Maildir layout: `tmp/`, `new/`, `cur/`).

## Using `lei` vs. HTTP scraping

- Pros of `lei`:
  - High-performance, expressive search syntax across mirrors with local caching.
  - Robust JSON output and stable query semantics.
  - Better resilience to layout changes vs HTML/Atom parsing.
- Cons of `lei`:
  - Requires native installation and indexing/mirroring for best performance.
  - Adds an external runtime dependency to your MCP deployment.

- Pros of HTTP approach:
  - Zero native deps; easier to deploy in containerized/cloud environments.
  - Good enough for on-demand fetches and small to medium searches.
- Cons of HTTP approach:
  - Dependent on Atom/endpoint stability; requires custom parsing.
  - Less feature-complete than `lei` for advanced queries and offline use.

Recommendation: For this project, default to HTTP for portability and low friction, and opportunistically use `lei` when available (as implemented here). If you plan heavy usage or offline workflows, standardize on `lei` and consider having the MCP shell out to `lei` exclusively.

## MCP Client Setup

Below are example configurations for popular MCP clients. All clients run this server via stdio by spawning `node dist/index.js`.

Build the server first:

```bash
npm install
npm run build
```

### Claude Desktop

Create or edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add an entry under `mcpServers` (adjust the absolute path):

```json
{
  "mcpServers": {
    "lore-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/lore-mcp/dist/index.js"],
      "env": {
        "LORE_BASE": "https://lore.kernel.org",
        "LORE_SCOPE": "all",
        "LORE_SCOPES_TTL_MS": "600000",
        "LORE_MSG_TTL_MS": "86400000",
        "LORE_THREAD_TTL_MS": "86400000"
      }
    }
  }
}
```

Tips:
- Optional: install `lei` on your PATH so `search_lore` can use it (faster, richer queries).
- After saving, restart Claude Desktop. You should see tools like `search_lore`, `get_message_raw`, `get_thread_mbox`, `list_scopes`, and the resource `mcp://lore-mcp/scopes`.

Dev-only alternative (not recommended for production): you can register the TypeScript entry via ts-node by setting:

```json
{
  "command": "node",
  "args": ["--loader", "ts-node/esm", "/absolute/path/to/lore-mcp/src/index.ts"]
}
```
This requires `ts-node` to be available in the environment and will be slower than using the built output in `dist/`.

### Generic MCP Clients (Codex CLI, Cline, Cursor, etc.)

Most MCP clients support a JSON mapping like the above. If your client lets you register custom servers, point it to:

- Command: `node`
- Args: `/<absolute>/lore-mcp/dist/index.js`
- Env: any of `LORE_*` variables you need

Once registered:
- List tools to discover `search_lore`, `get_message_raw`, `get_thread_mbox`, `list_scopes`, `lore_help`.
- List resources to discover `mcp://lore-mcp/scopes` (JSON with available mailing lists).

### Quick Verification

- In your client, call `list_scopes` or read `mcp://lore-mcp/scopes` to verify connectivity.
- Try: `search_lore` with `{ "query": "s:regression d:2024-01-01..", "scope": "linux-kernel", "limit": 5 }`.
- Fetch a message: `get_message_raw` with `{ "messageId": "<msgid>", "scope": "lkml" }`.

## Notes and limits

- The RFC822 and mbox parsers are intentionally minimal. If you need robust MIME handling, plug in a full parser later.
- `get_thread_mbox` truncates messages for safety; tune `maxMessages`/`maxBodyBytes` for your client.
- For faithful summarization, use `summarize_thread_llm`. It avoids lossy truncation by chunking and combining results when needed.

### LLM configuration

Pick one of the following setups:

1) OpenAI/Anthropic (cloud)
   - Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
   - Optional: `LLM_PROVIDER`, `LLM_MODEL`, `LLM_CONTEXT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_TEMPERATURE`, `LLM_BASE_URL`.

2) Google Gemini (cloud, native HTTP)
   - Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).
   - Optional: `LLM_PROVIDER=google`, `LLM_MODEL=gemini-1.5-flash` (default) or another Gemini model,
     `LLM_CONTEXT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_TEMPERATURE`, `LLM_BASE_URL` (override base endpoint if needed).
   - This avoids spawning an external CLI and is typically faster/leaner than `npx gemini-cli`.

3) Ollama (local, no API key)
   - Install Ollama and run the server: `ollama serve`
   - Pull a model with a large context (e.g., `ollama pull llama3.1:8b-instruct`)
   - Set `LLM_PROVIDER=ollama` (optional; auto-detected if `OLLAMA_URL`/`OLLAMA_HOST` is present)
   - Optional: `OLLAMA_URL=http://127.0.0.1:11434`, `LLM_MODEL=llama3.1:8b-instruct`

4) LiteLLM proxy/router (self-hosted gateway)
   - Run LiteLLM locally (`litellm --port 4000`) or target an existing deployment.
   - Optional (auto-detected): `LITELLM_BASE_URL=http://127.0.0.1:4000`, `LITELLM_API_KEY=...`.
   - Configure provider/model routing via LiteLLM; override per call with `provider=litellm` or `LLM_MODEL`.

5) External CLI command (generic, bring-your-own CLI)
   - Set `LLM_PROVIDER=command` and `LLM_CMD` to a shell command that reads the prompt from stdin and writes the summary to stdout.
   - Examples:
     - Gemini CLI (requires a Google API key):
       - `npm i -g gemini-cli` (or use `npx -y gemini-cli`)
       - `export GOOGLE_API_KEY=...`
       - `export LLM_PROVIDER=command`
       - `export LLM_CMD='npx -y gemini-cli -m "gemini-1.5-pro" --no-stream'`
     - OpenRouter via curl (requires an API key):
       - `export OPENROUTER_API_KEY=...`
       - `export LLM_PROVIDER=command`
       - `export LLM_CMD='bash -lc "curl -s https://openrouter.ai/api/v1/chat/completions -H \"Authorization: Bearer $OPENROUTER_API_KEY\" -H \"Content-Type: application/json\" -d @- | jq -r .choices[0].message.content"'`
         (the client will pipe the prompt JSON/text into stdin)

Notes:
- Without any API keys, the most practical fallbacks are `ollama` (local inference) or a local LiteLLM proxy routing to free/local backends. Cloud CLIs like gemini-cli/openrouter still require their respective keys.

### Timing diagnostics

For slow runs, you can enable basic timing logs for the `summarize-thread` CLI command:

```
npm run cli -- summarize-thread --mid <msg-id> --timings
```

Or set `LORE_MCP_TIMINGS=1` in the environment. This prints the time spent fetching the thread and running the LLM call(s) to stderr.

## Testing

Run the full suite (TypeScript build + Node tests) with:

```bash
npm test
```

This uses the concise dot reporter. To view detailed per-test output, use:

```bash
npm run test:verbose
```

This prints detailed `[verbose] …` lines for each test, including request parameters and truncated payload previews where applicable.

This now covers:
- Library-level unit tests (`test/compact.*`, `test/llm.*`).
- Live CLI integration (`test/cli.integration.test.js`), which drives the CLI against lore.kernel.org and asserts the JSON shape of `search`, `message`, `thread`, `summary`, and `patchset`. These tests require outbound network access.
