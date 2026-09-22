# Security policy

## Supported versions

Only the `main` branch is supported.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/warrendt/sovereignty-wall/security/advisories/new)
rather than opening a public issue. Include reproduction steps and the impact you
believe the issue has; you can expect an initial response within a few days.

## Operational notes

- `ADMIN_KEY` gates the moderation page and the delete API. Keep it in a secret
  store, use a long random value, and rotate it between sessions.
- If `ADMIN_KEY` is unset the admin surface fails closed (404). That is intended.
- Submitted answers are public by design: they are shown on a projector and
  served from `GET /api/answers`. Do not use this app to collect anything
  sensitive or personal.
- Rate limiting is per client IP and relies on the right-most `X-Forwarded-For`
  entry. It is only trustworthy behind a proxy that appends to that header.
