import { createTools } from "./tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { serverInstructions, loreQuickHelp } from "./instructions_llm.js";

// MCP server: exposes lore search + fetch tools (with optional lei)

async function main() {
  const mcp = new McpServer(
    { name: "lore-mcp", version: "0.1.0" },
    { instructions: serverInstructions }
  );
  const tools = createTools();

  // search_lore
  mcp.tool(
    tools.search_lore.name,
    tools.search_lore.description,
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(200).default(20).optional(),
      scope: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
    },
    async (args: any) => tools.search_lore.handler(args)
  );

  // get_message_raw: require one of url or messageId
  mcp.tool(
    tools.get_message_raw.name,
    tools.get_message_raw.description,
    {
      url: z.string().url().optional(),
      messageId: z.string().optional(),
      scope: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      list: z.string().optional(),
      cacheToMaildir: z.boolean().optional(),
      maildir: z.string().optional(),
    },
    async (args: any) => {
      if (!args.url && !args.messageId) {
        throw new Error("one of `url` or `messageId` is required");
      }
      return tools.get_message_raw.handler(args);
    }
  );

  // get_thread_mbox: require one of url or messageId
  // get_thread_summary: require one of url or messageId
  mcp.tool(
    tools.get_thread_summary.name,
    tools.get_thread_summary.description,
    {
      url: z.string().url().optional(),
      messageId: z.string().optional(),
      scope: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      list: z.string().optional(),
      maxMessages: z.number().int().positive().max(500).optional(),
      stripQuoted: z.boolean().optional(),
      shortBodyBytes: z.number().int().positive().max(50_000).optional(),
      tokenBudget: z.number().int().positive().max(200_000).optional(),
      cacheToMaildir: z.boolean().optional(),
      maildir: z.string().optional(),
    },
    async (args: any) => {
      if (!args.url && !args.messageId) {
        throw new Error("one of `url` or `messageId` is required");
      }
      return tools.get_thread_summary.handler(args);
    }
  );

  // summarize_thread_llm: require one of url or messageId
  mcp.tool(
    tools.summarize_thread_llm.name,
    tools.summarize_thread_llm.description,
    {
      url: z.string().url().optional(),
      messageId: z.string().optional(),
      scope: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      list: z.string().optional(),
      maxMessages: z.number().int().nonnegative().max(2000).optional(),
      stripQuoted: z.boolean().optional(),
      provider: z.enum(["openai", "anthropic", "google", "ollama", "command", "mock", "litellm"]).optional(),
      model: z.string().optional(),
      contextTokens: z.number().int().positive().max(400000).optional(),
      maxOutputTokens: z.number().int().positive().max(8000).optional(),
      temperature: z.number().min(0).max(2).optional(),
      strategy: z.enum(["auto", "single", "map-reduce"]).optional(),
      cacheToMaildir: z.boolean().optional(),
      maildir: z.string().optional(),
    },
    async (args: any) => {
      if (!args.url && !args.messageId) {
        throw new Error("one of `url` or `messageId` is required");
      }
      return tools.summarize_thread_llm.handler(args);
    }
  );

  // get_patchset: require one of url or messageId
  mcp.tool(
    tools.get_patchset.name,
    tools.get_patchset.description,
    {
      url: z.string().url().optional(),
      messageId: z.string().optional(),
      scope: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      list: z.string().optional(),
      statOnly: z.boolean().optional(),
      includeDiffs: z.boolean().optional(),
      maxFiles: z.number().int().positive().max(200).optional(),
      maxHunksPerFile: z.number().int().positive().max(50).optional(),
      maxHunkLines: z.number().int().positive().max(2000).optional(),
      tokenBudget: z.number().int().positive().max(200_000).optional(),
      cacheToMaildir: z.boolean().optional(),
      maildir: z.string().optional(),
    },
    async (args: any) => {
      if (!args.url && !args.messageId) {
        throw new Error("one of `url` or `messageId` is required");
      }
      return tools.get_patchset.handler(args);
    }
  );

  // apply_patchset: b4 wrapper (requires url or messageId)
  mcp.tool(
    tools.apply_patchset.name,
    tools.apply_patchset.description,
    {
      url: z.string().url().optional(),
      messageId: z.string().optional(),
      repoPath: z.string().optional(),
      noApply: z.boolean().optional(),
      additionalArgs: z.array(z.string()).optional(),
    },
    async (args: any) => {
      if (!args.url && !args.messageId) {
        throw new Error("one of `url` or `messageId` is required");
      }
      return tools.apply_patchset.handler(args);
    }
  );

  // get_thread_mbox: require one of url or messageId
  mcp.tool(
    tools.get_thread_mbox.name,
    tools.get_thread_mbox.description,
    {
      url: z.string().url().optional(),
      messageId: z.string().optional(),
      scope: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      list: z.string().optional(),
      maxMessages: z.number().int().positive().max(500).optional(),
      maxBodyBytes: z.number().int().positive().max(5_000_000).optional(),
      cacheToMaildir: z.boolean().optional(),
      maildir: z.string().optional(),
    },
    async (args: any) => {
      if (!args.url && !args.messageId) {
        throw new Error("one of `url` or `messageId` is required");
      }
      return tools.get_thread_mbox.handler(args);
    }
  );

  // list_scopes: discover available mailing lists
  mcp.tool(
    tools.list_scopes.name,
    tools.list_scopes.description,
    {},
    async () => tools.list_scopes.handler()
  );

  // Resource: scopes listing (JSON)
  mcp.resource(
    "scopes",
    "mcp://lore-mcp/scopes",
    async () => {
      const { LoreClient } = await import("./loreClient.js");
      const scopes = await new LoreClient().listScopes();
      return {
        contents: [
          {
            uri: "mcp://lore-mcp/scopes",
            mimeType: "application/json",
            text: JSON.stringify(scopes, null, 2)
          }
        ]
      } as any;
    }
  );

  // lore_help: quick reference to public-inbox search + endpoints
  mcp.tool(
    "lore_help",
    "Show lore.kernel.org/public-inbox search syntax and endpoints",
    {},
    async () => ({ content: [{ type: "text", text: loreQuickHelp }] })
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("lore-mcp server failed:", err);
  process.exit(1);
});
