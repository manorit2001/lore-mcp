#!/usr/bin/env node
import { LoreClient } from "./loreClient.js";
import { LeiClient } from "./leiClient.js";
import { loreQuickHelp } from "./instructions.js";
import { summarizeThread, summarizeThreadNormalized, applyTokenBudgetToThreadSummary, buildPatchset, applyTokenBudgetToPatchset } from "./compact.js";
import { summarizeThreadLLM } from "./llmSummarizer.js";
function parseArgv(argv) {
    const [, , cmd = "help", ...rest] = argv;
    const args = {};
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t.startsWith("--")) {
            const key = t.slice(2);
            const nxt = rest[i + 1];
            if (!nxt || nxt.startsWith("--")) {
                args[key] = true;
            }
            else {
                args[key] = nxt;
                i++;
            }
        }
        else if (!args["_"]) {
            args["_"] = t;
        }
    }
    return { cmd, args };
}
async function main() {
    const { cmd, args } = parseArgv(process.argv);
    const lore = new LoreClient();
    const lei = new LeiClient();
    switch (cmd) {
        case "help":
            console.log(`lore-mcp CLI\n\nCommands:\n  help                         Show quick help\n  help:lore                    Show lore/public-inbox search quick reference\n  search --q <query> [--n N] [--scope LIST]\n                               Search via lei (if available) or Atom, optionally scoping to a mailing list\n  message (--url URL | --mid MSGID) [--scope LIST]\n  thread  (--url URL | --mid MSGID) [--scope LIST] [--maxMessages N] [--maxBodyBytes B]\n  summary (--url URL | --mid MSGID) [--scope LIST] [--maxMessages N] [--stripQuoted] [--shortBodyBytes B] [--tokenBudget T]\n                               Compact thread view with short non-quoted bodies and key trailers\n  patchset (--url URL | --mid MSGID) [--scope LIST] [--statOnly] [--includeDiffs] [--maxFiles N] [--maxHunksPerFile N] [--maxHunkLines N] [--tokenBudget T]\n                               Extract series stats and optionally truncated diffs\n  summarize-thread (--url URL | --mid MSGID) [--scope LIST] [--maxMessages N] [--stripQuoted] [--provider P] [--model M] [--contextTokens N] [--maxOutputTokens N] [--temperature X] [--strategy auto|single|map-reduce] [--timings]\n                               Abstractive LLM summary over the full thread (uses env OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / LITELLM_BASE_URL / OLLAMA_URL or LLM_CMD). Use --timings to log duration.\n  scopes                        List available mailing lists (scopes)\n  cache   --q <query> [--n N] [--scope LIST] [--threads] [--maildir PATH] [--concurrency N]\n                               Download messages (or full threads) into a local Maildir\n`);
            break;
        case "help:lore":
            console.log(loreQuickHelp);
            break;
        case "search": {
            const q = String(args.q || args.query || "");
            const n = Number(args.n || args.limit || 20);
            const scope = args.scope || args.list || "";
            if (!q) {
                console.error("search: --q <query> is required");
                process.exit(2);
            }
            let results;
            try {
                if (await lei.isAvailable()) {
                    const q2 = scope && scope !== 'all' ? `${q} l:${scope}` : q;
                    results = await lei.search(q2, n);
                }
                else {
                    const http = scope && scope !== 'all' ? new LoreClient({ scope }) : lore;
                    results = await http.search(q, n);
                }
            }
            catch (e) {
                console.error("search failed:", e);
                process.exit(1);
            }
            console.log(JSON.stringify(results, null, 2));
            break;
        }
        case "message": {
            const url = args.url || undefined;
            const messageId = args.mid || args.messageId || undefined;
            const scope = args.scope || args.list || undefined;
            if (!url && !messageId) {
                console.error("message: --url or --mid is required");
                process.exit(2);
            }
            try {
                const m = await lore.getMessageRaw({ url, messageId, scope });
                console.log(JSON.stringify(m, null, 2));
            }
            catch (e) {
                console.error("message fetch failed:", e);
                process.exit(1);
            }
            break;
        }
        case "thread": {
            const url = args.url || undefined;
            const messageId = args.mid || args.messageId || undefined;
            const scope = args.scope || args.list || undefined;
            const maxMessages = args.maxMessages ? Number(args.maxMessages) : undefined;
            const maxBodyBytes = args.maxBodyBytes ? Number(args.maxBodyBytes) : undefined;
            if (!url && !messageId) {
                console.error("thread: --url or --mid is required");
                process.exit(2);
            }
            try {
                const msgs = await lore.getThreadMbox({ url, messageId, scope });
                let out = msgs;
                if (typeof maxMessages === "number")
                    out = out.slice(0, maxMessages);
                if (typeof maxBodyBytes === "number") {
                    out = out.map((m) => ({
                        ...m,
                        body: m.body.length > maxBodyBytes
                            ? m.body.slice(0, maxBodyBytes) + `\n...[truncated ${m.body.length - maxBodyBytes} bytes]`
                            : m.body,
                    }));
                }
                console.log(JSON.stringify(out, null, 2));
            }
            catch (e) {
                console.error("thread fetch failed:", e);
                process.exit(1);
            }
            break;
        }
        case "summary": {
            const url = args.url || undefined;
            const messageId = args.mid || args.messageId || undefined;
            const scope = args.scope || args.list || undefined;
            const maxMessages = args.maxMessages ? Number(args.maxMessages) : 50;
            const stripQuoted = args.stripQuoted === undefined ? true : Boolean(args.stripQuoted);
            const shortBodyBytes = args.shortBodyBytes ? Number(args.shortBodyBytes) : 1200;
            const tokenBudget = args.tokenBudget ? Number(args.tokenBudget) : undefined;
            const format = (args.format || "full").toLowerCase();
            if (!url && !messageId) {
                console.error("summary: --url or --mid is required");
                process.exit(2);
            }
            try {
                const msgs = await lore.getThreadMbox({ url, messageId, scope });
                if (format === "normalized") {
                    const normalized = summarizeThreadNormalized(msgs, { maxMessages });
                    console.log(JSON.stringify(normalized, null, 2));
                }
                else {
                    const summary = summarizeThread(msgs, { maxMessages, stripQuoted, shortBodyBytes });
                    const adjusted = typeof tokenBudget === "number" && tokenBudget > 0
                        ? applyTokenBudgetToThreadSummary(summary, tokenBudget)
                        : summary;
                    console.log(JSON.stringify(adjusted, null, 2));
                }
            }
            catch (e) {
                console.error("summary failed:", e);
                process.exit(1);
            }
            break;
        }
        case "patchset": {
            const url = args.url || undefined;
            const messageId = args.mid || args.messageId || undefined;
            const scope = args.scope || args.list || undefined;
            const statOnly = args.statOnly === undefined ? false : Boolean(args.statOnly);
            const includeDiffs = args.includeDiffs ? Boolean(args.includeDiffs) : false;
            const maxFiles = args.maxFiles ? Number(args.maxFiles) : 10;
            const maxHunksPerFile = args.maxHunksPerFile ? Number(args.maxHunksPerFile) : 3;
            const maxHunkLines = args.maxHunkLines ? Number(args.maxHunkLines) : 80;
            const tokenBudget = args.tokenBudget ? Number(args.tokenBudget) : undefined;
            if (!url && !messageId) {
                console.error("patchset: --url or --mid is required");
                process.exit(2);
            }
            try {
                const msgs = await lore.getThreadMbox({ url, messageId, scope });
                const ps = buildPatchset(msgs, { statOnly, includeDiffs, maxFiles, maxHunksPerFile, maxHunkLines });
                if (!ps) {
                    console.log(JSON.stringify(null));
                    break;
                }
                const adjusted = (includeDiffs && typeof tokenBudget === "number" && tokenBudget > 0)
                    ? applyTokenBudgetToPatchset(ps, tokenBudget)
                    : ps;
                console.log(JSON.stringify(adjusted, null, 2));
            }
            catch (e) {
                console.error("patchset failed:", e);
                process.exit(1);
            }
            break;
        }
        case "summarize-thread": {
            const url = args.url || undefined;
            const messageId = args.mid || args.messageId || undefined;
            const scope = args.scope || args.list || undefined;
            const maxMessages = args.maxMessages ? Number(args.maxMessages) : undefined;
            const stripQuoted = args.stripQuoted === undefined ? true : Boolean(args.stripQuoted);
            const providerRaw = args.provider || undefined;
            const provider = providerRaw;
            const model = args.model || undefined;
            const contextTokens = args.contextTokens ? Number(args.contextTokens) : undefined;
            const maxOutputTokens = args.maxOutputTokens ? Number(args.maxOutputTokens) : undefined;
            const temperature = args.temperature !== undefined ? Number(args.temperature) : undefined;
            const strategy = args.strategy;
            const timings = Boolean(args.timings || process.env.LORE_MCP_TIMINGS);
            if (!url && !messageId) {
                console.error("summarize-thread: --url or --mid is required");
                process.exit(2);
            }
            try {
                const t0 = Date.now();
                if (timings)
                    console.error("[timing] fetching thread...");
                const msgs = await lore.getThreadMbox({ url, messageId, scope });
                const t1 = Date.now();
                if (timings)
                    console.error(`[timing] thread fetched in ${(t1 - t0) / 1000}s; messages=${msgs.length}`);
                if (timings)
                    console.error("[timing] LLM summarization starting...");
                const summary = await summarizeThreadLLM(msgs, { maxMessages, stripQuoted, provider, model, contextTokens, maxOutputTokens, temperature, strategy });
                const t2 = Date.now();
                if (timings)
                    console.error(`[timing] LLM summarization done in ${(t2 - t1) / 1000}s`);
                console.log(JSON.stringify(summary, null, 2));
            }
            catch (e) {
                console.error("summarize-thread failed:", e);
                process.exit(1);
            }
            break;
        }
        case "scopes": {
            try {
                const scopes = await lore.listScopes();
                console.log(JSON.stringify(scopes, null, 2));
            }
            catch (e) {
                console.error("scopes fetch failed:", e);
                process.exit(1);
            }
            break;
        }
        case "cache": {
            const q = String(args.q || args.query || "");
            if (!q) {
                console.error("cache: --q <query> is required");
                process.exit(2);
            }
            const n = Number(args.n || args.limit || 20);
            const scope = args.scope || args.list || "all";
            const threads = Boolean(args.threads);
            const maildir = args.maildir || "./maildir";
            const concurrency = Math.max(1, Number(args.concurrency || 2));
            const { ensureMaildir, writeToMaildir } = await import("./maildir.js");
            await ensureMaildir(maildir);
            let results;
            try {
                if (await lei.isAvailable()) {
                    const q2 = scope && scope !== 'all' ? `${q} l:${scope}` : q;
                    results = await lei.search(q2, n);
                }
                else {
                    const http = scope && scope !== 'all' ? new LoreClient({ scope }) : lore;
                    results = await http.search(q, n);
                }
            }
            catch (e) {
                console.error("cache: search failed:", e);
                process.exit(1);
            }
            const total = results.length;
            console.error(`cache: ${total} hits; writing to Maildir at ${maildir}${threads ? " (threads)" : ""}`);
            let idx = 0;
            const workers = Array.from({ length: concurrency }, async () => {
                while (true) {
                    const i = idx++;
                    if (i >= results.length)
                        break;
                    const r = results[i];
                    try {
                        if (threads) {
                            const msgs = await lore.getThreadMbox({ url: r.url, messageId: r.messageId, scope });
                            for (const m of msgs) {
                                const mid = (m.messageId || r.messageId || (m.headers && m.headers["message-id"]));
                                await writeToMaildir(maildir, { headers: m.headers, body: m.body, messageId: mid });
                            }
                        }
                        else {
                            const m = await lore.getMessageRaw({ url: r.url, messageId: r.messageId, scope });
                            await writeToMaildir(maildir, { headers: m.headers, body: m.body, messageId: m.messageId || r.messageId });
                        }
                    }
                    catch (e) {
                        console.error(`cache: failed for ${r.url || r.messageId}:`, e);
                    }
                }
            });
            await Promise.all(workers);
            console.error("cache: done");
            break;
        }
        default:
            console.error(`Unknown command: ${cmd}`);
            process.exit(2);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
