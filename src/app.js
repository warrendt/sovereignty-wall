import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

import { QUESTIONS } from './config.js';
import { escapeHtml } from './lib/escape.js';
import { renderTemplate } from './lib/template.js';
import { validateSubmission } from './lib/validate.js';
import { clientIp, publicBaseUrl, displayHost } from './lib/request.js';

const VIEW_NAMES = ['wall', 'submit', 'qr', 'admin'];

const loadViews = async (viewsDir) => {
  const entries = await Promise.all(
    VIEW_NAMES.map(async (name) => [
      name,
      await fs.readFile(path.join(viewsDir, `${name}.html`), 'utf8'),
    ]),
  );
  return Object.fromEntries(entries);
};

/** Constant-time comparison that does not leak length through early return. */
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    // Still do a comparison so the timing profile stays flat.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
};

const noStore = (res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
};

/**
 * Build the Express app.
 *
 * Takes its collaborators as arguments so tests can mount the real routes
 * against a temp-dir storage and a fake clock.
 */
export const createApp = async ({ config, storage, limiter, hub }) => {
  const views = await loadViews(config.viewsDir);
  const assetVersion = Date.now().toString(36);

  /** QR SVGs are deterministic per origin, so cache them. */
  const qrCache = new Map();

  const app = express();

  // Only used so `req.protocol` honours X-Forwarded-Proto. Client IP is
  // resolved separately (see lib/request.js) because trusting every proxy for
  // `req.ip` would make the rate limiter forgeable.
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join('; '),
    );
    next();
  });

  app.use(express.json({ limit: '8kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));

  // Revalidate every time: during a live session a stale asset is far more
  // expensive than a 304.
  app.use(
    express.static(config.publicDir, {
      index: false,
      etag: true,
      maxAge: 0,
      redirect: false,
    }),
  );

  const originFor = (req) => {
    const baseUrl = publicBaseUrl(req, config.port);
    return { baseUrl, submitUrl: `${baseUrl}/submit`, submitHost: displayHost(baseUrl) };
  };

  const adminKeyFrom = (req) => {
    const header = req.get('x-admin-key');
    if (typeof header === 'string' && header !== '') return header;
    const queryKey = req.query?.key;
    return typeof queryKey === 'string' ? queryKey : '';
  };

  const isAdmin = (req) => config.adminEnabled && safeEqual(adminKeyFrom(req), config.adminKey);

  const snapshot = () => ({ entries: storage.list(), count: storage.count() });

  // ---------------------------------------------------------------- pages

  app.get('/healthz', (req, res) => {
    noStore(res);
    res.json({ ok: true, answers: storage.count(), streams: hub.clientCount });
  });

  app.get('/', (req, res) => {
    const { submitUrl, submitHost } = originFor(req);
    noStore(res);
    res.type('html').send(
      renderTemplate(views.wall, {
        ASSET_VERSION: assetVersion,
        Q1_PROMPT: QUESTIONS[0].prompt,
        Q2_PROMPT: QUESTIONS[1].prompt,
        SUBMIT_URL: submitUrl,
        SUBMIT_HOST: submitHost,
      }),
    );
  });

  app.get('/submit', (req, res) => {
    noStore(res);
    res.type('html').send(
      renderTemplate(views.submit, {
        ASSET_VERSION: assetVersion,
        Q1_PROMPT: QUESTIONS[0].prompt,
        Q2_PROMPT: QUESTIONS[1].prompt,
        Q1_HINT: QUESTIONS[0].hint,
        Q2_HINT: QUESTIONS[1].hint,
        Q1_MAXLEN: String(QUESTIONS[0].maxLength),
        Q2_MAXLEN: String(QUESTIONS[1].maxLength),
        Q1_PLACEHOLDER: QUESTIONS[0].placeholder,
        Q2_PLACEHOLDER: QUESTIONS[1].placeholder,
      }),
    );
  });

  app.get('/qr', (req, res) => {
    const { submitUrl, submitHost } = originFor(req);
    noStore(res);
    res.type('html').send(
      renderTemplate(views.qr, {
        ASSET_VERSION: assetVersion,
        SUBMIT_URL: submitUrl,
        SUBMIT_HOST: submitHost,
      }),
    );
  });

  /** QR is generated from the incoming request host, never hardcoded. */
  app.get('/qr.svg', async (req, res, next) => {
    try {
      const { submitUrl } = originFor(req);
      let svg = qrCache.get(submitUrl);
      if (!svg) {
        svg = await QRCode.toString(submitUrl, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
          color: { dark: '#0a0e17ff', light: '#ffffffff' },
        });
        qrCache.set(submitUrl, svg);
      }
      res.type('image/svg+xml');
      res.set('Cache-Control', 'public, max-age=300');
      res.send(svg);
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------ api

  app.get('/api/answers', (req, res) => {
    const { submitUrl } = originFor(req);
    noStore(res);
    res.json({ ...snapshot(), submitUrl });
  });

  app.post('/api/answers', async (req, res, next) => {
    try {
      const wantsHtml = req.accepts(['json', 'html']) === 'html';
      const limit = limiter.consume(clientIp(req));

      if (!limit.allowed) {
        const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
        res.set('Retry-After', String(retryAfter));
        if (wantsHtml) return res.redirect(303, '/submit?status=ratelimited');
        return res.status(429).json({
          ok: false,
          errors: { form: 'That is a lot of answers. Give it a minute and try again.' },
          retryAfterSeconds: retryAfter,
        });
      }

      const { ok, values, errors } = validateSubmission(req.body);
      if (!ok) {
        if (wantsHtml) return res.redirect(303, '/submit?status=invalid');
        return res.status(400).json({ ok: false, errors });
      }

      const submissionId = randomUUID();
      const createdAt = new Date().toISOString();
      const entries = QUESTIONS.filter((question) => values[question.id] !== '').map(
        (question) => ({
          id: randomUUID(),
          question: question.id,
          text: values[question.id],
          createdAt,
          submissionId,
        }),
      );

      const { added, dropped } = await storage.add(entries);
      const count = storage.count();

      if (dropped.length > 0) {
        hub.broadcast('removed', { ids: dropped.map((entry) => entry.id), count });
      }
      hub.broadcast('added', { entries: added, count });

      if (wantsHtml) return res.redirect(303, '/submit?status=ok');
      return res.status(201).json({ ok: true, entries: added, count });
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/api/answers/:id', async (req, res, next) => {
    try {
      if (!config.adminEnabled) {
        return res.status(404).json({ ok: false, error: 'Admin is not enabled.' });
      }
      if (!isAdmin(req)) {
        return res.status(401).json({ ok: false, error: 'Invalid admin key.' });
      }

      const removed = await storage.remove(req.params.id);
      if (!removed) return res.status(404).json({ ok: false, error: 'No such answer.' });

      const count = storage.count();
      hub.broadcast('removed', { ids: [removed.id], count });
      noStore(res);
      return res.json({ ok: true, removed, count });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/stream', (req, res) => {
    const accepted = hub.addClient(req, res, { event: 'snapshot', data: snapshot() });
    if (!accepted) {
      res.status(503).json({ ok: false, error: 'Too many live connections.' });
    }
  });

  // ---------------------------------------------------------------- admin

  app.get('/admin', (req, res) => {
    noStore(res);
    res.set('X-Robots-Tag', 'noindex, nofollow');

    if (!config.adminEnabled) {
      return res.status(404).type('html').send('<!doctype html><title>Not found</title>Not found');
    }
    if (!isAdmin(req)) {
      return res
        .status(401)
        .type('html')
        .send('<!doctype html><title>Unauthorised</title>Add ?key=&lt;ADMIN_KEY&gt; to the URL.');
    }

    const byId = new Map(QUESTIONS.map((question) => [question.id, question.prompt]));
    const entries = storage.list().reverse();

    const rows =
      entries.length === 0
        ? '<li class="empty">No answers yet.</li>'
        : entries
            .map(
              (entry) => `<li class="row" data-id="${escapeHtml(entry.id)}">
  <div class="meta">
    <span class="tag tag-${escapeHtml(entry.question)}">${escapeHtml(byId.get(entry.question) ?? entry.question)}</span>
    <time datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(entry.createdAt.replace('T', ' ').slice(0, 19))} UTC</time>
  </div>
  <p class="text">${escapeHtml(entry.text)}</p>
  <button type="button" class="delete" data-id="${escapeHtml(entry.id)}">Delete</button>
</li>`,
            )
            .join('\n');

    return res.type('html').send(
      renderTemplate(views.admin, {
        ASSET_VERSION: assetVersion,
        ADMIN_KEY: adminKeyFrom(req),
        COUNT: String(entries.length),
        ROWS: rows,
      }),
    );
  });

  // --------------------------------------------------------------- errors

  app.use((req, res) => {
    noStore(res);
    if (req.accepts(['json', 'html']) === 'html') {
      return res
        .status(404)
        .type('html')
        .send('<!doctype html><title>Not found</title><a href="/">Go to the wall</a>');
    }
    return res.status(404).json({ ok: false, error: 'Not found.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('[sovereignty-wall] request failed:', error);
    noStore(res);
    // Never leak internals to an audience-facing surface.
    return res.status(500).json({ ok: false, error: 'Something went wrong.' });
  });

  return app;
};
