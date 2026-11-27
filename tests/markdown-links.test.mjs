import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function escapeHtml');
const end = source.indexOf('const splitRow', start);
assert.ok(start >= 0 && end > start, 'public/app.js Markdown helpers must remain extractable');

const context = vm.createContext({ URL });
vm.runInContext(source.slice(start, end), context);
const { inlineMd } = context;

test('Markdown links allow http, https, mailto and relative targets', () => {
  for (const href of [
    'http://example.com/a',
    'https://example.com/a?q=1',
    'mailto:team@example.com',
    '/docs/readme.md',
    './guide.md',
    '../parent.md',
    '#section',
    'notes/today.md',
  ]) {
    const html = inlineMd(`[link](${href})`);
    assert.match(html, /<a href="/, href);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/, href);
    assert.match(html, new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), href);
  }
});

test('Markdown links reject active and unsupported protocols without an anchor', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/secret.txt',
  ]) {
    const html = inlineMd(`[blocked](${href})`);
    assert.equal(html, 'blocked', href);
    assert.doesNotMatch(html, /href=/, href);
  }
});

test('Markdown link labels and accepted hrefs stay HTML escaped', () => {
  const html = inlineMd('[<img src=x onerror=alert(1)>](https://example.com/?q=%22%3E)');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/example\.com\/\?q=%22%3E"/);
  assert.doesNotMatch(html, /<img/);
});
