import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;
let ChatCard;
before(async () => {
  vite = await createServer({ configFile: new URL('./vite.config.js', import.meta.url).pathname, server: { middlewareMode: true } });
  ({ ChatCard } = await vite.ssrLoadModule('/ChatCard.jsx'));
});
after(async () => { await vite?.close(); });

function render(message) {
  return renderToStaticMarkup(React.createElement(ChatCard, {
    card: { id: 'card-1', sessionId: 'session-1', revision: 1, title: 'Test chat' },
    messages: [message], status: 'running', onCancel: () => {}, onSend: () => ({ accepted: true }),
  }));
}

test('chat results do not expose a manual transfer action', () => {
  const html = render({ id: 'm1', role: 'assistant', text: 'completed answer',
    transferSource: { kind: 'command', cardId: 'card-1', id: 'command-1' } });
  assert.doesNotMatch(html, /Transfer result|message-action/);
  assert.match(html, /completed answer/);
});

test('assistant Markdown renders GFM and code copy without raw HTML execution', () => {
  const html = render({ id: 'markdown', role: 'assistant',
    text: '**Bold** and `inline`\n\n```js\nconst answer = 42;\n```\n\n[source](https://example.com)\n\n<script>alert(1)</script>' });
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /class="language-js"/);
  assert.match(html, />Copy<\/button>/);
  assert.match(html, /target="_blank" rel="noreferrer noopener"/);
  assert.doesNotMatch(html, /<script|alert\(1\)/);
});

test('provisional running awaits receipt; accepted running shows work state and Cancel', () => {
  const pending = render({ id: 'm1', role: 'user', text: 'hello', pending: true, receiptPending: true });
  assert.match(pending, /Sending…/);
  assert.match(pending, /Awaiting receipt/);
  assert.doesNotMatch(pending, /Working…|>Cancel</i);

  const accepted = render({ id: 'm2', role: 'user', text: 'hello', pending: false, receiptPending: true });
  assert.match(accepted, /Thinking…/);
  assert.match(accepted, /Working…/);
  assert.match(accepted, />Cancel</);
});

test('Chat Node hides internal identifiers and exposes the fixed model policy as read-only text', () => {
  const html = render({ id: 'm1', role: 'assistant', text: 'answer' });
  assert.doesNotMatch(html, /session-1|CHAT ·|revision|>ready</i);
  assert.match(html, /GPT-6 Luna/);
  assert.match(html, /Reasoning: Low/);
  assert.match(html, /Current model policy/);
  assert.doesNotMatch(html, /<select|model-picker|reasoning-picker/);
});
