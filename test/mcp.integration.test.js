import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = resolve(__dirname, '..', 'dist', 'index.js');
const TI_THREAD_URL = 'https://lore.kernel.org/all/ba78303e-36aa-4f40-9416-c22ff12b7458@ti.com/';
const base64LineRe = /^[A-Za-z0-9+/]{80,}={0,2}$/m;

function normalizeMessageId(value) {
  if (!value || typeof value !== 'string') return undefined;
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function extractStructuredPayload(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = result?.content?.find?.(item => item?.type === 'text')?.text;
  assert.ok(typeof text === 'string' && text.length > 0, 'tool response should include text content');
  return JSON.parse(text);
}

async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return extractStructuredPayload(result);
}

async function findPatchCandidate(client) {
  const attempts = [
    { query: 's:[PATCH] d:2024-01-01..', scope: 'linux-kernel', limit: 12 },
    { query: 's:[PATCH v2] d:2023-01-01..', scope: 'linux-kernel', limit: 20 },
    { query: 's:[PATCH] d:2022-01-01..', scope: 'all', limit: 20 },
  ];

  for (const attempt of attempts) {
    const search = await callToolJson(client, 'search_lore', attempt);
    const items = Array.isArray(search?.items) ? search.items : [];
    for (const item of items) {
      if (!item?.url || !/\[patch/i.test(item?.subject || '')) continue;
      try {
        const patchset = await callToolJson(client, 'get_patchset', {
          url: item.url,
          statOnly: true,
          includeDiffs: false,
          maxFiles: 50,
          maxHunksPerFile: 10,
          maxHunkLines: 400,
        });
        if (patchset && patchset.aggregate && Number.isFinite(patchset.aggregate.files)) {
          return { item, patchset };
        }
      } catch {
        continue;
      }
    }
  }

  throw new Error('Could not find a viable patch candidate from live search results');
}

async function withClient(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      LORE_DISABLE_DISK_CACHE: '1',
      LORE_MCP_CACHE_MAILDIR: '0',
      LORE_MCP_SILENT_STARTUP: '1',
    },
  });

  const client = new Client({ name: 'lore-mcp-e2e-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    if (typeof client.close === 'function') {
      await client.close();
    }
    await transport.close();
  }
}

test('MCP stdio transport end-to-end: get_thread_summary handles TI thread corner cases', { timeout: 120000 }, async () => {
  await withClient(async (client) => {

    const toolList = await client.listTools();
    assert.ok(Array.isArray(toolList.tools), 'listTools should return tool metadata');
    assert.ok(toolList.tools.some(t => t?.name === 'get_thread_summary'), 'get_thread_summary tool must be exposed');

    const summary = await callToolJson(client, 'get_thread_summary', {
      url: TI_THREAD_URL,
      maxMessages: 120,
      shortBodyBytes: 2048,
    });
    assert.ok(Array.isArray(summary.items) && summary.items.length > 0, 'summary should include items');

    const seen = new Set();
    const duplicates = [];
    for (const item of summary.items) {
      const mid = normalizeMessageId(item?.messageId);
      if (!mid) continue;
      if (seen.has(mid)) duplicates.push(mid);
      seen.add(mid);
    }
    assert.equal(duplicates.length, 0, `expected no duplicate message-ids, got: ${duplicates.join(', ')}`);

    const cover = summary.items.find(item => /\[\s*rfc\s+patch[^\]]*\b0+\s*\/\s*12\b[^\]]*\]/i.test(item?.subject || ''));
    assert.ok(cover, 'expected RFC cover letter item in summary');
    assert.equal(cover.kind, 'cover');

    const targetMid = 'ba78303e-36aa-4f40-9416-c22ff12b7458@ti.com';
    const targetItem = summary.items.find(item => normalizeMessageId(item?.messageId) === targetMid);
    assert.ok(targetItem, `expected summary item for ${targetMid}`);
    assert.equal(typeof targetItem.body, 'string');
    assert.doesNotMatch(targetItem.body, base64LineRe);
  });
});

