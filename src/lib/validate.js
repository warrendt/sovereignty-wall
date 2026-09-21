import { QUESTIONS, getQuestion } from '../config.js';

/**
 * Control characters plus invisible / bidi-override characters.
 *
 * Tab (\u0009), newline (\u000A) and carriage return (\u000D) are deliberately
 * NOT in this class: they are whitespace and must be collapsed to a space, not
 * deleted. Deleting them would silently join words, so "one\ntwo" would sneak
 * past the one-word rule as "onetwo".
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const WHITESPACE_RUN = /\s+/g;

/** Count user-perceived characters rather than UTF-16 units. */
const codePointLength = (value) => [...value].length;

/** Slice by code point so we never split a surrogate pair into mojibake. */
const sliceCodePoints = (value, length) => [...value].slice(0, length).join('');

/**
 * Shared cleanup for every answer: strip invisibles, collapse whitespace runs
 * to a single space, trim, and normalise so visually identical input compares
 * and measures consistently.
 */
export const normaliseText = (raw) =>
  String(raw ?? '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();

/**
 * Validate a single answer against its question.
 *
 * An empty result is valid — each question is individually optional. The
 * "at least one answer" rule is enforced by validateSubmission.
 */
export const validateAnswer = (questionId, raw) => {
  const question = getQuestion(questionId);
  if (!question) {
    return { ok: false, value: '', error: 'Unknown question.' };
  }

  const value = normaliseText(raw);
  if (value === '') return { ok: true, value: '', error: null };

  if (question.kind === 'word') {
    // Whitespace has already been collapsed, so any survivor is a real gap.
    if (/\s/.test(value)) {
      return { ok: false, value, error: 'Please use a single word.' };
    }
    // A "word" longer than the cap is pathological. Truncating would put a
    // mangled fragment on the projector, so we reject and let them fix it.
    if (codePointLength(value) > question.maxLength) {
      return {
        ok: false,
        value,
        error: `Please keep it to ${question.maxLength} characters or fewer.`,
      };
    }
    return { ok: true, value, error: null };
  }

  // Short phrase: capping is friendlier than rejecting, and a trimmed phrase
  // still reads fine on the wall. The ellipsis keeps the cut honest.
  if (codePointLength(value) > question.maxLength) {
    const truncated = `${sliceCodePoints(value, question.maxLength - 1).trimEnd()}\u2026`;
    return { ok: true, value: truncated, error: null };
  }

  return { ok: true, value, error: null };
};

/**
 * Validate a whole submission.
 *
 * @returns {{ok: boolean, values: Record<string, string>, errors: Record<string, string>}}
 */
export const validateSubmission = (body) => {
  const source = body && typeof body === 'object' ? body : {};
  const values = {};
  const errors = {};

  for (const question of QUESTIONS) {
    const result = validateAnswer(question.id, source[question.id]);
    values[question.id] = result.value;
    if (!result.ok) errors[question.id] = result.error;
  }

  const hasAnyAnswer = QUESTIONS.some((question) => values[question.id] !== '');
  if (!hasAnyAnswer && Object.keys(errors).length === 0) {
    errors.form = 'Please answer at least one question.';
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
};
