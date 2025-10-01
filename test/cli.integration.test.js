import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = resolve(__dirname, '..', 'dist', 'cli.js');
const isVerbose = process.env.TEST_VERBOSE;
const truncate = (str, len = 200) => {
  if (!str) return str;
  return str.length > len ? `${str.slice(0, len)}…` : str;
};
const verboseLog = (label, payload) => {
  if (!isVerbose) return;
  const value = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  console.log(`[verbose] ${label}: ${value}`);
};

async function runCli(args, extraEnv = {}) {
  verboseLog('cli.exec', { args, env: Object.keys(extraEnv) });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        LORE_DISABLE_DISK_CACHE: '1',
        LORE_MCP_CACHE_MAILDIR: '0',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`cli exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runCliJson(args, extraEnv = {}) {
  const { stdout } = await runCli(args, extraEnv);
  const parsed = JSON.parse(stdout);
  verboseLog('cli.output', { args, preview: truncate(stdout, 300) });
  return parsed;
}

async function fetchPatchCandidates(limit, extraEnv = {}) {
  const queryArgs = [
    'search',
    '--q', 's:[PATCH] d:2024-01-01..',
    '--scope', 'linux-kernel',
    '--n', String(limit),
  ];
  const searchResults = await runCliJson(queryArgs, extraEnv);
  verboseLog('cli.search.results', searchResults.slice(0, 3));
  assert.ok(Array.isArray(searchResults) && searchResults.length > 0, 'search should return at least one result');
  return searchResults.filter(entry => entry && entry.url);
}

async function firstPatchsetResult(candidates, extraEnv = {}) {
  for (const entry of candidates) {
    if (!entry || !entry.url || typeof entry.subject !== 'string') continue;
    if (!/\[PATCH/i.test(entry.subject)) continue;
    try {
      const patchset = await runCliJson(['patchset', '--url', entry.url, '--statOnly'], extraEnv);
      verboseLog('cli.patchset', {
        url: entry.url,
        subject: entry.subject,
        insertions: patchset?.aggregate?.insertions,
        deletions: patchset?.aggregate?.deletions,
      });
      if (patchset) {
        return { patchset, entry };
      }
    } catch {
      verboseLog('cli.patchset.retry', { url: entry.url, reason: 'patchset failed' });
    }
  }
  return null;
}

test('CLI commands interoperate with live lore.kernel.org responses', async () => {
  const baseEnv = {
    PATH: process.env.PATH,
  };

  let candidates = await fetchPatchCandidates(10, baseEnv);
  let patchsetData = await firstPatchsetResult(candidates, baseEnv);
  if (!patchsetData) {
    verboseLog('cli.patchset.retrying', { reason: 'initial candidates failed', count: candidates.length });
    candidates = await fetchPatchCandidates(25, baseEnv);
    patchsetData = await firstPatchsetResult(candidates, baseEnv);
  }
  assert.ok(patchsetData, 'expected to obtain patchset data from at least one live patch thread');

  const { entry: chosenEntry, patchset } = patchsetData;
  verboseLog('cli.chosen.entry', chosenEntry);

  assert.equal(typeof chosenEntry.subject, 'string');
  assert.ok(/\[PATCH/i.test(chosenEntry.subject), 'chosen subject should look like a patch');
  assert.ok(typeof chosenEntry.url === 'string' && chosenEntry.url.startsWith('https://'));

  const messageJson = await runCliJson(['message', '--url', chosenEntry.url], baseEnv);
  verboseLog('cli.message.summary', {
    messageId: messageJson.messageId,
    subject: messageJson.headers?.subject,
    bodyPreview: truncate(messageJson.body, 160),
  });
  assert.equal(typeof messageJson.body, 'string');
  assert.ok(messageJson.body.length > 0, 'message body should be present');
  if (chosenEntry.messageId && messageJson.messageId) {
    const fromSearch = String(chosenEntry.messageId).replace(/[<>]/g, '');
    const fromMessage = String(messageJson.messageId).replace(/[<>]/g, '');
    assert.equal(fromMessage, fromSearch);
  }

  const threadJson = await runCliJson([
    'thread',
    '--url', chosenEntry.url,
    '--maxMessages', '4',
    '--maxBodyBytes', '4096',
  ], baseEnv);
  verboseLog('cli.thread.summary', {
    messages: threadJson.length,
    firstMessageId: threadJson[0]?.headers?.['message-id'],
    firstBodyPreview: truncate(threadJson[0]?.body, 160),
  });
  assert.ok(Array.isArray(threadJson) && threadJson.length > 0, 'thread should return at least one message');
  assert.equal(typeof threadJson[0].body, 'string');

  const summaryJson = await runCliJson([
    'summary',
    '--url', chosenEntry.url,
    '--maxMessages', '6',
    '--shortBodyBytes', '512',
  ], baseEnv);
  verboseLog('cli.summary.summary', {
    items: summaryJson.items.length,
    firstItem: {
      subject: summaryJson.items[0]?.subject,
      kind: summaryJson.items[0]?.kind,
      bodyPreview: truncate(summaryJson.items[0]?.body, 160),
    },
  });
  assert.ok(Array.isArray(summaryJson.items) && summaryJson.items.length > 0);
  assert.equal(typeof summaryJson.items[0].subject, 'string');

  verboseLog('cli.patchset.aggregate', {
    version: patchset.series?.version,
    insertions: patchset.aggregate?.insertions,
    deletions: patchset.aggregate?.deletions,
  });
  assert.ok(patchset.series);
  assert.ok(patchset.aggregate);
  assert.equal(typeof patchset.aggregate.insertions, 'number');
  assert.equal(typeof patchset.aggregate.deletions, 'number');
});