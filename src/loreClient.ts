import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createProxyFetch, ProxyConfig } from "./proxyConfig.js";

export type SearchResult = {
  subject: string;
  from?: string;
  date?: string;
  url: string;
  messageId?: string;
  list?: string;
};

export type Message = {
  headers: Record<string, string | string[]>;
  body: string;
  url?: string;
  messageId?: string;
};

export interface LoreClientOptions {
  baseUrl?: string; // e.g., https://lore.kernel.org
  scope?: string; // e.g., 'all' or a list like 'linux-kernel'
  userAgent?: string;
  scopesTtlMs?: number; // cache TTL for listScopes
  msgTtlMs?: number; // cache TTL for single message fetches
  threadTtlMs?: number; // cache TTL for thread mbox fetches
  diskCache?: boolean; // enable persistent artifact caching (raw, t.mbox.gz)
  artifactCacheDir?: string; // root directory for disk cache
  proxyConfig?: ProxyConfig; // proxy configuration for HTTP requests
}

import { getProxyConfig } from "./proxyConfig.js";

const DEFAULTS: Required<LoreClientOptions> = {
  baseUrl: process.env.LORE_BASE || "https://lore.kernel.org",
  scope: process.env.LORE_SCOPE || "all",
  userAgent: "lore-mcp/0.1 (+https://github.com/)",
  scopesTtlMs: Number(process.env.LORE_SCOPES_TTL_MS || 600000), // 10 minutes
  msgTtlMs: Number(process.env.LORE_MSG_TTL_MS || 86400000), // 24h
  threadTtlMs: Number(process.env.LORE_THREAD_TTL_MS || 86400000), // 24h
  diskCache: process.env.LORE_DISABLE_DISK_CACHE ? false : true,
  artifactCacheDir: (() => {
    const envDir = process.env.LORE_CACHE_DIR || process.env.LORE_MCP_CACHE_DIR;
    if (envDir) return envDir;
    const xdg = process.env.XDG_CACHE_HOME;
    if (xdg) return join(xdg, "lore-mcp");
    try {
      const home = os.homedir();
      if (home) return join(home, ".cache", "lore-mcp");
    } catch {}
    return join(process.cwd(), ".lore-mcp-cache");
  })(),
  proxyConfig: getProxyConfig()
};

export class LoreClient {
  private baseUrl: string;
  private scope: string;
  private userAgent: string;
  private scopesTtlMs: number;
  private scopesCache?: { ts: number; data: { scope: string; url: string; title?: string; updated?: string }[] };
  private msgTtlMs: number;
  private threadTtlMs: number;
  private messageCache: Map<string, { ts: number; data: Message }> = new Map();
  private threadCache: Map<string, { ts: number; data: Message[] }> = new Map();
  private diskCache: boolean;
  private artifactCacheDir: string;
  private fetch: ReturnType<typeof createProxyFetch>;

  constructor(opts: LoreClientOptions = {}) {
    this.baseUrl = opts.baseUrl || DEFAULTS.baseUrl;
    this.scope = opts.scope || DEFAULTS.scope;
    this.userAgent = opts.userAgent || DEFAULTS.userAgent;
    this.scopesTtlMs = opts.scopesTtlMs ?? DEFAULTS.scopesTtlMs;
    this.msgTtlMs = opts.msgTtlMs ?? DEFAULTS.msgTtlMs;
    this.threadTtlMs = opts.threadTtlMs ?? DEFAULTS.threadTtlMs;
    this.diskCache = opts.diskCache ?? DEFAULTS.diskCache;
    this.artifactCacheDir = opts.artifactCacheDir || DEFAULTS.artifactCacheDir;

    // Initialize proxy-aware fetch
    const proxyConfig = opts.proxyConfig ?? DEFAULTS.proxyConfig;
    this.fetch = createProxyFetch(proxyConfig);
  }

