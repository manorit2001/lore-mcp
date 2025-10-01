import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDiffs, buildPatchset, parsePatchSubject, computeDiffStat } from '../dist/compact.js';

const diff1 = [
  'diff --git a/foo.txt b/foo.txt',
  'index 000..111 100644',
  '--- a/foo.txt',
  '+++ b/foo.txt',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '-line2',
  '+line2 changed',
  '+added line',
  ' line3',
].join('\n');

const diff2 = [
  'diff --git a/bar.txt b/bar.txt',
  'index 222..333 100644',
  '--- a/bar.txt',
  '+++ b/bar.txt',
  '@@ -1,2 +1,12 @@',
  ' lineA',
  '-lineB',
  '+b1','+b2','+b3','+b4','+b5','+b6','+b7','+b8','+b9','+b10',
].join('\n');

test('computeDiffStat counts insertions/deletions per file', () => {
  const { stat } = computeDiffStat(diff1);
  assert.equal(stat.files, 1);
  assert.equal(stat.insertions, 2);
  assert.equal(stat.deletions, 1);
  assert.equal(stat.perFile[0].file, 'foo.txt');
});

test('extractDiffs sorts files by size and truncates', () => {
  const big = extractDiffs([diff1, diff2].join('\n'), { maxFiles: 1, maxHunksPerFile: 2, maxHunkLines: 20 });
  // Should include only one diff block (the larger one)
  assert.equal(big.diffs.length, 1);
  // Aggregate stat still reflects both files
  assert.ok(big.stat.insertions >= 12);
  const files = big.stat.perFile.map(f => f.file).sort();
  assert.deepEqual(files, ['bar.txt','foo.txt'].sort());
});

test('parsePatchSubject extracts version and parts', () => {
  const p1 = parsePatchSubject('[PATCH v3 2/7] foo');
  assert.equal(p1.version, 'v3');
  assert.equal(p1.index, 2);
  assert.equal(p1.total, 7);
  const p2 = parsePatchSubject('[PATCH v2] bar');
  assert.equal(p2.version, 'v2');
  assert.equal(p2.index, undefined);
});

test('buildPatchset detects series, excludes cover, aggregates stats', () => {
  const cover = { headers: { 'subject': '[PATCH v2 0/2] Add stuff', 'message-id': 'c' }, body: 'Cover letter' };
  const p1 = { headers: { 'subject': '[PATCH v2 1/2] Foo', 'message-id': 'p1' }, body: diff1 };
  const p2 = { headers: { 'subject': '[PATCH v2 2/2] Bar', 'message-id': 'p2' }, body: diff2 };
  const ps = buildPatchset([cover, p1, p2], { statOnly: true });
  assert.ok(ps);
  assert.equal(ps.series.version, 'v2');
  assert.equal(ps.patches.length, 2);
  // aggregate should include both files
  const files = ps.aggregate.perFile.map(f => f.file).sort();
  assert.deepEqual(files, ['bar.txt', 'foo.txt'].sort());
});

