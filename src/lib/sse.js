/**
 * In-process Server-Sent Events fan-out.
 *
 * Because the client set lives in this process, the app MUST run on a single
 * instance — a second instance would only ever notify its own listeners.
 */
export const createSseHub = ({ heartbeatMs = 15_000, maxClients = 500 } = {}) => {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let heartbeatTimer = null;

  const writeEvent = (res, event, data) => {
    try {
      // JSON.stringify never emits a raw newline, so a single data: line is safe.
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      clients.delete(res);
      return false;
    }
  };

  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const res of clients) {
        try {
          // A comment frame: keeps App Service / intermediate proxies from
          // reaping an idle connection, and costs the client nothing.
          res.write(': ping\n\n');
        } catch {
          clients.delete(res);
        }
      }
    }, heartbeatMs);
    // Never hold the process open just for heartbeats.
    heartbeatTimer.unref?.();
  };

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  /**
   * Attach a response as an SSE client.
   * @returns {boolean} false when the connection cap is already reached.
   */
  const addClient = (req, res, initialEvent) => {
    if (clients.size >= maxClients) return false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell nginx-style proxies not to buffer; without it the stream can sit
      // in a proxy buffer and never reach the wall.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Tell the browser how quickly to reconnect if the stream drops.
    res.write('retry: 3000\n\n');

    clients.add(res);
    startHeartbeat();

    if (initialEvent) writeEvent(res, initialEvent.event, initialEvent.data);

    const cleanup = () => {
      clients.delete(res);
      if (clients.size === 0) stopHeartbeat();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);

    return true;
  };

  const broadcast = (event, data) => {
    for (const res of [...clients]) writeEvent(res, event, data);
  };

  const closeAll = () => {
    stopHeartbeat();
    for (const res of [...clients]) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
  };

  return {
    addClient,
    broadcast,
    closeAll,
    get clientCount() {
      return clients.size;
    },
  };
};
