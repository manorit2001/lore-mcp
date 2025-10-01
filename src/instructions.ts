export const loreQuickHelp = `lore.kernel.org search quick reference (public-inbox)

Core concepts
- Message lookup: https://lore.kernel.org/<scope>/<Message-ID>/
  - Use without angle brackets, escape '/' as %2F
- Threads:
  - Flat:    <message-url>/T/#u
  - Nested:  <message-url>/t/#u
  - Mbox.gz: <message-url>/t.mbox.gz (mboxrd format)
  - Atom:    <message-url>/t.atom

Search basics (Xapian syntax)
- Boolean: AND (default), OR, NOT, + (must), - (exclude)
- Grouping: parentheses
- Phrases: quoted strings
- Wildcards: * (for probabilistic fields)

Common prefixes
- s:    subject text                e.g. s:"regression fix"
- b:    body (includes text attachments)
- nq:   non-quoted body text        q: quoted body text
- f:    From: header                t: To:  c: Cc:
- a:    Any of To/Cc/From           tc: To or Cc
- l:    List-Id header
- bs:   Subject + body
- d:    date/time range (approxidate)
        examples: d:2024-01-01..2024-12-31
                  d:last.week..  d:..2.days.ago
- rt:   received time (like d: if sender clock is correct)
- Diff-related:
  dfn: filename   dfa: removed(-)  dfb: added(+)  dfhh: hunk header
  dfctx: context  dfpre: pre-image blob  dfpost: post-image blob  dfblob: either
- Other headers: patchid:, forpatchid:, changeid:

Feed search endpoint
- Atom feed: https://lore.kernel.org/<scope>/?q=<query>&x=A

Examples
- Recent regressions in 2024 on linux-kernel:
  q = 's:regression d:2024-01-01.. l:linux-kernel'
- Patches touching a file path pattern:
  q = 'dfn:drivers/net/* s:"Fix"'
- From a specific author with quoted text match:
  q = 'f:"Alice Example" q:"call trace" d:last.month..'

Notes
- Most prefixes (except ranges/booleans) support stemming and wildcards.
- See full help: https://lore.kernel.org/all/_/text/help/
`;

export const serverInstructions = `lore-mcp: lore.kernel.org tools\n\nTools\n- search_lore { query, limit?, scope? }\n  Searches with public-inbox syntax. Uses lei if available, else Atom feed (x=A).\n  scope: optional mailing list (e.g., linux-kernel). Defaults to 'all'.\n  Returns: { subject, from?, date?, url, messageId?, list? }[]\n\n- get_message_raw { url? | messageId, scope? }\n  Fetches RFC822 headers + body via <message-url>/raw.\n\n- get_thread_mbox { url? | messageId, scope?, maxMessages?, maxBodyBytes? }\n  Fetches <message-url>/t.mbox.gz, gunzips + parses mbox into messages.\n\n- get_thread_summary { url? | messageId, scope?, maxMessages?, stripQuoted?, shortBodyBytes? }\n  Compact thread view: per-message meta + short bodies + key trailers.\n\n- get_patchset { url? | messageId, scope?, statOnly?, includeDiffs?, maxFiles?, maxHunksPerFile?, maxHunkLines? }\n  Extract a patch series: aggregate/per-patch stats and optional truncated diffs.\n\n- list_scopes { }\n  Lists available mailing list scopes from lore.kernel.org root.\n\nEfficient usage (keep context small)\n- Prefer staged retrieval:\n  1) search_lore with a small limit and a scope;\n  2) get_patchset { statOnly: true } to size the change;\n  3) get_thread_summary { stripQuoted: true, tokenBudget?: N } to read key feedback;\n  4) summarize_thread_llm when you want a faithful abstractive summary without truncation;\n  5) get_patchset { includeDiffs: true, tokenBudget?: N, maxFiles, maxHunksPerFile, maxHunkLines } to inspect diffs;\n  6) get_thread_mbox only when full raw context is needed.\n- Use tokenBudget (soft cap) to trim bodies/diffs on summary/patchset.\n- Keep limits tight: maxMessages, maxBodyBytes, maxFiles, maxHunksPerFile, maxHunkLines.\n- Cache to Maildir to avoid refetching: caching defaults ON. Disable with cacheToMaildir: false or env LORE_MCP_CACHE_MAILDIR=0. Path via maildir or env LORE_MCP_MAILDIR (defaults to ./maildir).\n\nLLM config (env)\n- Provide credentials/endpoints for at least one backend: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, LITELLM_BASE_URL (or LITELLM_API_KEY), OLLAMA_URL/OLLAMA_HOST, or set LLM_CMD.\n- Optional: LLM_PROVIDER (openai|anthropic|google|ollama|litellm|command|mock), LLM_MODEL, LLM_CONTEXT_TOKENS, LLM_MAX_OUTPUT_TOKENS, LLM_TEMPERATURE, LLM_BASE_URL.\n-  You can override per-call via summarize_thread_llm inputs.\n\nQuery Syntax Quick Reference\n${loreQuickHelp}\n`;