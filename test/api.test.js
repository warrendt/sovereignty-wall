import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createStorage } from '../src/lib/storage.js';
import { createRateLimiter } from '../src/lib/rate-limit.js';
import { createSseHub } from '../src/lib/sse.js';

const ADMIN_KEY = 'test-admin-key';

/** Boot the real app on an ephemeral port over a throwaway data directory. */
const startApp = async (t, env = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-api-'));
  const config = loadConfig({ DATA_DIR: dataDir, ADMIN_KEY, ...env });

  const storage = createStorage({ dataDir: config.dataDir, maxEntries: config.maxEntries });
  const limiter = createRateLimiter(config.rateLimit);
  const hub = createSseHub({
    heartbeatMs: config.heartbeatMs,
    maxClients: config.maxStreamClients,
  });

  await storage.init();
  const app = await createApp({ config, storage, limiter, hub });

  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    hub.closeAll();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  return { base, storage, hub, config };
};

const postAnswer = (base, body, init = {}) =>
  fetch(`${base}/api/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });

/** Minimal SSE client: reads the raw stream and waits for a marker. */
const openStream = async (base) => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const waitFor = async (needle, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;

    while (!buffer.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for "${needle}". Got: ${buffer}`);

      let timer;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('__timeout__'), remaining);
        }),
      ]);
      clearTimeout(timer);

      if (chunk === '__timeout__') {
        throw new Error(`timed out waiting for "${needle}". Got: ${buffer}`);
      }
      if (chunk.done) throw new Error(`stream closed waiting for "${needle}". Got: ${buffer}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return buffer;
  };

  return { response, waitFor, close: () => controller.abort() };
};

/* ----------------------------------------------------------------- pages */

test('the wall renders both questions', async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(`${base}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.ok(html.includes('Describe Sovereignty in one word?'));
  assert.ok(html.includes('What would you want to leave this session with today?'));
});

test('the submit form renders labelled inputs for both questions', async (t) => {
  const { base } = await startApp(t);
  const html = await fetch(`${base}/submit`).then((response) => response.text());

  assert.ok(html.includes('<label class="label" for="q1">'));
  assert.ok(html.includes('<label class="label" for="q2">'));
  assert.ok(html.includes('id="q1"'));
  assert.ok(html.includes('id="q2"'));
});

