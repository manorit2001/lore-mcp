import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeThread, applyTokenBudgetToThreadSummary, buildPatchset, applyTokenBudgetToPatchset } from '../dist/compact.js';

test('applyTokenBudgetToThreadSummary trims bodies and items', () => {
  const mkMsg = (i) => ({ headers: { subject: `Re: topic ${i}`, from: 'A <a@b>', date: 'Mon', 'message-id': `m${i}` }, body: ('lorem ipsum '.repeat(100)) });
  const messages = [mkMsg(1), mkMsg(2), mkMsg(3)];
  const s = summarizeThread(messages, { maxMessages: 10, stripQuoted: true, shortBodyBytes: 5000 });
  const beforeTokens = s.items.reduce((n, it) => n + Math.ceil((it.body||'').length/4), 0);
  const budget = Math.floor(beforeTokens * 0.4); // allow ~40%
  const t = applyTokenBudgetToThreadSummary(s, budget);
  // Should include at least one item, and total body length should reduce
  assert.ok(t.items.length >= 1);
  const afterTokens = t.items.reduce((n, it) => n + Math.ceil((it.body||'').length/4), 0);
  assert.ok(afterTokens <= Math.ceil(budget*1.1));
});

test('applyTokenBudgetToPatchset prunes diffs by budget', () => {
  const longDiff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n' + ('+x\n'.repeat(500));
  const m1 = { headers: { subject: '[PATCH 1/2] part1', 'message-id': 'p1' }, body: longDiff };
  const m2 = { headers: { subject: '[PATCH 2/2] part2', 'message-id': 'p2' }, body: longDiff };
  const cover = { headers: { subject: '[PATCH 0/2] cover', 'message-id': 'c' }, body: 'cover' };
  const ps = buildPatchset([cover, m1, m2], { includeDiffs: true, maxFiles: 10, maxHunksPerFile: 50, maxHunkLines: 10000 });
  const before = ps.patches.reduce((n,p)=> n + (p.diffs?.join('\n').length || 0), 0);
  const budget = Math.ceil(before/20/4); // ~5% of original diff chars converted to tokens
  const adj = applyTokenBudgetToPatchset(ps, budget);
  const after = adj.patches.reduce((n,p)=> n + (p.diffs?.join('\n').length || 0), 0);
  assert.ok(after < before);
});

