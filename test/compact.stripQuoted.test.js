import test from 'node:test';
import assert from 'node:assert/strict';
import { stripQuoted, extractTrailers, summarizeThread, detectPatchKind } from '../dist/compact.js';

const isVerbose = process.env.TEST_VERBOSE;
const truncate = (str, len = 200) => (str.length > len ? `${str.slice(0, len)}…` : str);
const verboseLog = (label, payload) => {
  if (!isVerbose) return;
  const value = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  console.log(`[verbose] ${label}: ${value}`);
};

test('stripQuoted removes quoted and boilerplate lines', () => {
  const body = [
    'Hello team,',
    '',
    'Here is my update.',
    '',
    'On Tue, Jan 1, 2024 at 10:00 AM Alice wrote:',
    '> Previous content',
    '> more quoted',
    '-----Original Message-----',
    'From: Someone <a@b>',
    'Subject: stuff',
    'Actual next paragraph',
    '-----END PGP SIGNATURE-----',
    'Tail content',
  ].join('\n');
  const out = stripQuoted(body);
  const checks = [
    [/Hello team/, true, 'contains Hello team'],
    [/Here is my update/, true, 'contains update line'],
    [/Tail content/, true, 'contains tail'],
    [/^>/m, false, 'no quote lines'],
    [/On .* wrote:/, false, 'no reply marker'],
    [/Original Message/, false, 'no original message block'],
  ];
  const results = checks.map(([re, shouldMatch, name]) => {
    const matches = re.test(out);
    if (shouldMatch && !matches) throw new Error('Expected match for ' + re);
    if (!shouldMatch && matches) throw new Error('Expected no match for ' + re);
    return { check: name, regex: re.toString(), matches, expected: shouldMatch };
  });
  verboseLog('compact.stripQuoted', { outputPreview: truncate(out, 160), checks: results });
});

test('extractTrailers picks key trailers only', () => {
  const body = [
    'Patch description',
    'Fixes: 1234abcd (runtime error)',
    'Reviewed-by: Reviewer <r@ex>',
    'Acked-by: Ack <a@ex>',
    'Signed-off-by: Dev <d@ex>',
    'X-Other: ignore',
  ].join('\n');
  const trailers = extractTrailers(body);
  const keys = trailers.map(t => t.key);
  verboseLog('compact.extractTrailers', trailers);
  assert.deepEqual(keys.sort(), ['Acked-by','Fixes','Reviewed-by','Signed-off-by'].sort());
});

test('summarizeThread produces compact items with kinds', () => {
  const messages = [
    {
      headers: { 'subject': '[PATCH] feat: add X', 'from': 'Dev <d@ex>', 'date': 'Mon, 1 Jan', 'message-id': 'mid-1' },
      body: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-line\n+line\n+line2\n'
    },
    {
      headers: { 'subject': 'Re: [PATCH] feat: add X', 'from': 'Reviewer <r@ex>', 'date': 'Mon, 1 Jan', 'message-id': 'mid-2' },
      body: 'On Mon Dev wrote:\n> diff --git ...\nThis looks good.'
    }
  ];
  const s = summarizeThread(messages, { maxMessages: 2, stripQuoted: true, shortBodyBytes: 200 });
  verboseLog('compact.summarizeThread', {
    items: s.items.map(item => ({
      subject: item.subject,
      kind: item.kind,
      hasDiff: item.hasDiff,
      bodyPreview: truncate(item.body, 120),
    })),
  });
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].kind, 'patch');
  assert.equal(s.items[0].hasDiff, true);
  // replies can still have subjects containing [PATCH]; ensure we don't classify by kind here
  assert.equal(s.items[1].hasDiff, false);
  assert.match(s.items[1].body, /This looks good/);
  assert.doesNotMatch(s.items[1].body, /^>/m);
});

test('detectPatchKind handles RFC PATCH cover letters', () => {
  const cover = detectPatchKind({
    headers: { subject: '[RFC PATCH v2 00/12] spi: cadence-quadspi: add PHY tuning support' },
    body: ''
  });
  const patch = detectPatchKind({
    headers: { subject: '[RFC PATCH v2 01/12] spi: dt-bindings: add spi-has-dqs property' },
    body: 'No diff in this synthetic case'
  });
  assert.equal(cover, 'cover');
  assert.equal(patch, 'patch');
});

test('summarizeThread de-duplicates same message-id and prefers readable variant', () => {
  const messages = [
    {
      headers: {
        subject: 'Re: [RFC PATCH v2 01/12] spi: dt-bindings: add spi-has-dqs property',
        from: 'Santhosh Kumar K <s-k6@ti.com>',
        date: 'Thu, 5 Feb 2026 23:16:47 +0530',
        'message-id': '<ba78303e-36aa-4f40-9416-c22ff12b7458@ti.com>',
        'content-transfer-encoding': 'base64'
      },
      body: 'SGVsbG8gTWlxdWVsLApUaGlzIGlzIGEgYmFzZTY0IGJsb2IuCkFuZCBtb3JlIGJhc2U2NCBjb250ZW50IGxpbmUuCg=='
    },
    {
      headers: {
        subject: 'Re: [RFC PATCH v2 01/12] spi: dt-bindings: add spi-has-dqs property',
        from: 'Santhosh Kumar K <s-k6@ti.com>',
        date: 'Thu, 5 Feb 2026 23:16:47 +0530',
        'message-id': '<ba78303e-36aa-4f40-9416-c22ff12b7458@ti.com>',
        'content-transfer-encoding': '8bit'
      },
      body: 'Hello Miquel,\n\nI agree with your suggestion and will update the next revision.\nThanks,\nSanthosh.'
    }
  ];

  const s = summarizeThread(messages, { maxMessages: 10, stripQuoted: false, shortBodyBytes: 1000 });
  assert.equal(s.items.length, 1);
  assert.match(s.items[0].body, /Hello Miquel/);
  assert.doesNotMatch(s.items[0].body, /^[A-Za-z0-9+/]{70,}={0,2}$/m);
});