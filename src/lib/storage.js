import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE_NAME = 'answers.json';
const SCHEMA_VERSION = 1;

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';

/** Defensive parse — never let a hand-edited or truncated file crash startup. */
const sanitiseEntries = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      isNonEmptyString(entry.id) &&
      isNonEmptyString(entry.question) &&
      isNonEmptyString(entry.text) &&
      isNonEmptyString(entry.createdAt),
  );
};

/**
 * Flat-JSON answer store with atomic writes.
 *
 * The in-memory array is the read path (single instance, so it is always
 * authoritative); the file is the durability path. Writes are serialised
 * through a promise chain so two concurrent submissions can never interleave
 * and produce a torn file.
 */
export const createStorage = ({ dataDir, maxEntries = 2000 }) => {
  const filePath = path.join(dataDir, FILE_NAME);

  /** @type {Array<{id:string,question:string,text:string,createdAt:string,submissionId:string}>} */
  let entries = [];
  let ready = false;
  let writeChain = Promise.resolve();

  /** Serialise all mutations; each caller still gets its own result/error. */
  const withLock = (fn) => {
    const result = writeChain.then(fn);
    writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const writeAtomic = async (payload) => {
    const json = JSON.stringify(payload, null, 2);
    const tmpPath = path.join(dataDir, `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);

    try {
      const handle = await fs.open(tmpPath, 'w');
      try {
        await handle.writeFile(json, 'utf8');
        // Flush to disk before the rename so a crash can't leave us with a
        // renamed-but-empty file.
        await handle.sync();
      } finally {
        await handle.close();
      }
      // rename(2) is atomic within a filesystem; Node maps this to
      // MoveFileEx(MOVEFILE_REPLACE_EXISTING) on Windows.
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const persist = () => writeAtomic({ version: SCHEMA_VERSION, entries });

  const init = async () => {
    await fs.mkdir(dataDir, { recursive: true });

    let contents;
    try {
      contents = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries = [];
      ready = true;
      return { restored: 0, recovered: false };
    }

    try {
      const parsed = JSON.parse(contents);
      entries = sanitiseEntries(parsed?.entries);
      ready = true;
      return { restored: entries.length, recovered: false };
    } catch {
      // A corrupt file must not brick a live session. Quarantine it and carry
      // on with an empty wall rather than refusing to boot.
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      await fs.rename(filePath, quarantine).catch(() => {});
      entries = [];
      ready = true;
      return { restored: 0, recovered: true, quarantine };
    }
  };

  const assertReady = () => {
    if (!ready) throw new Error('storage.init() must be awaited before use');
  };

  /** Newest last, matching insertion order. */
  const list = () => {
    assertReady();
    return entries.map((entry) => ({ ...entry }));
  };

  const count = () => {
    assertReady();
    return entries.length;
  };

  /**
   * Append entries, enforcing the total cap.
   *
   * When the cap is hit we drop the OLDEST entries rather than rejecting the
   * submission: a live audience should never be told "the wall is full". The
   * dropped ids are returned so the caller can tell connected clients to
   * remove them and stay in sync.
   */
  const add = (newEntries) =>
    withLock(async () => {
      assertReady();
      const toAdd = newEntries.map((entry) => ({ ...entry }));
      entries = [...entries, ...toAdd];

      let dropped = [];
      if (entries.length > maxEntries) {
        dropped = entries.slice(0, entries.length - maxEntries);
        entries = entries.slice(entries.length - maxEntries);
      }

      await persist();
      return { added: toAdd, dropped };
    });

  const remove = (id) =>
    withLock(async () => {
      assertReady();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return null;

      const [removed] = entries.splice(index, 1);
      await persist();
      return removed;
    });

  const clear = () =>
    withLock(async () => {
      assertReady();
      const removed = entries;
      entries = [];
      await persist();
      return removed;
    });

  return { init, list, count, add, remove, clear, filePath };
};
