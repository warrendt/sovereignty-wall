const HTML_ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
});

/**
 * Escape a value for safe interpolation into HTML text or a quoted attribute.
 * Audience-submitted content ends up on a projector, so every path that puts
 * user text into markup goes through here.
 */
export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"'`]/g, (char) => HTML_ENTITIES[char]);
