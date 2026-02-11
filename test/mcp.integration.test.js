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

test('MCP stdio transport end-to-end: get_thread_summary handles TI thread corner cases', { timeout: 120000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      LORE_DISABLE_DISK_CACHE: '1',
      LORE_MCP_CACHE_MAILDIR: '0',
    },
  });

  const client = new Client({ name: 'lore-mcp-e2e-test', version: '0.1.0' });

  try {
    await client.connect(transport);

    const toolList = await client.listTools();
    assert.ok(Array.isArray(toolList.tools), 'listTools should return tool metadata');
    assert.ok(toolList.tools.some(t => t?.name === 'get_thread_summary'), 'get_thread_summary tool must be exposed');

    const result = await client.callTool({
      name: 'get_thread_summary',
      arguments: {
        url: TI_THREAD_URL,
        maxMessages: 120,
        shortBodyBytes: 2048,
      },
    });

    const summary = extractStructuredPayload(result);
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
  } finally {
    if (typeof client.close === 'function') {
      await client.close();
    }
    await transport.close();
  }
});
