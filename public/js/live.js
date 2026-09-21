/**
 * Live answer feed.
 *
 * Server-Sent Events is the primary transport. If the browser has no
 * EventSource, or the stream fails repeatedly (or is refused outright), we
 * degrade to polling /api/answers so the wall never silently goes stale.
 */

const POLL_MS = 4000;
const SSE_FAILURE_LIMIT = 3;

const parseEvent = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

export const createLiveFeed = ({
  onSnapshot,
  onAdded,
  onRemoved,
  onStatus = () => {},
}) => {
  let source = null;
  let pollTimer = null;
  let failures = 0;
  let mode = 'idle';

  const poll = async () => {
    try {
      const response = await fetch('/api/answers', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onStatus('polling');
      onSnapshot(await response.json());
    } catch {
      onStatus('offline');
    }
  };

  const startPolling = () => {
    if (mode === 'polling') return;
    mode = 'polling';

    if (source) {
      source.close();
      source = null;
    }

    onStatus('polling');
    poll();
    pollTimer = window.setInterval(poll, POLL_MS);
  };

  const startSse = () => {
    if (typeof window.EventSource !== 'function') {
      startPolling();
      return;
    }

    mode = 'sse';
    source = new EventSource('/api/stream');

    const healthy = () => {
      failures = 0;
      onStatus('live');
    };

    source.addEventListener('open', healthy);

    source.addEventListener('snapshot', (event) => {
      const data = parseEvent(event);
      if (!data) return;
      healthy();
      onSnapshot(data);
    });

    source.addEventListener('added', (event) => {
      const data = parseEvent(event);
      if (!data) return;
      healthy();
      onAdded(data);
    });

    source.addEventListener('removed', (event) => {
      const data = parseEvent(event);
      if (!data) return;
      healthy();
      onRemoved(data);
    });

    source.addEventListener('error', () => {
      // readyState CLOSED means EventSource has given up (e.g. the server
      // refused the connection) and will not retry on its own.
      if (source && source.readyState === EventSource.CLOSED) {
        startPolling();
        return;
      }

      failures += 1;
      if (failures >= SSE_FAILURE_LIMIT) {
        startPolling();
        return;
      }
      onStatus('connecting');
    });
  };

  return {
    start: startSse,
    stop: () => {
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (source) {
        source.close();
        source = null;
      }
      mode = 'idle';
    },
  };
};
