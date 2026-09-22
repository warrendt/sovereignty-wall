/**
 * End-to-end verification against a running instance — local or deployed.
 *
 *   node scripts/verify.mjs http://127.0.0.1:3000 <admin-key>
 *
 * Exercises the real HTTP surface: pages, static assets, the QR SVG, a live
 * submission pushed over SSE, and admin deletion. Any test answers it creates
 * are deleted again before it exits, so it is safe to run against the wall
 * that is about to go in front of an audience.
 */
const [, , rawBase, adminKey] = process.argv;

if (!rawBase) {
  console.error('usage: node scripts/verify.mjs <base-url> [admin-key]');
  process.exit(2);
}

const base = rawBase.replace(/\/+$/, '');
const results = [];
const created = [];

const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ ok: false, name, detail: error.message });
    console.log(`  FAIL  ${name} — ${error.message}`);
  }
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const get = async (path, init) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const text = await response.text();
  return { response, text };
};

/** Read the SSE stream until `needle` shows up, or give up. */
const openStream = async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  expect(response.ok, `stream returned HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const waitFor = async (needle, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (!buffer.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for "${needle}"`);

      let timer;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('__timeout__'), remaining);
        }),
      ]);
      clearTimeout(timer);

      if (chunk === '__timeout__') throw new Error(`timed out waiting for "${needle}"`);
      if (chunk.done) throw new Error(`stream closed waiting for "${needle}"`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return buffer;
  };

  return { response, waitFor, close: () => controller.abort() };
};

console.log(`\nVerifying ${base}\n`);

await check('GET /healthz', async () => {
  const { response, text } = await get('/healthz');
  expect(response.status === 200, `HTTP ${response.status}`);
  const body = JSON.parse(text);
  expect(body.ok === true, 'not ok');
  return `${body.answers} answers, ${body.streams} streams`;
});

await check('GET / renders the wall with both questions', async () => {
  const { response, text } = await get('/');
  expect(response.status === 200, `HTTP ${response.status}`);
  expect(text.includes('Describe Sovereignty in one word?'), 'question 1 missing');
  expect(
    text.includes('What would you want to leave this session with today?'),
    'question 2 missing',
  );
  return `${text.length} bytes`;
});

await check('GET /submit renders a labelled form', async () => {
  const { response, text } = await get('/submit');
  expect(response.status === 200, `HTTP ${response.status}`);
  expect(text.includes('for="q1"') && text.includes('for="q2"'), 'labels missing');
  return `${text.length} bytes`;
});

await check('GET /qr renders the QR page', async () => {
  const { response, text } = await get('/qr');
  expect(response.status === 200, `HTTP ${response.status}`);
  expect(text.includes('/qr.svg'), 'QR image missing');
  return `${text.length} bytes`;
});

await check('GET /qr.svg encodes this host', async () => {
  const { response, text } = await get('/qr.svg');
  expect(response.status === 200, `HTTP ${response.status}`);
  expect(response.headers.get('content-type')?.includes('image/svg+xml'), 'wrong content-type');
  expect(text.startsWith('<svg'), 'not an SVG');
  return `${text.length} bytes`;
});

const assets = [
  '/css/wall.css',
  '/css/submit.css',
  '/css/qr.css',
  '/js/wall.js',
  '/js/live.js',
  '/js/submit.js',
];

for (const asset of assets) {
  await check(`GET ${asset}`, async () => {
    const { response, text } = await get(asset);
    expect(response.status === 200, `HTTP ${response.status}`);
    return `${text.length} bytes`;
  });
}

await check('security headers present', async () => {
  const { response } = await get('/');
  expect(response.headers.get('x-content-type-options') === 'nosniff', 'no nosniff');
  expect(response.headers.get('content-security-policy'), 'no CSP');
  expect(!response.headers.get('x-powered-by'), 'x-powered-by leaked');
  return 'nosniff + CSP, no x-powered-by';
});

await check('empty submission rejected', async () => {
  const response = await fetch(`${base}/api/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ q1: '', q2: '  ' }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return 'HTTP 400';
});

await check('multi-word answer to question one rejected', async () => {
  const response = await fetch(`${base}/api/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ q1: 'two words', q2: '' }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return 'HTTP 400';
});

let stream;
await check('SSE stream connects and sends a snapshot', async () => {
  stream = await openStream();
  const contentType = stream.response.headers.get('content-type') ?? '';
  expect(contentType.includes('text/event-stream'), `content-type was "${contentType}"`);
  expect(stream.response.headers.get('x-accel-buffering') === 'no', 'missing X-Accel-Buffering');
  await stream.waitFor('event: snapshot');
  return 'snapshot received';
});

const marker = `VERIFY${Date.now().toString(36).toUpperCase()}`;

await check('live submission arrives over SSE', async () => {
  expect(stream, 'stream never opened');

  const response = await fetch(`${base}/api/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ q1: marker, q2: `${marker} phrase` }),
  });
  expect(response.status === 201, `expected 201, got ${response.status}`);

  const body = await response.json();
  created.push(...body.entries.map((entry) => entry.id));

  const buffer = await stream.waitFor('event: added');
  expect(buffer.includes(marker), 'pushed payload did not contain the test answer');
  return `${body.entries.length} entries pushed live`;
});

await check('answer is listed by the API', async () => {
  const { text } = await get('/api/answers');
  expect(text.includes(marker), 'answer missing from listing');
  return 'present';
});

if (adminKey) {
  await check('admin rejects a bad key', async () => {
    const { response } = await get('/admin?key=definitely-wrong');
    expect(response.status === 401, `expected 401, got ${response.status}`);
    return 'HTTP 401';
  });

  await check('admin accepts the real key and lists answers', async () => {
    const { response, text } = await get(`/admin?key=${encodeURIComponent(adminKey)}`);
    expect(response.status === 200, `expected 200, got ${response.status}`);
    expect(text.includes(marker), 'test answer not listed');
    return 'HTTP 200';
  });
}

await check('test answers cleaned up', async () => {
  if (!adminKey) throw new Error('no admin key supplied — CLEAN UP MANUALLY');
  expect(stream, 'stream never opened');

  for (const id of created) {
    const response = await fetch(`${base}/api/answers/${id}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': adminKey },
    });
    expect(response.ok, `delete ${id} returned HTTP ${response.status}`);
  }

  await stream.waitFor('event: removed');

  const { text } = await get('/api/answers');
  expect(!text.includes(marker), 'test answer still present after delete');
  return `${created.length} removed, wall is clean`;
});

stream?.close();

const failed = results.filter((result) => !result.ok);
const { text: finalHealth } = await get('/healthz');

console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
console.log(`Final state: ${finalHealth}\n`);

process.exit(failed.length === 0 ? 0 : 1);