test('the QR page and SVG are generated from the incoming host', async (t) => {
  const { base } = await startApp(t);

  const page = await fetch(`${base}/qr`, { headers: { host: '127.0.0.1' } });
  assert.ok((await page.text()).includes('/submit'));

  const svg = await fetch(`${base}/qr.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');

  const markup = await svg.text();
  assert.ok(markup.startsWith('<svg'));
  assert.ok(markup.includes('xmlns="http://www.w3.org/2000/svg"'));
  // No intrinsic width/height, so the stylesheet decides how big it renders.
  assert.ok(markup.includes('viewBox='));
});

test('a forwarded host changes the generated QR, proving it is not hardcoded', async (t) => {
  const { base } = await startApp(t);

  const first = await fetch(`${base}/qr.svg`, {
    headers: { 'x-forwarded-host': 'wall-a.example.com', 'x-forwarded-proto': 'https' },
  }).then((response) => response.text());

  const second = await fetch(`${base}/qr.svg`, {
    headers: { 'x-forwarded-host': 'wall-b.example.com', 'x-forwarded-proto': 'https' },
  }).then((response) => response.text());

  assert.notEqual(first, second);
});

test('health reports the answer and stream counts', async (t) => {
  const { base } = await startApp(t);
  const body = await fetch(`${base}/healthz`).then((response) => response.json());

  assert.deepEqual(body, { ok: true, answers: 0, streams: 0 });
});

test('security headers are set on every response', async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(`${base}/`);

  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.equal(response.headers.get('x-powered-by'), null);
});

/* ----------------------------------------------------------- submissions */

test('a valid submission creates one entry per answered question', async (t) => {
  const { base } = await startApp(t);

  const response = await postAnswer(base, { q1: 'Autonomy', q2: 'a clear next step' });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.entries.length, 2);
  assert.equal(body.count, 2);

  const questions = body.entries.map((entry) => entry.question).sort();
  assert.deepEqual(questions, ['q1', 'q2']);
  // Both halves of one submission share a submission id.
  assert.equal(body.entries[0].submissionId, body.entries[1].submissionId);
});

test('answering only one question creates only one entry', async (t) => {
  const { base } = await startApp(t);
  const body = await postAnswer(base, { q1: 'Control', q2: '' }).then((r) => r.json());

  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].question, 'q1');
});

test('a fully empty submission is rejected', async (t) => {
  const { base } = await startApp(t);
  const response = await postAnswer(base, { q1: '  ', q2: '' });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.errors.form, /at least one/i);
});

test('a multi-word answer to question one is rejected', async (t) => {
  const { base } = await startApp(t);
  const response = await postAnswer(base, { q1: 'self determination', q2: '' });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.errors.q1, /single word/i);
});

test('an over-long phrase is stored capped rather than rejected', async (t) => {
  const { base } = await startApp(t);
  const body = await postAnswer(base, { q1: '', q2: 'z'.repeat(400) }).then((r) => r.json());

  assert.equal(body.ok, true);
  assert.equal([...body.entries[0].text].length, 120);
});

test('submitted answers are listed by the API', async (t) => {
  const { base } = await startApp(t);
  await postAnswer(base, { q1: 'Autonomy', q2: '' });

  const body = await fetch(`${base}/api/answers`).then((response) => response.json());
  assert.equal(body.count, 1);
  assert.equal(body.entries[0].text, 'Autonomy');
  assert.ok(body.submitUrl.endsWith('/submit'));
});

test('a browser form post without JS redirects instead of returning JSON', async (t) => {
  const { base } = await startApp(t);

  const response = await fetch(`${base}/api/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: new URLSearchParams({ q1: 'Resilience', q2: '' }).toString(),
    redirect: 'manual',
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/submit?status=ok');
});

test('the rate limiter blocks a flood and reports Retry-After', async (t) => {
  const { base } = await startApp(t, { RATE_LIMIT_MAX: '3' });

  for (let i = 0; i < 3; i += 1) {
    const allowed = await postAnswer(base, { q1: `word${i}`, q2: '' });
    assert.equal(allowed.status, 201, `submission ${i + 1} should be allowed`);
  }

  const blocked = await postAnswer(base, { q1: 'toomuch', q2: '' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await blocked.json()).ok, false);
});

test('the total cap drops the oldest answer instead of refusing new ones', async (t) => {
  const { base } = await startApp(t, { MAX_ENTRIES: '2', RATE_LIMIT_MAX: '50' });

  await postAnswer(base, { q1: 'first', q2: '' });
  await postAnswer(base, { q1: 'second', q2: '' });
  await postAnswer(base, { q1: 'third', q2: '' });

  const body = await fetch(`${base}/api/answers`).then((response) => response.json());
  assert.equal(body.count, 2);
  assert.deepEqual(
    body.entries.map((entry) => entry.text),
    ['second', 'third'],
  );
});

/* ------------------------------------------------------------------- sse */

test('the SSE stream sets the headers proxies need', async (t) => {
  const { base } = await startApp(t);
  const stream = await openStream(base);
  t.after(() => stream.close());

  assert.equal(stream.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(stream.response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(stream.response.headers.get('x-accel-buffering'), 'no');
});

test('a new connection receives a snapshot of existing answers', async (t) => {
  const { base } = await startApp(t);
  await postAnswer(base, { q1: 'Existing', q2: '' });

  const stream = await openStream(base);
  t.after(() => stream.close());

  const buffer = await stream.waitFor('event: snapshot');
  assert.ok(buffer.includes('Existing'));
});

test('a submission is pushed to a connected stream', async (t) => {
  const { base } = await startApp(t);

  const stream = await openStream(base);
  t.after(() => stream.close());
  await stream.waitFor('event: snapshot');

  await postAnswer(base, { q1: 'Landed', q2: '' });

  const buffer = await stream.waitFor('event: added');
  assert.ok(buffer.includes('Landed'));
});

test('a deletion is pushed to a connected stream', async (t) => {
  const { base } = await startApp(t);
  const created = await postAnswer(base, { q1: 'Doomed', q2: '' }).then((r) => r.json());

  const stream = await openStream(base);
  t.after(() => stream.close());
  await stream.waitFor('event: snapshot');

  await fetch(`${base}/api/answers/${created.entries[0].id}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });

  const buffer = await stream.waitFor('event: removed');
  assert.ok(buffer.includes(created.entries[0].id));
});

/* ----------------------------------------------------------------- admin */

test('the admin page requires the key', async (t) => {
  const { base } = await startApp(t);

  assert.equal((await fetch(`${base}/admin`)).status, 401);
  assert.equal((await fetch(`${base}/admin?key=wrong`)).status, 401);
  assert.equal((await fetch(`${base}/admin?key=${ADMIN_KEY}`)).status, 200);
});

test('the admin surface is disabled entirely when no key is configured', async (t) => {
  const { base } = await startApp(t, { ADMIN_KEY: '' });

  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(`${base}/admin?key=`)).status, 404);

  const deletion = await fetch(`${base}/api/answers/anything`, { method: 'DELETE' });
  assert.equal(deletion.status, 404);
});

test('the admin page escapes audience text instead of rendering it', async (t) => {
  const { base } = await startApp(t);
  // No whitespace, so this passes the one-word rule and really does get stored.
  await postAnswer(base, { q1: '<script>alert(1)</script>', q2: '' });

  const html = await fetch(`${base}/admin?key=${ADMIN_KEY}`).then((r) => r.text());

  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('deleting requires a valid key and removes the answer', async (t) => {
  const { base } = await startApp(t);
  const created = await postAnswer(base, { q1: 'Removable', q2: '' }).then((r) => r.json());
  const { id } = created.entries[0];

  const unauthorised = await fetch(`${base}/api/answers/${id}`, { method: 'DELETE' });
  assert.equal(unauthorised.status, 401);

  const authorised = await fetch(`${base}/api/answers/${id}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert.equal(authorised.status, 200);
  assert.equal((await authorised.json()).count, 0);

  const remaining = await fetch(`${base}/api/answers`).then((r) => r.json());
  assert.equal(remaining.count, 0);
});

test('deleting an unknown id returns 404', async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(`${base}/api/answers/does-not-exist`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });

  assert.equal(response.status, 404);
});

test('unknown routes return 404 without leaking internals', async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(`${base}/nope`, { headers: { accept: 'application/json' } });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
});