  private atomUrl(query: string): string {
    const q = encodeURIComponent(query);
    // public-inbox Atom feed uses x=A (not o=atom)
    return `${this.baseUrl}/${this.scope}/?q=${q}&x=A`;
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const url = this.atomUrl(query);
    const res = await this.fetch(url, {
      headers: { "user-agent": this.userAgent }
    });
    if (!res.ok) throw new Error(`Search failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(text);
    const feed = data.feed;
    const entries = Array.isArray(feed?.entry) ? feed.entry : feed?.entry ? [feed.entry] : [];
    const results: SearchResult[] = entries.slice(0, limit).map((e: any) => {
      const link = Array.isArray(e.link) ? e.link.find((l: any) => l["@_rel"] === "alternate") || e.link[0] : e.link;
      const url = link?.["@_href"] || e.id || "";
      const rawTitle = e.title;
      const subject = typeof rawTitle === "object" && rawTitle?.["#text"]
        ? rawTitle["#text"]
        : rawTitle || "";
      return {
        subject,
        from: e.author?.name || e.author || undefined,
        date: e.updated || e.published || undefined,
        url,
        messageId: LoreClient.extractMessageId(url),
        list: this.scope !== "all" ? this.scope : undefined
      } as SearchResult;
    });
    return results;
  }

  static extractMessageId(urlOrId: string): string | undefined {
    if (!urlOrId) return undefined;
    // Typical URLs: https://lore.kernel.org/r/<msgid>/ or https://lore.kernel.org/<list>/<msgid>/
    try {
      const u = new URL(urlOrId);
      const parts = u.pathname.split("/").filter(Boolean);
      // last non-empty segment is likely msgid (ignore trailing markers like 'T', 't')
      const candidate = parts[parts.length - 1];
      if (candidate?.includes("@")) return candidate.replace(/\/?$/, "");
      const prev = parts[parts.length - 2];
      if (prev?.includes("@")) return prev;
      return undefined;
    } catch {
      return urlOrId.includes("@") ? urlOrId : undefined;
    }
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetch(url, { headers: { "user-agent": this.userAgent } });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  private async fetchBuffer(url: string): Promise<Buffer> {
    const res = await this.fetch(url, { headers: { "user-agent": this.userAgent } });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const arrBuf = await res.arrayBuffer();
    return Buffer.from(arrBuf);
  }

  async getMessageRaw(input: { url?: string; messageId?: string; scope?: string; list?: string }): Promise<Message> {
    const url = this.resolveMessageUrl(input);
    const now = Date.now();
    const cached = this.messageCache.get(url);
    if (cached && (now - cached.ts) < this.msgTtlMs) return cached.data;
    const mid = LoreClient.extractMessageId(url) || input.messageId || "";
    const diskPath = this.diskCache ? await this.ensureDiskPath("raw", `${sanitize(mid)}.raw`) : undefined;
    if (diskPath) {
      try {
        const st = await fs.stat(diskPath);
        if (now - st.mtimeMs < this.msgTtlMs) {
          const rawCached = await fs.readFile(diskPath, "utf8");
          const parsedCached = parseRfc822(rawCached);
          const resultCached = { ...parsedCached, url, messageId: LoreClient.extractMessageId(url) };
          this.messageCache.set(url, { ts: now, data: resultCached });
          return resultCached;
        }
      } catch { /* cache miss */ }
    }
    const rawUrl = url.replace(/\/?$/, "/raw");
    const raw = await this.fetchText(rawUrl);
    const parsed = parseRfc822(raw);
    const result = { ...parsed, url, messageId: LoreClient.extractMessageId(url) };
    this.messageCache.set(url, { ts: now, data: result });
    if (diskPath) {
      try {
        await fs.mkdir(join(this.artifactCacheDir, "raw"), { recursive: true });
        await fs.writeFile(diskPath, raw, "utf8");
      } catch { /* best-effort */ }
    }
    return result;
  }

  async getThreadMbox(input: { url?: string; messageId?: string; scope?: string; list?: string }): Promise<Message[]> {
    const url = this.resolveMessageUrl(input);
    const now = Date.now();
    const cached = this.threadCache.get(url);
    if (cached && (now - cached.ts) < this.threadTtlMs) return cached.data;
    const mid = LoreClient.extractMessageId(url) || input.messageId || "";
    const diskPath = this.diskCache ? await this.ensureDiskPath("threads", `${sanitize(mid)}.t.mbox.gz`) : undefined;
    if (diskPath) {
      try {
        const st = await fs.stat(diskPath);
        if (now - st.mtimeMs < this.threadTtlMs) {
          const gzBuf = await fs.readFile(diskPath);
          const mboxCached = gunzipSync(gzBuf).toString("utf8");
          const messagesCached = parseMbox(mboxCached);
          const resultCached = messagesCached.map(m => ({ ...m }));
          this.threadCache.set(url, { ts: now, data: resultCached });
          return resultCached;
        }
      } catch { /* cache miss */ }
    }
    // thread mbox gz: <message-url>/t.mbox.gz
    const mboxUrl = url.replace(/\/?$/, "/t.mbox.gz");
    const gz = await this.fetchBuffer(mboxUrl);
    const mbox = gunzipSync(gz).toString("utf8");
    const messages = parseMbox(mbox);
    const result = messages.map(m => ({ ...m }));
    this.threadCache.set(url, { ts: now, data: result });
    if (diskPath) {
      try {
        await fs.mkdir(join(this.artifactCacheDir, "threads"), { recursive: true });
        await fs.writeFile(diskPath, gz);
      } catch { /* best-effort */ }
    }
    return result;
  }

  // Ensure subdir exists and return full path to the artifact
  // Returns undefined when disk cache is disabled
  // subdir: "raw" | "threads"
  private async ensureDiskPath(subdir: string, file: string): Promise<string | undefined> {
    if (!this.diskCache) return undefined;
    const dir = join(this.artifactCacheDir, subdir);
    await fs.mkdir(dir, { recursive: true });
    return join(dir, file);
  }

  private resolveMessageUrl(input: { url?: string; messageId?: string; scope?: string; list?: string }): string {
    if (input.url) return input.url;
    const msgid = input.messageId || "";
    const effectiveScope = input.scope || input.list || (this.scope !== "all" ? this.scope : "r");
    // Prefer /r/ when list is unknown, else /<list>/
    if (effectiveScope === "r") return `${this.baseUrl}/r/${encodeURIComponent(msgid)}`;
    return `${this.baseUrl}/${effectiveScope}/${encodeURIComponent(msgid)}`;
  }

  async listScopes(): Promise<{ scope: string; url: string; title?: string; updated?: string }[]> {
    const now = Date.now();
    if (this.scopesCache && (now - this.scopesCache.ts) < this.scopesTtlMs) {
      return this.scopesCache.data;
    }
    // Fetch root listing and parse the PRE block by stripping tags
    const html = await this.fetchText(`${this.baseUrl}/`);
    const text = html.replace(/\r/g, "").replace(/<[^>]+>/g, "");
    const lines = text.split("\n");
    const scopes: { scope: string; url: string; title?: string; updated?: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Example: * 2025-09-07  7:11 - linux-mm
      const m = line.match(/^\*\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[^-]+) -\s+([A-Za-z0-9._+-]+)\/?$/);
      if (m) {
        const updated = m[1].trim().replace(/\s+/g, " ");
        const scope = m[2];
        // title is likely the next non-empty line that doesn't start with '*'
        let title: string | undefined;
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const t = lines[j].trim();
          if (!t || t.startsWith("* ")) break;
          title = t;
          break;
        }
        const url = `${this.baseUrl}/${scope.replace(/\/?$/, "")}/`;
        scopes.push({ scope, url, title, updated });
      }
    }
    this.scopesCache = { ts: now, data: scopes };
    return scopes;
  }
}

// --- Minimal RFC822 parsing helpers ---

function sanitize(name: string): string {
  const stripped = name.replace(/[<>]/g, "");
  return Array.from(stripped)
    .map((ch) => /[A-Za-z0-9@._+-]/.test(ch) ? ch : `%${ch.charCodeAt(0).toString(16)}`)
    .join("");
}

function parseHeaders(headerText: string): Record<string, string | string[]> {
  const lines = headerText.split(/\r?\n/);
  const headers: Record<string, string | string[]> = {};
  let current: string | null = null;
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      // continuation
      const prev = headers[current];
      const append = line.trim();
      if (Array.isArray(prev)) headers[current] = [...prev.slice(0, -1), `${prev[prev.length - 1]} ${append}`];
      else if (typeof prev === "string") headers[current] = `${prev} ${append}`;
    } else {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const name = line.slice(0, idx).toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (headers[name] === undefined) headers[name] = value;
        else if (Array.isArray(headers[name])) (headers[name] as string[]).push(value);
        else headers[name] = [headers[name] as string, value];
        current = name;
      } else {
        current = null;
      }
    }
  }
  return headers;
}

function parseRfc822(raw: string): Message {
  const sep = /\r?\n\r?\n/;
  const idx = raw.search(sep);
  if (idx === -1) return { headers: {}, body: raw };
  const headerText = raw.slice(0, idx);
  const body = raw.slice(idx + raw.match(sep)![0].length);
  const headers = parseHeaders(headerText);
  return { headers, body };
}

function parseMbox(mbox: string): Message[] {
  const lines = mbox.split(/\r?\n/);
  const messages: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("From ") && current.length > 0) {
      messages.push(current.join("\n"));
      current = [];
    }
    // Skip mbox leading 'From ' line itself; we don't include it in message raw
    if (line.startsWith("From ") && current.length === 0) continue;
    current.push(line);
  }
  if (current.length > 0) messages.push(current.join("\n"));
  return messages.map(parseRfc822);
}