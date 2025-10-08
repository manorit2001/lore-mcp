import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const fakeMessages = [
  {
    headers: {
      subject: 'Re: discussion start',
      from: 'Alice <alice@example.com>',
      date: 'Mon, 01 Jan 2024 00:00:00 +0000',
      'message-id': '<msg1@example.com>'
    },
    body: 'Body one\n> quoted line',
  },
  {
    headers: {
      subject: 'Re: discussion follow up',
      from: 'Bob <bob@example.com>',
      date: 'Mon, 01 Jan 2024 00:05:00 +0000',
      'message-id': '<msg2@example.com>'
    },
    body: 'Body two with more content',
  },
  {
    headers: {
      subject: 'Re: discussion conclusion',
      from: 'Carol <carol@example.com>',
      date: 'Mon, 01 Jan 2024 00:10:00 +0000',
      'message-id': '<msg3@example.com>'
    },
    body: 'Body three',
  }
];

test('get_thread_summary supports pagination metadata', async () => {
  const { LoreClient } = await import('../dist/loreClient.js');
  const restore = mock.method(LoreClient.prototype, 'getThreadMbox', async () => fakeMessages);

  const { createTools } = await import('../dist/tools.js');
  const tools = createTools();

  try {
    const result = await tools.get_thread_summary.handler({
      url: 'https://example.com/thread',
      page: 2,
      pageSize: 1,
      cacheToMaildir: false,
    });

    const structured = result.structuredContent;
    assert.equal(structured.page, 2);
    assert.equal(structured.pageSize, 1);
    assert.equal(structured.totalMessages, 3);
    assert.equal(structured.totalPages, 3);
    assert.equal(structured.hasMore, true);
    assert.equal(structured.items.length, 1);
    assert.equal(structured.items[0].subject, 'Re: discussion follow up');
  } finally {
    restore.mock.restore();
    mock.restoreAll();
  }
});
