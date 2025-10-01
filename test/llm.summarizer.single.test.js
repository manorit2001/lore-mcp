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

test('LLM summarizer (single chunk) returns structured JSON and participants', async () => {
  const prev = { ...process.env };
  try {
    process.env.LLM_PROVIDER = 'mock';
    const messages = [
      { headers: { subject: '[PATCH] add X', from: 'Dev <d@ex>', date: 'Mon', 'message-id': 'm1' }, body: 'Short body.\nReviewed-by: R <r@ex>' },
      { headers: { subject: 'Re: [PATCH] add X', from: 'Reviewer <r@ex>', date: 'Mon', 'message-id': 'm2' }, body: 'Looks good.' },
    ];
    const res = await summarizeThreadLLM(messages, { contextTokens: 200000, maxOutputTokens: 256, strategy: 'single' });
    verboseLog('llm.single.summary', {
      overview: res.overview,
      keyPoints: res.key_points,
      participants: res.participants,
      model: res.model,
      rawPreview: truncate(res.raw || '', 160),
    });
    assert.equal(res.overview, 'ok');
    assert.ok(Array.isArray(res.key_points) && res.key_points[0] === 'a');
    assert.ok(Array.isArray(res.participants) && res.participants.length >= 1);
    const names = res.participants.map(p => p.name).join(' ');
    assert.match(names, /Dev/);
    assert.equal(res.model, 'mock');
  } finally {
    Object.assign(process.env, prev);
  }
});