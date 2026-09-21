import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTemplate } from '../src/lib/template.js';

test('substitutes a simple token', () => {
  assert.equal(renderTemplate('Hello {{NAME}}', { NAME: 'Warren' }), 'Hello Warren');
});

test('escapes substituted values by default', () => {
  const output = renderTemplate('<p>{{TEXT}}</p>', { TEXT: '<script>alert(1)</script>' });

  assert.equal(output, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.ok(!output.includes('<script>'));
});

test('escapes values destined for an attribute', () => {
  const output = renderTemplate('<body data-key="{{KEY}}">', { KEY: '" onload="evil()' });
  assert.ok(!output.includes('" onload='));
  assert.ok(output.includes('&quot;'));
});

test('{{&NAME}} inserts pre-built markup verbatim', () => {
  const output = renderTemplate('<ul>{{&ROWS}}</ul>', { ROWS: '<li>one</li>' });
  assert.equal(output, '<ul><li>one</li></ul>');
});

test('replaces every occurrence of a token', () => {
  assert.equal(renderTemplate('{{A}}-{{A}}-{{A}}', { A: 'x' }), 'x-x-x');
});

test('a missing value throws rather than rendering a blank', () => {
  assert.throws(() => renderTemplate('{{MISSING}}', {}), /MISSING/);
});

test('an explicitly empty value is allowed', () => {
  assert.equal(renderTemplate('[{{EMPTY}}]', { EMPTY: '' }), '[]');
});

test('lowercase or malformed braces are left alone', () => {
  assert.equal(renderTemplate('{{lower}} {single}', {}), '{{lower}} {single}');
});
