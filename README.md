# Sovereignty Wall

A live audience word-wall for a session. The audience scans a QR code, answers two
questions on their phone, and their words land on a projector wall in real time.

## Live URLs

| Surface | URL | What it's for |
| --- | --- | --- |
| **Wall** | https://sovereignty-wall-7y580s.azurewebsites.net/ | Put this on the projector |
| **Submit** | https://sovereignty-wall-7y580s.azurewebsites.net/submit | Where the audience lands |
| **QR** | https://sovereignty-wall-7y580s.azurewebsites.net/qr | Full-screen QR — show this first |
| **Admin** | https://sovereignty-wall-7y580s.azurewebsites.net/admin?key=… | Delete anything inappropriate, fast |

The admin key is **not** in this repo. It lives as an App Service app setting:

```bash
az webapp config appsettings list \
  -g rg-sovereignty-wall -n sovereignty-wall-7y580s \
  --query "[?name=='ADMIN_KEY'].value" -o tsv
```

## The two questions

1. Describe Sovereignty in one word?
2. What would you want to leave this session with today?

They are defined once, in `src/config.js`, and flow to the wall, the form and the
API from there so they can never drift apart.

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
It is safe to point at the live site.

`scripts/clear.mjs` wipes every answer through the admin API. Use it right
before a session starts; connected projectors update live over SSE. It refuses
to delete anything if the admin key is wrong.

## How it works

- **Node 22 + Express 5**, ESM, **no build step**. Plain CSS and vanilla JS served
  statically, so `az webapp up` just works.
- **Two dependencies**, both pure JS: `express` and `qrcode`. Nothing needs
  node-gyp, so Oryx builds cleanly.
- **Persistence** is a flat JSON file written atomically (temp file, fsync,
  rename). `DATA_DIR` defaults to `/home/data` on App Service (which persists)
  and `./data` locally.
- **Live updates** use Server-Sent Events, with automatic fallback to polling if
  `EventSource` fails or is unavailable. A heartbeat comment every 15s keeps
  proxies from killing idle connections.
- **The QR is generated from the incoming request host** at runtime, so the same
  code produces a working QR locally and in Azure with no edits.

### Single instance, deliberately

SSE fan-out is in-process, so **this app must not scale out**. The plan is pinned
to one instance and the startup command is set explicitly to `node src/server.js`
so the platform can't start it under PM2 in cluster mode.

## Architecture

See [`docs/HANDOVER.md`](docs/HANDOVER.md) for the full write-up, the request/SSE
flow diagram, the decisions behind the validation rules, and the pre-session
runbook.
