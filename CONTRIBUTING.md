# Contributing

Thanks for taking an interest. This is a small, deliberately dependency-light
project; changes that keep it that way are the easiest to merge.

## Getting set up

```bash
npm install
ADMIN_KEY=local-dev-key npm start     # http://localhost:3000
npm test
node scripts/verify.mjs http://localhost:3000 local-dev-key
```

Node 22 or newer is required (`package.json#engines`).

## Ground rules

- **No build step.** Plain ESM, plain CSS, vanilla browser JS.
- **No new runtime dependencies** unless there is no reasonable alternative, and
  none that require native compilation.
- **No inline scripts or styles.** The CSP is `default-src 'self'` with no
  `unsafe-inline`; user text reaches the DOM through `textContent`, never
  `innerHTML`.
- **Tests come with the change.** The suite is `node --test`, no framework.
- **Never commit secrets.** `ADMIN_KEY` and any real deployment hostnames stay
  out of the repo; use environment variables and `example.com` placeholders.
- Read [`docs/OPERATIONS.md`](docs/OPERATIONS.md) before changing validation,
  storage, SSE or the rate limiter — the trade-offs behind them are documented
  there.

## Submitting

1. Open an issue first for anything non-trivial.
2. Keep pull requests focused, and make sure `npm test` passes.
3. Describe what you changed and why in the pull request body.
