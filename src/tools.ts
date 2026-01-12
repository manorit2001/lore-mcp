import { LoreClient, LoreClientOptions } from "./loreClient.js";
import { LeiClient } from "./leiClient.js";
import { summarizeThread, buildPatchset, applyTokenBudgetToThreadSummary, applyTokenBudgetToPatchset } from "./compact.js";
import { summarizeThreadLLM } from "./llmSummarizer.js";
import { ensureMaildir, writeToMaildir } from "./maildir.js";

export function createTools() {
  const lei = new LeiClient();

  function createClient(baseUrl?: string, scope?: string): LoreClient {
    const opts: LoreClientOptions = {};
    if (baseUrl) opts.baseUrl = baseUrl;
    if (scope && scope !== "all") opts.scope = scope;
    return new LoreClient(opts);
  }

  function cacheEnabled(flag: any): boolean {
    if (flag === false) return false;
    if (flag === true) return true;
    const env = process.env.LORE_MCP_CACHE_MAILDIR;
    if (env === "0") return false;
    // default ON unless explicitly disabled
    return true;
  }

  function resolveMaildirPath(input?: string): string {
    return input || process.env.LORE_MCP_MAILDIR || "./maildir";
  }

  return {
    search_lore: {
      name: "search_lore",
      description: "Search lore.kernel.org. Optional scope=<list> to restrict to a mailing list. Uses lei if available, else Atom feed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "public-inbox query, e.g., df:2024-01-01.. s:subject l:linux-kernel" },
          limit: { type: "number", default: 20 },
          scope: { type: "string", description: "Override scope (mailing list), e.g., linux-kernel; defaults to 'all'" },
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" }
        },
        required: ["query"]
      },
      handler: async (input: any) => {
        const q: string = input.query;
        const limit: number = input.limit ?? 20;
        const scope: string | undefined = input.scope;
        try {
          if (await lei.isAvailable()) {
            const qWithScope = scope && scope !== "all" ? `${q} l:${scope}` : q;
            const items = await lei.search(qWithScope, limit);
            return {
              content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
              structuredContent: { items }
            } as any;
          }
        } catch {
        }
        const httpClient = createClient(input.baseUrl, scope);
        const items = await httpClient.search(q, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
          structuredContent: { items }
        } as any;
      }
    },

    get_message_raw: {
      name: "get_message_raw",
      description: "Fetch a single message as raw-parsed headers + body from lore.kernel.org",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full message URL" },
          messageId: { type: "string", description: "Message-Id, e.g., 20210101123456.1234-1-foo@bar" },
          scope: { type: "string", description: "Mailing list scope, e.g., linux-kernel; optional when using /r/" },
          list: { type: "string", description: "(Deprecated) Alias for scope" },
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" },
          cacheToMaildir: { type: "boolean", description: "Write fetched message to a Maildir (defaults to on; set false to disable)" },
          maildir: { type: "string", description: "Maildir path if caching is enabled (defaults to ./maildir or $LORE_MCP_MAILDIR)" }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        const client = createClient(input.baseUrl);
        const msg = await client.getMessageRaw({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        const shouldCache = cacheEnabled(input.cacheToMaildir);
        if (shouldCache) {
          const dir = resolveMaildirPath(input.maildir);
          await ensureMaildir(dir);
          const mid = msg.messageId || (msg.headers && (msg.headers["message-id"] as string)) || undefined;
          await writeToMaildir(dir, { headers: msg.headers, body: msg.body, messageId: mid });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(msg, null, 2) }],
          structuredContent: msg
        } as any;
      }
    },

    get_thread_summary: {
      name: "get_thread_summary",
      description: "Return a compact summary of a thread: meta + short bodies + key trailers (optionally stripping quoted text)",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          messageId: { type: "string" },
          scope: { type: "string" },
          list: { type: "string", description: "(Deprecated) Alias for scope" },
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" },
          maxMessages: { type: "number", default: 50 },
          stripQuoted: { type: "boolean", default: true },
          shortBodyBytes: { type: "number", default: 1200 },
          tokenBudget: { type: "number", description: "Approximate token cap; trims bodies/items to target" },
          cacheToMaildir: { type: "boolean", description: "Write thread messages to a Maildir (defaults to on; set false to disable)" },
          maildir: { type: "string", description: "Maildir path if caching is enabled (defaults to ./maildir or $LORE_MCP_MAILDIR)" }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        const maxMessages = input.maxMessages ?? 50;
        const stripQuoted = input.stripQuoted ?? true;
        const shortBodyBytes = input.shortBodyBytes ?? 1200;
        const client = createClient(input.baseUrl);
        const messages = await client.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        const shouldCache = cacheEnabled(input.cacheToMaildir);
        if (shouldCache) {
          const dir = resolveMaildirPath(input.maildir);
          await ensureMaildir(dir);
          for (const m of messages) {
            const mid = m.messageId || (m.headers && (m.headers["message-id"] as string)) || undefined;
            await writeToMaildir(dir, { headers: m.headers, body: m.body, messageId: mid });
          }
        }
        let summary = summarizeThread(messages, { maxMessages, stripQuoted, shortBodyBytes });
        if (typeof input.tokenBudget === "number" && input.tokenBudget > 0) {
          summary = applyTokenBudgetToThreadSummary(summary, input.tokenBudget);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          structuredContent: summary
        } as any;
      }
    },
    
    summarize_thread_llm: {
      name: "summarize_thread_llm",
      description: "Summarize a full thread with a large-context LLM (map-reduce when needed) to avoid truncation and preserve key details.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          messageId: { type: "string" },
          scope: { type: "string" },
          list: { type: "string", description: "(Deprecated) Alias for scope" },
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" },
          maxMessages: { type: "number", default: 0, description: "0 = all messages" },
          stripQuoted: { type: "boolean", default: true },
          provider: { type: "string", description: "openai | anthropic | google | ollama | command | mock | litellm (default auto-detected)" },
          model: { type: "string" },
          contextTokens: { type: "number", description: "Approx. model context window tokens (default auto)" },
          maxOutputTokens: { type: "number", description: "Cap for summary length (tokens)" },
          temperature: { type: "number" },
          strategy: { type: "string", enum: ["auto", "single", "map-reduce"], default: "auto" },
          cacheToMaildir: { type: "boolean", description: "Write thread messages to a Maildir (defaults to on; set false to disable)" },
          maildir: { type: "string", description: "Maildir path if caching is enabled (defaults to ./maildir or $LORE_MCP_MAILDIR)" }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        const client = createClient(input.baseUrl);
        const messages = await client.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        const shouldCache = cacheEnabled(input.cacheToMaildir);
        if (shouldCache) {
          const dir = resolveMaildirPath(input.maildir);
          await ensureMaildir(dir);
          for (const m of messages) {
            const mid = m.messageId || (m.headers && (m.headers["message-id"] as string)) || undefined;
            await writeToMaildir(dir, { headers: m.headers, body: m.body, messageId: mid });
          }
        }
        const summary = await summarizeThreadLLM(messages, {
          stripQuoted: input.stripQuoted ?? true,
          maxMessages: input.maxMessages ?? 0,
          provider: input.provider,
          model: input.model,
          contextTokens: input.contextTokens,
          maxOutputTokens: input.maxOutputTokens,
          temperature: input.temperature,
          strategy: input.strategy,
        });
        const text = [
          `Overview:\n${summary.overview}`,
          summary.key_points?.length ? `\nKey Points:\n- ${summary.key_points.join("\n- ")}` : "",
          summary.decisions?.length ? `\nDecisions:\n- ${summary.decisions.join("\n- ")}` : "",
          summary.open_questions?.length ? `\nOpen Questions:\n- ${summary.open_questions.join("\n- ")}` : "",
          summary.action_items?.length ? `\nAction Items:\n- ${summary.action_items.join("\n- ")}` : "",
          summary.version_notes?.length ? `\nVersion Notes:\n- ${summary.version_notes.join("\n- ")}` : "",
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: summary
        } as any;
      }
    },

    get_patchset: {
      name: "get_patchset",
      description: "Extract a patch series from a thread and return compact stats and optionally truncated diffs",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          messageId: { type: "string" },
          scope: { type: "string" },
          list: { type: "string", description: "(Deprecated) Alias for scope" },
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" },
          statOnly: { type: "boolean", default: true },
          includeDiffs: { type: "boolean", default: false },
          maxFiles: { type: "number", default: 10 },
          maxHunksPerFile: { type: "number", default: 3 },
          maxHunkLines: { type: "number", default: 80 },
          tokenBudget: { type: "number", description: "Approximate token cap when includeDiffs is true" },
          cacheToMaildir: { type: "boolean", description: "Write thread messages to a Maildir (defaults to on; set false to disable)" },
          maildir: { type: "string", description: "Maildir path if caching is enabled (defaults to ./maildir or $LORE_MCP_MAILDIR)" }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        const client = createClient(input.baseUrl);
        const messages = await client.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        const shouldCache = cacheEnabled(input.cacheToMaildir);
        if (shouldCache) {
          const dir = resolveMaildirPath(input.maildir);
          await ensureMaildir(dir);
          for (const m of messages) {
            const mid = m.messageId || (m.headers && (m.headers["message-id"] as string)) || undefined;
            await writeToMaildir(dir, { headers: m.headers, body: m.body, messageId: mid });
          }
        }
        const patchset = buildPatchset(messages, {
          statOnly: input.statOnly ?? true,
          includeDiffs: input.includeDiffs ?? false,
          maxFiles: input.maxFiles ?? 10,
          maxHunksPerFile: input.maxHunksPerFile ?? 3,
          maxHunkLines: input.maxHunkLines ?? 80
        });
        const adjusted = (patchset && input.includeDiffs && typeof input.tokenBudget === "number" && input.tokenBudget > 0)
          ? applyTokenBudgetToPatchset(patchset, input.tokenBudget)
          : patchset;
        return {
          content: [{ type: "text", text: JSON.stringify(patchset, null, 2) }],
          structuredContent: adjusted
        } as any;
      }
    },

    get_thread_mbox: {
      name: "get_thread_mbox",
      description: "Fetch an entire thread via mbox and return parsed messages (headers + body)",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          messageId: { type: "string" },
          scope: { type: "string" },
          list: { type: "string", description: "(Deprecated) Alias for scope" },
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" },
          maxMessages: { type: "number", default: 50 },
          maxBodyBytes: { type: "number", default: 20000 },
          cacheToMaildir: { type: "boolean", description: "Write thread messages to a Maildir (defaults to on; set false to disable)" },
          maildir: { type: "string", description: "Maildir path if caching is enabled (defaults to ./maildir or $LORE_MCP_MAILDIR)" }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        const maxMessages = input.maxMessages ?? 50;
        const maxBodyBytes = input.maxBodyBytes ?? 20000;
        const client = createClient(input.baseUrl);
        const messages = await client.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        const shouldCache = cacheEnabled(input.cacheToMaildir);
        if (shouldCache) {
          const dir = resolveMaildirPath(input.maildir);
          await ensureMaildir(dir);
          for (const m of messages) {
            const mid = m.messageId || (m.headers && (m.headers["message-id"] as string)) || undefined;
            await writeToMaildir(dir, { headers: m.headers, body: m.body, messageId: mid });
          }
        }
        const trimmed = messages.slice(0, maxMessages).map(m => ({
          ...m,
          body: m.body.length > maxBodyBytes ? m.body.slice(0, maxBodyBytes) + `\n...[truncated ${m.body.length - maxBodyBytes} bytes]` : m.body
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }],
          structuredContent: { items: trimmed }
        } as any;
      }
    }
    ,

    list_scopes: {
      name: "list_scopes",
      description: "List available mailing list scopes on lore.kernel.org",
      inputSchema: {
        type: "object",
        properties: {
          baseUrl: { type: "string", format: "uri", description: "Base URL for lore instance (default: https://lore.kernel.org)" }
        }
      },
      handler: async (input: any) => {
        const client = createClient(input?.baseUrl);
        const items = await client.listScopes();
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
          structuredContent: { items }
        } as any;
      }
    }
  } as const;
}

export type ToolSet = ReturnType<typeof createTools>;