import { LoreClient } from "./loreClient.js";
import { LeiClient } from "./leiClient.js";
import { summarizeThread, buildPatchset, applyTokenBudgetToThreadSummary, applyTokenBudgetToPatchset } from "./compact.js";
import { summarizeThreadLLM } from "./llmSummarizer.js";
import { ensureMaildir, writeToMaildir } from "./maildir.js";
import type { Message } from "./messageTypes.js";
import { B4Client } from "./b4Client.js";

export function createTools() {
  const lore = new LoreClient();
  const lei = new LeiClient();
  const b4 = new B4Client();

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

  function resolveMessageId(msg: Message): string | undefined {
    if (msg.messageId) return msg.messageId;
    const mid = msg.headers?.["message-id"];
    if (Array.isArray(mid)) return mid[0];
    if (typeof mid === "string") return mid;
    return undefined;
  }

  async function cacheMessagesToMaildir(messages: Message[], input: any): Promise<void> {
    if (!cacheEnabled(input?.cacheToMaildir)) return;
    const dir = resolveMaildirPath(input?.maildir);
    await ensureMaildir(dir);
    for (const m of messages) {
      await writeToMaildir(dir, { headers: m.headers, body: m.body, messageId: resolveMessageId(m) });
    }
  }

  async function fetchPatchMessages(input: any): Promise<Message[]> {
    if (await b4.isAvailable()) {
      try {
        const viaB4 = await b4.fetchSeries({ messageId: input.messageId, url: input.url });
        if (viaB4.length > 0) {
          return viaB4;
        }
      } catch {
        // Ignore and fallback to HTTP flow
      }
    }
    return lore.getThreadMbox({
      url: input.url,
      messageId: input.messageId,
      scope: input.scope ?? input.list,
      list: input.list
    });
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
          scope: { type: "string", description: "Override scope (mailing list), e.g., linux-kernel; defaults to 'all'" }
        },
        required: ["query"]
      },
      handler: async (input: any) => {
        const q: string = input.query;
        const limit: number = input.limit ?? 20;
        const scope: string | undefined = input.scope;
        // Try lei first for richer results, fallback to HTTP
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
          // ignore and fallback
        }
        const httpClient = scope && scope !== "all" ? new LoreClient({ scope }) : lore;
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
          cacheToMaildir: { type: "boolean", description: "Write fetched message to a Maildir (defaults to on; set false to disable)" },
          maildir: { type: "string", description: "Maildir path if caching is enabled (defaults to ./maildir or $LORE_MCP_MAILDIR)" }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        const msg = await lore.getMessageRaw({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        await cacheMessagesToMaildir([msg], input);
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
        const messages = await lore.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        await cacheMessagesToMaildir(messages, input);
        const totalMessages = messages.length;
        const hasPagination = input.page !== undefined || input.pageSize !== undefined;
        const rawPageSize = hasPagination ? Number(input.pageSize ?? maxMessages) : maxMessages;
        const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.floor(rawPageSize) : maxMessages;
        const page = hasPagination ? Math.max(1, Math.floor(Number(input.page ?? 1))) : 1;
        const startIndex = hasPagination ? (page - 1) * pageSize : 0;
        const pageMessages = hasPagination
          ? messages.slice(startIndex, startIndex + pageSize)
          : messages.slice(0, maxMessages);
        let summary = summarizeThread(pageMessages, { maxMessages: pageMessages.length || maxMessages, stripQuoted, shortBodyBytes });
        if (typeof input.tokenBudget === "number" && input.tokenBudget > 0) {
          summary = applyTokenBudgetToThreadSummary(summary, input.tokenBudget);
        }
        if (hasPagination) {
          const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalMessages / pageSize)) : 1;
          const structured = {
            page,
            pageSize,
            totalMessages,
            totalPages,
            hasMore: page < totalPages,
            items: summary.items
          };
          return {
            content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured
          } as any;
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
          maxMessages: { type: "number", default: 0, description: "0 = all messages" },
          stripQuoted: { type: "boolean", default: true },
          // LLM config overrides
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
        const messages = await lore.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        await cacheMessagesToMaildir(messages, input);
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
        const messages = await fetchPatchMessages(input);
        await cacheMessagesToMaildir(messages, input);
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
        const messages = await lore.getThreadMbox({ url: input.url, messageId: input.messageId, scope: input.scope ?? input.list, list: input.list });
        await cacheMessagesToMaildir(messages, input);
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

    apply_patchset: {
      name: "apply_patchset",
      description: "Use b4 am to apply or download a patch series into a local Git worktree",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Thread URL (resolved to Message-Id)" },
          messageId: { type: "string", description: "Message-Id to pass to b4" },
          repoPath: { type: "string", description: "Path to the Git repository (defaults to current working directory)" },
          noApply: { type: "boolean", description: "Invoke b4 am with --no-apply to only download patches" },
          additionalArgs: { type: "array", description: "Extra flags for b4 am", items: { type: "string" } }
        },
        anyOf: [
          { required: ["url"] },
          { required: ["messageId"] }
        ]
      },
      handler: async (input: any) => {
        if (!(await b4.isAvailable())) {
          throw new Error("b4 CLI is required but was not found in PATH");
        }
        const repoPath = input.repoPath || process.cwd();
        const additionalArgs = Array.isArray(input.additionalArgs)
          ? input.additionalArgs.map((s: any) => String(s))
          : undefined;
        const result = await b4.apply({
          messageId: input.messageId,
          url: input.url,
          cwd: repoPath,
          noApply: input.noApply ?? false,
          additionalArgs
        });
        const textParts = [
          `b4 am exited with code ${result.exitCode}`,
          result.stdout ? `\nstdout:\n${result.stdout}` : "",
          result.stderr ? `\nstderr:\n${result.stderr}` : ""
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: textParts.join("") }],
          structuredContent: result
        } as any;
      }
    }
    ,

    list_scopes: {
      name: "list_scopes",
      description: "List available mailing list scopes on lore.kernel.org",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      handler: async () => {
        const items = await lore.listScopes();
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
          structuredContent: { items }
        } as any;
      }
    }
  } as const;
}

export type ToolSet = ReturnType<typeof createTools>;