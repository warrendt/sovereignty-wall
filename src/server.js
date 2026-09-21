import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createStorage } from './lib/storage.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { createSseHub } from './lib/sse.js';

const config = loadConfig(process.env);

const storage = createStorage({ dataDir: config.dataDir, maxEntries: config.maxEntries });
const limiter = createRateLimiter(config.rateLimit);
const hub = createSseHub({ heartbeatMs: config.heartbeatMs, maxClients: config.maxStreamClients });

const restore = await storage.init();
const app = await createApp({ config, storage, limiter, hub });

const server = app.listen(config.port, () => {
  console.log(`[sovereignty-wall] listening on :${config.port}`);
  console.log(`[sovereignty-wall] data dir: ${config.dataDir}`);
  console.log(`[sovereignty-wall] restored ${restore.restored} answer(s)`);
  if (restore.recovered) {
    console.warn(`[sovereignty-wall] corrupt store quarantined at ${restore.quarantine}`);
  }
  console.log(`[sovereignty-wall] admin surface: ${config.adminEnabled ? 'enabled' : 'DISABLED'}`);
});

// App Service sends SIGTERM on restart/scale events; close the SSE streams
// first so clients reconnect cleanly instead of hanging on a dead socket.
const shutdown = (signal) => () => {
  console.log(`[sovereignty-wall] ${signal} received, shutting down`);
  hub.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
