import test from 'node:test';
import assert from 'node:assert/strict';

const mbox = [
  'From patch@example.com Mon Jan  1 00:00:00 2024',
  'Subject: [PATCH 1/2] add foo',
  'Message-Id: <patch1@example.com>',
  '',
  'diff --git a/foo b/foo',
  '',
  'From patch@example.com Mon Jan  1 00:00:01 2024',
  'Subject: [PATCH 2/2] add bar',
  'Message-Id: <patch2@example.com>',
  '',
  'diff --git a/bar b/bar',
  '',
].join('\n');

const responses = [
  { stdout: mbox, stderr: '', exitCode: 0 },
  { stdout: 'Applying patch\n', stderr: '', exitCode: 0 },
];

test('B4Client fetchSeries parses mbox and apply returns stdout/stderr', async () => {
  const { B4Client } = await import('../dist/b4Client.js');
  const invocations = [];

  const client = new B4Client();
  client.exec = async (args, options = {}) => {
    const idx = invocations.length;
    const response = responses[idx] || responses[responses.length - 1];
    invocations.push({ args: [...args], options: { ...options } });
    if (response.exitCode && response.exitCode !== 0) {
      const err = new Error(`b4 exited with code ${response.exitCode}`);
      err.code = response.exitCode;
      err.stdout = response.stdout ?? '';
      err.stderr = response.stderr ?? '';
      throw err;
    }
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  };

  const series = await client.fetchSeries({ messageId: 'series@id' });
  assert.equal(series.length, 2, 'expected two messages from mocked mbox');
  assert.equal(series[0].headers['subject'], '[PATCH 1/2] add foo');
  assert.equal(series[1].messageId, '<patch2@example.com>');

  const applyResult = await client.apply({
    messageId: 'series@id',
    cwd: '/tmp/repo',
    noApply: true,
    additionalArgs: ['--cherry-pick'],
  });

  assert.equal(applyResult.exitCode, 0);
  assert.match(applyResult.stdout, /Applying patch/);
  assert.equal(invocations.length, 2, 'expected fetch and apply invocations');
  assert.deepEqual(invocations[0].args.slice(0, 3), ['am', '--stdout', '--no-apply']);
  assert.equal(invocations[1].args[0], 'am');
  assert.ok(invocations[1].args.includes('--no-apply'));
  assert.ok(invocations[1].args.includes('--cherry-pick'));
  assert.equal(invocations[1].options.cwd, '/tmp/repo');
});