test('MCP stdio transport end-to-end: agent-like flow exercises all major tools', { timeout: 180000 }, async () => {
  await withClient(async (client) => {
    const toolList = await client.listTools();
    assert.ok(Array.isArray(toolList.tools) && toolList.tools.length >= 8, 'expected tool list with core MCP tools');

    const toolNames = new Set(toolList.tools.map(t => t?.name));
    for (const required of [
      'search_lore',
      'get_message_raw',
      'get_thread_summary',
      'summarize_thread_llm',
      'get_patchset',
      'get_thread_mbox',
      'list_scopes',
      'lore_help',
    ]) {
      assert.ok(toolNames.has(required), `missing MCP tool: ${required}`);
    }

    const resources = await client.listResources();
    assert.ok(Array.isArray(resources.resources) && resources.resources.length > 0, 'expected at least one MCP resource');
    const scopesResource = resources.resources.find(r => String(r?.uri || '') === 'mcp://lore-mcp/scopes');
    assert.ok(scopesResource, 'mcp://lore-mcp/scopes should be listed');

    const scopeRead = await client.readResource({ uri: 'mcp://lore-mcp/scopes' });
    const scopeText = scopeRead?.contents?.find?.(c => c?.mimeType === 'application/json')?.text
      || scopeRead?.contents?.[0]?.text;
    assert.equal(typeof scopeText, 'string');
    const scopePayload = JSON.parse(scopeText);
    const scopeItems = Array.isArray(scopePayload) ? scopePayload : scopePayload?.items;
    assert.ok(Array.isArray(scopeItems), 'scopes resource should return JSON array payload');

    const helpResult = await client.callTool({ name: 'lore_help', arguments: {} });
    const helpText = helpResult?.content?.find?.(item => item?.type === 'text')?.text || '';
    assert.match(helpText, /search quick reference/i);
    assert.match(helpText, /Search basics/i);

    const scopes = await callToolJson(client, 'list_scopes', {});
    assert.ok(Array.isArray(scopes.items) && scopes.items.length > 0, 'list_scopes should return available scopes');

    const { item: candidate, patchset: patchsetStat } = await findPatchCandidate(client);
    assert.ok(candidate.url, 'candidate patch URL should be present');
    assert.equal(typeof patchsetStat.aggregate.files, 'number');
    assert.equal(typeof patchsetStat.aggregate.insertions, 'number');
    assert.equal(typeof patchsetStat.aggregate.deletions, 'number');

    const raw = await callToolJson(client, 'get_message_raw', {
      url: candidate.url,
    });
    assert.equal(typeof raw.body, 'string');
    assert.ok(raw.body.length > 0, 'message raw should include body');
    assert.ok(raw.headers && typeof raw.headers === 'object', 'message raw should include headers');

    const thread = await callToolJson(client, 'get_thread_mbox', {
      url: candidate.url,
      maxMessages: 8,
      maxBodyBytes: 8192,
    });
    assert.ok(Array.isArray(thread.items) && thread.items.length > 0, 'thread mbox should include items');

    const summary = await callToolJson(client, 'get_thread_summary', {
      url: candidate.url,
      maxMessages: 12,
      shortBodyBytes: 1200,
      stripQuoted: true,
    });
    assert.ok(Array.isArray(summary.items) && summary.items.length > 0, 'thread summary should include compact items');
    assert.ok(summary.items.some(i => i?.kind === 'patch' || i?.kind === 'cover' || i?.kind === 'reply'));

    const patchsetWithDiff = await callToolJson(client, 'get_patchset', {
      url: candidate.url,
      statOnly: false,
      includeDiffs: true,
      maxFiles: 20,
      maxHunksPerFile: 8,
      maxHunkLines: 600,
      tokenBudget: 4000,
    });
    assert.ok(Array.isArray(patchsetWithDiff.patches) && patchsetWithDiff.patches.length > 0, 'patchset should include patches');
    assert.equal(typeof patchsetWithDiff.aggregate.files, 'number');

    const llmSummary = await callToolJson(client, 'summarize_thread_llm', {
      url: candidate.url,
      provider: 'mock',
      strategy: 'single',
      maxMessages: 12,
      stripQuoted: true,
    });
    assert.equal(typeof llmSummary.overview, 'string');
    assert.ok(llmSummary.overview.length > 0, 'mock LLM summary should contain overview text');
    assert.ok(Array.isArray(llmSummary.participants), 'mock LLM summary should include participants list');
  });
});
