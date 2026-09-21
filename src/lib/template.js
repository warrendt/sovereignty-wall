import { escapeHtml } from './escape.js';

const TOKEN = /\{\{(&?)([A-Z0-9_]+)\}\}/g;

/**
 * Minimal, dependency-free template rendering.
 *
 * `{{NAME}}`  -> HTML-escaped substitution (the default, and what user text
 *                must always use).
 * `{{&NAME}}` -> raw substitution, for fragments we built ourselves and have
 *                already escaped.
 *
 * Missing keys throw: templates are static and fully covered by tests, so a
 * miss is a coding error we want to find immediately rather than a silently
 * blank projector.
 */
export const renderTemplate = (template, vars = {}) =>
  String(template).replace(TOKEN, (_match, rawMarker, key) => {
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`renderTemplate: missing value for "${key}"`);
    }
    const value = vars[key];
    return rawMarker === '&' ? String(value ?? '') : escapeHtml(value);
  });
