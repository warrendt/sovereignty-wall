import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml } from '../src/lib/escape.js';

test('escapeHtml neutralises every HTML-significant character', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml('back`tick'), 'back&#96;tick');
});

test('escapeHtml defuses a script injection payload', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const escaped = escapeHtml(payload);

  assert.ok(!escaped.includes('<'));
  assert.ok(!escaped.includes('>'));
  assert.ok(!escaped.includes('"'));
  assert.equal(escaped, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('escapeHtml escapes an attribute break-out attempt', () => {
  assert.equal(escapeHtml('" onmouseover="evil()'), '&quot; onmouseover=&quot;evil()');
});

test('escapeHtml coerces non-strings and treats nullish as empty', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(0), '0');
});

test('escapeHtml leaves ordinary text untouched', () => {
  assert.equal(escapeHtml('Autonomy'), 'Autonomy');
  assert.equal(escapeHtml('a clear next step'), 'a clear next step');
});
