import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

const positiveInt = (raw, fallback) => {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The two questions are fixed for this session. They live here (not in the
 * HTML) so the wall, the form and the API can never drift apart.
 */
export const QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'q1',
    prompt: 'Describe Sovereignty in one word?',
    kind: 'word',
    maxLength: 30,
    hint: 'One word only.',
    placeholder: 'One word',
  }),
  Object.freeze({
    id: 'q2',
    prompt: 'What would you want to leave this session with today?',
    kind: 'phrase',
    maxLength: 120,
    hint: 'A short phrase.',
    placeholder: 'A short phrase',
  }),
]);

export const QUESTION_IDS = Object.freeze(QUESTIONS.map((question) => question.id));

export const getQuestion = (id) => QUESTIONS.find((question) => question.id === id);

/**
 * App Service Linux only persists `/home`. `WEBSITE_INSTANCE_ID` is set by the
 * platform, so we use it to detect "we are running on App Service" without
 * needing a bespoke app setting. An explicit DATA_DIR always wins.
 */
export const resolveDataDir = (env = process.env) => {
  const explicit = String(env.DATA_DIR ?? '').trim();
  if (explicit !== '') return path.resolve(explicit);
  if (String(env.WEBSITE_INSTANCE_ID ?? '').trim() !== '') return '/home/data';
  return path.join(ROOT_DIR, '..', 'data');
};

export const loadConfig = (env = process.env) => {
  const adminKey = String(env.ADMIN_KEY ?? '').trim();

  return Object.freeze({
    rootDir: ROOT_DIR,
    viewsDir: path.join(ROOT_DIR, '..', 'views'),
    publicDir: path.join(ROOT_DIR, '..', 'public'),
    dataDir: resolveDataDir(env),
    port: positiveInt(env.PORT, 3000),
    questions: QUESTIONS,

    // Abuse guard. A real audience will never approach this.
    maxEntries: positiveInt(env.MAX_ENTRIES, 2000),

    rateLimit: Object.freeze({
      max: positiveInt(env.RATE_LIMIT_MAX, 10),
      windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
    }),

    // Protects the single instance from unbounded open connections.
    maxStreamClients: positiveInt(env.MAX_STREAM_CLIENTS, 500),
    heartbeatMs: positiveInt(env.SSE_HEARTBEAT_MS, 15_000),

    // Empty string disables the admin surface entirely (fail closed).
    adminKey,
    adminEnabled: adminKey !== '',
  });
};
