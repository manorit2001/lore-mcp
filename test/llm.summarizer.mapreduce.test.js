import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeThreadLLM } from '../dist/llmSummarizer.js';

const isVerbose = process.env.TEST_VERBOSE;
const truncate = (str, len = 200) => (str.length > len ? `${str.slice(0, len)}…` : str);
const verboseLog = (label, payload) => {
  if (!isVerbose) return;
  const value = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  console.log(`[verbose] ${label}: ${value}`);
};

function bigBody(label, repeat = 6000) {
  return (label + ' ').repeat(repeat);
}

test('LLM summarizer (map-reduce) handles long threads without truncation', async () => {
  const prev = { ...process.env };
  try {
    process.env.LLM_PROVIDER = 'mock';
    const messages = [
      { headers: { subject: '[PATCH v2 1/3] part1', from: 'Dev <d@ex>', date: 'Mon', 'message-id': 'p1' }, body: bigBody('A', 6000) },
      { headers: { subject: '[PATCH v2 2/3] part2', from: 'Dev <d@ex>', date: 'Mon', 'message-id': 'p2' }, body: bigBody('B', 6000) },
      { headers: { subject: '[PATCH v2 3/3] part3', from: 'Dev <d@ex>', date: 'Mon', 'message-id': 'p3' }, body: bigBody('C', 6000) },
    ];
    const res = await summarizeThreadLLM(messages, { contextTokens: 1500, maxOutputTokens: 128, strategy: 'auto', stripQuoted: true });
    verboseLog('llm.mapReduce.summary', {
      overview: res.overview,
      keyPoints: res.key_points,
      participants: res.participants,
      model: res.model,
      rawPreview: truncate(res.raw || '', 160),
    });
    assert.equal(res.overview, 'reduced');
    assert.ok(Array.isArray(res.key_points));
    assert.ok(res.participants && res.participants[0].messages >= 3);
    assert.equal(res.model, 'mock');
  } finally {
    Object.assign(process.env, prev);
  }
});