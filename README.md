# lore-mcp

`lore-mcp` is an MCP server that lets agents and IDEs search lore.kernel.org, inspect individual mails, and download entire threads through a single stdio process. The CLI and LLM integrations are still available for power users, but the primary workflow is to run the server and plug it into your MCP client.

## Quick Start

### Run directly from GitHub with npx
If you do not want a full clone, run the MCP server directly from the Git URL:

```bash
npx -y github:manorit2001/lore-mcp#master
```

This still runs over stdio, so MCP clients can use `command: "npx"` plus args. First run may take longer because `prepare` builds TypeScript before launch.

By default the server prints a startup banner to stderr: `lore-mcp server started (stdio transport)`. Set `LORE_MCP_SILENT_STARTUP=1` to disable it.

For reproducible setups, pin a tag or commit instead of `#master`.

## Connect to an MCP Client

### Claude Code CLI (global config)
Edit `~/.claude.json` so every project can reach the server. This example runs the Docker image directly (no wrapper) and persists the Maildir cache under `~/.cache/lore-mcp`.

```json
{
  "mcpServers": {
    "lore-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "github:manorit2001/lore-mcp#master",
      ],
      "env": {
        "LORE_BASE": "https://lore.kernel.org",
        "LORE_SCOPE": "all"
      }
    }
  }
}
```

Restart Claude Code CLI (new shell) so it picks up the change. 

### Claude Desktop
Use either the Node entry point or the Docker image.

**Node**
```bash
claude mcp add lore-mcp npx -y github:manorit2001/lore-mcp#master
```



`claude mcp list`    # confirm registration

Adjust the volume path so Claude can persist cache data. Restart Claude Desktop after adding the server.

### Other MCP clients (Cursor, Cline, Codex CLI, etc.)

```json
{
  "command": "npx",
  "args": ["-y", "github:manorit2001/lore-mcp#master"],
  "env": {
    "LORE_BASE": "https://lore.kernel.org",
    "LORE_SCOPE": "all"
  }
}
```

## Tools at a Glance

- `search_lore` – Run public-inbox/lore queries and return matching messages.
- `get_message_raw` – Fetch headers and body for a single message.
- `get_thread_mbox` – Download an entire thread as parsed messages.
- `get_thread_summary` – Produce a compact summary without using an LLM.
- `get_patchset` – Summarize multi-patch series, optionally including truncated diffs.
- `list_scopes` – Enumerate available lore.kernel.org mailing lists.
- `lore_help` – Show quick search syntax tips.
- `summarize_thread_llm` – Optional LLM-powered summary (see Advanced Topics).

## Configuration Basics

These environment variables cover the common deployments:

- `LORE_BASE` – Base URL (default `https://lore.kernel.org`).
- `LORE_SCOPE` – Default mailing list scope (default `all`).
- `LORE_MCP_MAILDIR` – Maildir location for cached messages (default `./maildir`).
- `LORE_CACHE_DIR` / `LORE_MCP_CACHE_DIR` – Disk cache directory for raw responses.
- `LORE_MCP_SILENT_STARTUP` – Set to `1` to suppress the startup banner on stderr.
- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` – Standard proxy support.

If the public-inbox `lei` binary is on `PATH`, `search_lore` will automatically use it for faster, more expressive queries; otherwise the server falls back to HTTP endpoints.

### Runtime Base URL Override

All tools accept an optional `baseUrl` parameter to query alternative lore instances at runtime without restarting the server:

```json
{
  "name": "search_lore",
  "arguments": {
    "query": "s:fix",
    "baseUrl": "https://lore.example.org"
  }
}
```

When `baseUrl` is omitted, tools use the `LORE_BASE` environment variable (default: `https://lore.kernel.org`).

## Development & Testing

- `npm run dev` – Start the server with ts-node for iterative changes.
- `npm test` – Build and run the Node test suite.
- `npm run typecheck` – Strict TypeScript checks without emitting files.

## Advanced Topics

### CLI Toolkit

Every MCP tool also has a CLI command, useful for scripting and regression tests.
```bash
npm run build
npm run cli -- help
npm run cli -- search --q 's:regression d:2024-01-01..' --scope linux-kernel --n 5
```

Additional helpers:
- `npm run cli -- cache …` – Populate a Maildir with messages or entire threads.
- `npm run cli -- help:lore` – Print a cheat sheet for public-inbox queries.

### LLM Summaries

`summarize_thread_llm` can produce abstractive summaries when you supply credentials for a provider:

- OpenAI / Anthropic – `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- Google Gemini – `GEMINI_API_KEY`
- Ollama – `OLLAMA_URL` (auto-detected if the daemon is running locally)
- LiteLLM router – `LITELLM_BASE_URL` and optional `LITELLM_API_KEY`
- Generic command – set `LLM_PROVIDER=command` and `LLM_CMD="<shell command>"`

Optional tuning variables: `LLM_MODEL`, `LLM_CONTEXT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_TEMPERATURE`, `LLM_BASE_URL`.

### Maildir & Disk Caching

The server writes fetched artifacts to a Maildir so repeated calls stay fast. Control it with:

- `maildir` input parameter (per request)
- `LORE_MCP_MAILDIR` for a global default
- `LORE_MCP_CACHE_MAILDIR=0` to disable Maildir writes

Raw responses and thread archives also live under the cache directory governed by `LORE_CACHE_DIR`.

### Optional `lei` Integration

Installing the public-inbox `lei` binary unlocks faster searches while keeping deployments portable when `lei` is absent.
```bash
lei --version
```

When available, `search_lore` shells out to `lei`; otherwise it continues to use HTTPS endpoints.

## Developer builds

### Run with Node.js
```bash
npm install
npm run build
npm start        # runs the MCP server (dist/index.js) over stdio
```

The server caches fetched mail in `./maildir` by default. Override with `LORE_MCP_MAILDIR=/path/to/maildir`. During development you can use `npm run dev` to execute the TypeScript entry via ts-node.

### Run with Docker
```bash
docker build -t lore-mcp .
docker run --rm -it lore-mcp
```

Mount a persistent Maildir if you want cache reuse:
```bash
docker run --rm -it -v "$PWD/maildir:/data/maildir" lore-mcp
```

**Node**
```bash
claude mcp add lore-mcp node /absolute/path/to/lore-mcp/dist/index.js
```

**Docker**
```bash
claude mcp add lore-mcp docker run --rm -i \
  -v /absolute/path/to/maildir:/data/maildir \
  lore-mcp
```

