# Sovereignty Wall

A live audience word-wall for a session. The audience scans a QR code, answers two
questions on their phone, and their words land on a projector wall in real time.

## Surfaces

| Surface | Route | What it's for |
| --- | --- | --- |
| **Wall** | `/` | Put this on the projector |
| **Submit** | `/submit` | Where the audience lands |
| **QR** | `/qr` | Full-screen QR — show this first |
| **Admin** | `/admin?key=…` | Delete anything inappropriate, fast |

The admin key is **never** stored in this repo. Supply it as the `ADMIN_KEY`
environment variable wherever you run the app. If it is unset, the admin surface
and the delete API fail closed (404).

## The two questions

1. Describe Sovereignty in one word?
2. What would you want to leave this session with today?

They are defined once, in `src/config.js`, and flow to the wall, the form and the
API from there so they can never drift apart. Edit that file to run the wall with
your own questions.

## Running it locally

```bash
npm install
ADMIN_KEY=local-dev-key npm start     # http://localhost:3000
npm test                              # node --test, no extra frameworks
node scripts/verify.mjs http://localhost:3000 local-dev-key
node scripts/clear.mjs  http://localhost:3000 local-dev-key
```

`scripts/verify.mjs` drives the real HTTP surface end to end — pages, assets, a
live submission over SSE, admin deletion — and removes the answers it creates.
It is safe to point at a deployed instance.

`scripts/clear.mjs` wipes every answer through the admin API. Use it right
before a session starts; connected projectors update live over SSE. It refuses
to delete anything if the admin key is wrong.

## Configuration

Every setting is an environment variable; see `.env.example` for a copyable list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_KEY` | *(empty)* | Enables the admin surface. Empty disables it entirely. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where `answers.json` is written. |
| `MAX_ENTRIES` | `2000` | Cap on stored answers; oldest are evicted first. |
| `RATE_LIMIT_MAX` | `10` | Submissions allowed per IP per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `MAX_STREAM_CLIENTS` | `500` | Cap on concurrent SSE connections. |
| `SSE_HEARTBEAT_MS` | `15000` | Heartbeat interval that keeps proxies from idling out streams. |

## How it works

- **Node 22 + Express 5**, ESM, **no build step**. Plain CSS and vanilla JS served
  statically, so any plain `node src/server.js` host works.
- **Two dependencies**, both pure JS: `express` and `qrcode`. Nothing needs
  node-gyp.
- **Persistence** is a flat JSON file written atomically (temp file, fsync,
  rename), in `DATA_DIR`.
- **Live updates** use Server-Sent Events, with automatic fallback to polling if
  `EventSource` fails or is unavailable. A heartbeat comment every 15s keeps
  proxies from killing idle connections.
- **The QR is generated from the incoming request host** at runtime, so the same
  code produces a working QR locally and when deployed, with no edits.

### Single instance, deliberately

SSE fan-out is in-process, so **this app must not scale out**. Run exactly one
instance, and start it directly with `node src/server.js` so a platform process
manager cannot fork it into cluster mode.

## Documentation

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the full write-up: the
request/SSE flow diagram, the decisions behind the validation rules, a deployment
outline, and the pre-session runbook.

## Contributing and security

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to propose changes.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability.

## Licence

[MIT](LICENSE).
