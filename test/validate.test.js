import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseText, validateAnswer, validateSubmission } from '../src/lib/validate.js';

/* ------------------------------------------------------------ normalise */

test('normaliseText trims and collapses whitespace runs', () => {
  assert.equal(normaliseText('  hello   world  '), 'hello world');
  assert.equal(normaliseText('\t\tfreedom\n'), 'freedom');
});

test('normaliseText strips control and invisible characters', () => {
  assert.equal(normaliseText('con\u0000trol'), 'control');
  assert.equal(normaliseText('\u200Bzero\u200Bwidth\u200B'), 'zerowidth');
  assert.equal(normaliseText('\u202Ebidi'), 'bidi');
  assert.equal(normaliseText('\uFEFFbom'), 'bom');
});

test('normaliseText converts newlines to spaces instead of deleting them', () => {
  // Deleting the newline would join the words and sneak "onetwo" past the
  // one-word rule, so this is a security-relevant behaviour, not cosmetics.
  assert.equal(normaliseText('one\ntwo'), 'one two');
  assert.equal(normaliseText('one\r\ntwo'), 'one two');
  assert.equal(normaliseText('one\ttwo'), 'one two');
});

test('normaliseText handles nullish and non-string input', () => {
  assert.equal(normaliseText(null), '');
  assert.equal(normaliseText(undefined), '');
  assert.equal(normaliseText(123), '123');
});

/* ------------------------------------------------- q1: the one-word rule */

test('q1 accepts a single word', () => {
  const result = validateAnswer('q1', '  Autonomy  ');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'Autonomy');
});

test('q1 rejects two words', () => {
  const result = validateAnswer('q1', 'self determination');
  assert.equal(result.ok, false);
  assert.match(result.error, /single word/i);
});

test('q1 rejects words separated by a newline or tab', () => {
  assert.equal(validateAnswer('q1', 'self\ndetermination').ok, false);
  assert.equal(validateAnswer('q1', 'self\tdetermination').ok, false);
});

test('q1 rejects a word longer than 30 characters', () => {
  const result = validateAnswer('q1', 'a'.repeat(31));
  assert.equal(result.ok, false);
  assert.match(result.error, /30 characters/);
});

test('q1 accepts a word of exactly 30 characters', () => {
  const result = validateAnswer('q1', 'a'.repeat(30));
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 30);
});

test('q1 measures length in code points, not UTF-16 units', () => {
  // 20 astral emoji = 40 UTF-16 units but only 20 characters.
  const result = validateAnswer('q1', '😀'.repeat(20));
  assert.equal(result.ok, true);
});

test('q1 treats an empty answer as valid but blank', () => {
  const result = validateAnswer('q1', '   ');
  assert.equal(result.ok, true);
  assert.equal(result.value, '');
});

/* ------------------------------------------------------ q2: short phrase */

test('q2 accepts a short phrase', () => {
  const result = validateAnswer('q2', '  a clear next   step ');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'a clear next step');
});

test('q2 caps a long phrase at 120 characters with an ellipsis', () => {
  const result = validateAnswer('q2', 'x'.repeat(200));
  assert.equal(result.ok, true);
  assert.equal([...result.value].length, 120);
  assert.ok(result.value.endsWith('\u2026'));
});

test('q2 leaves a phrase of exactly 120 characters intact', () => {
  const phrase = 'y'.repeat(120);
  const result = validateAnswer('q2', phrase);
  assert.equal(result.ok, true);
  assert.equal(result.value, phrase);
});

test('q2 does not split a surrogate pair when truncating', () => {
  const result = validateAnswer('q2', '😀'.repeat(200));
  assert.equal(result.ok, true);
  // A split pair would leave a lone surrogate / replacement char.
  assert.ok(!/[\uD800-\uDFFF]/.test(result.value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
});

test('unknown question ids are rejected', () => {
  const result = validateAnswer('q9', 'anything');
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------- whole submission */

test('a submission with both answers is accepted', () => {
  const result = validateSubmission({ q1: 'Autonomy', q2: 'a clear next step' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { q1: 'Autonomy', q2: 'a clear next step' });
});

test('either question alone is enough', () => {
  assert.equal(validateSubmission({ q1: 'Control', q2: '' }).ok, true);
  assert.equal(validateSubmission({ q1: '', q2: 'clarity' }).ok, true);
});

test('a fully empty submission is rejected', () => {
  const result = validateSubmission({ q1: '   ', q2: '\n\t ' });
  assert.equal(result.ok, false);
  assert.match(result.errors.form, /at least one/i);
});

test('a missing body is rejected rather than throwing', () => {
  assert.equal(validateSubmission(undefined).ok, false);
  assert.equal(validateSubmission(null).ok, false);
  assert.equal(validateSubmission('not an object').ok, false);
});

test('a field-level error is reported without a form-level error', () => {
  const result = validateSubmission({ q1: 'two words', q2: 'fine' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.q1);
  assert.equal(result.errors.form, undefined);
});

test('extra keys in the body are ignored', () => {
  const result = validateSubmission({ q1: 'Autonomy', q2: '', admin: true, q3: 'nope' });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.values).sort(), ['q1', 'q2']);
});
