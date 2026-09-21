import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStorage } from '../src/lib/storage.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'wall-storage-'));

const entry = (id, overrides = {}) => ({
  id,
  question: 'q1',
  text: `answer-${id}`,
  createdAt: new Date().toISOString(),
  submissionId: `sub-${id}`,
  ...overrides,
});

test('starts empty when no file exists yet', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  const result = await storage.init();

  assert.equal(result.restored, 0);
  assert.deepEqual(storage.list(), []);
});

test('writes and reads back entries across a restart', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const first = createStorage({ dataDir });
  await first.init();
  await first.add([entry('a'), entry('b', { question: 'q2', text: 'a clear next step' })]);

  // A brand-new instance over the same directory: the real restart path.
  const second = createStorage({ dataDir });
  const restored = await second.init();

  assert.equal(restored.restored, 2);
  assert.equal(second.count(), 2);
  assert.deepEqual(
    second.list().map((item) => item.id),
    ['a', 'b'],
  );
  assert.equal(second.list()[1].text, 'a clear next step');
});

test('persists valid JSON with a schema version', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a')]);

  const parsed = JSON.parse(await fs.readFile(storage.filePath, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 1);
});

test('leaves no temp files behind after writing', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a')]);
  await storage.add([entry('b')]);

  const files = await fs.readdir(dataDir);
  assert.deepEqual(files, ['answers.json']);
});

test('list returns copies so callers cannot mutate the store', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a')]);

  storage.list()[0].text = 'tampered';
  assert.equal(storage.list()[0].text, 'answer-a');
});

test('concurrent adds are serialised without losing entries', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();

  await Promise.all(
    Array.from({ length: 25 }, (_, index) => storage.add([entry(`e${index}`)])),
  );

  assert.equal(storage.count(), 25);

  const reloaded = createStorage({ dataDir });
  await reloaded.init();
  assert.equal(reloaded.count(), 25);
});

test('drops the oldest entries once the cap is exceeded', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir, maxEntries: 3 });
  await storage.init();

  await storage.add([entry('a'), entry('b'), entry('c')]);
  const result = await storage.add([entry('d')]);

  assert.deepEqual(
    result.dropped.map((item) => item.id),
    ['a'],
  );
  assert.deepEqual(
    storage.list().map((item) => item.id),
    ['b', 'c', 'd'],
  );
});

test('removes a single entry by id', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a'), entry('b')]);

  const removed = await storage.remove('a');
  assert.equal(removed.id, 'a');
  assert.deepEqual(
    storage.list().map((item) => item.id),
    ['b'],
  );

  const reloaded = createStorage({ dataDir });
  await reloaded.init();
  assert.equal(reloaded.count(), 1);
});

test('removing an unknown id returns null and changes nothing', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a')]);

  assert.equal(await storage.remove('nope'), null);
  assert.equal(storage.count(), 1);
});

test('clear empties the store and persists it', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a'), entry('b')]);
  await storage.clear();

  assert.equal(storage.count(), 0);

  const reloaded = createStorage({ dataDir });
  await reloaded.init();
  assert.equal(reloaded.count(), 0);
});

test('quarantines a corrupt file instead of refusing to start', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dataDir, 'answers.json'), '{ this is not json', 'utf8');

  const storage = createStorage({ dataDir });
  const result = await storage.init();

  assert.equal(result.recovered, true);
  assert.equal(storage.count(), 0);

  const files = await fs.readdir(dataDir);
  assert.ok(files.some((name) => name.includes('corrupt')));
});

test('discards malformed entries from an otherwise valid file', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  await fs.writeFile(
    path.join(dataDir, 'answers.json'),
    JSON.stringify({
      version: 1,
      entries: [entry('good'), { id: 'bad' }, null, 'nonsense'],
    }),
    'utf8',
  );

  const storage = createStorage({ dataDir });
  await storage.init();

  assert.equal(storage.count(), 1);
  assert.equal(storage.list()[0].id, 'good');
});

test('using the store before init throws a clear error', async (t) => {
  const dataDir = await tempDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir });
  assert.throws(() => storage.list(), /init/);
});

test('creates the data directory if it is missing', async (t) => {
  const base = await tempDir();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const dataDir = path.join(base, 'nested', 'deeper');
  const storage = createStorage({ dataDir });
  await storage.init();
  await storage.add([entry('a')]);

  assert.equal((await fs.stat(dataDir)).isDirectory(), true);
});
