import { loreQuickHelp } from "./instructions.js";
export { loreQuickHelp };
export const serverInstructions = `lore-mcp: lore.kernel.org mailing list tools for linux, u-boot, etc patch surfing

Tools
- search_lore { query, limit?, scope? }
  Searches with public-inbox syntax. Uses lei if available, else Atom feed (x=A).
  scope: optional mailing list (e.g., linux-kernel). Defaults to 'all'.
  Returns: { subject, from?, date?, url, messageId?, list? }[]

- get_message_raw { url? | messageId, scope? }
  Fetches RFC822 headers + body via <message-url>/raw.

- get_thread_mbox { url? | messageId, scope?, maxMessages?, maxBodyBytes? }
  Fetches <message-url>/t.mbox.gz, gunzips + parses mbox into messages.

- get_thread_summary { url? | messageId, scope?, maxMessages?, stripQuoted?, shortBodyBytes? }
  Compact thread view: per-message meta + short bodies + key trailers.

- summarize_thread_llm { url? | messageId, scope?, maxMessages?, stripQuoted?, provider?, model?, contextTokens?, maxOutputTokens?, temperature?, strategy? }
  Large-context abstractive summary using an LLM (auto-detects OpenAI, Anthropic, Google Gemini, LiteLLM, Ollama, or command backends via env).
  Uses a map-reduce strategy for threads that exceed the model context window to avoid dropping content.
  Returns: structured JSON (overview, key_points, decisions, open_questions, action_items, version_notes, participants).

- get_patchset { url? | messageId, scope?, statOnly?, includeDiffs?, maxFiles?, maxHunksPerFile?, maxHunkLines? }
  Extract a patch series: aggregate/per-patch stats and optional truncated diffs.

- list_scopes { }
  Lists available mailing list scopes from lore.kernel.org root.

Efficient usage (keep context small)
- Prefer staged retrieval:
  1) search_lore with a small limit and a scope;
  2) get_patchset { statOnly: true } to size the change;
  3) get_thread_summary { stripQuoted: true, tokenBudget?: N } to read key feedback;
  4) summarize_thread_llm when you want a faithful abstractive summary without truncation;
  5) get_patchset { includeDiffs: true, tokenBudget?: N, maxFiles, maxHunksPerFile, maxHunkLines } to inspect diffs;
  6) get_thread_mbox only when full raw context is needed.
- Use tokenBudget (soft cap) to trim bodies/diffs on summary/patchset.
- Keep limits tight: maxMessages, maxBodyBytes, maxFiles, maxHunksPerFile, maxHunkLines.
- Cache to Maildir to avoid refetching: caching defaults ON. Disable with cacheToMaildir: false or env LORE_MCP_CACHE_MAILDIR=0. Path via maildir or env LORE_MCP_MAILDIR (defaults to ./maildir).

LLM config (env)
- Provide credentials/endpoints for at least one backend: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, LITELLM_BASE_URL (or LITELLM_API_KEY), OLLAMA_URL/OLLAMA_HOST, or set LLM_CMD.
- Optional: LLM_PROVIDER (openai|anthropic|google|ollama|litellm|command|mock), LLM_MODEL, LLM_CONTEXT_TOKENS, LLM_MAX_OUTPUT_TOKENS, LLM_TEMPERATURE, LLM_BASE_URL.
-  You can override per-call via summarize_thread_llm inputs.

Query Syntax Quick Reference
${loreQuickHelp}
`;
