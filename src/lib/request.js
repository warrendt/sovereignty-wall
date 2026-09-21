/** Hostnames we are willing to echo back into a generated URL. */
const SAFE_HOST = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/;

const firstHeaderValue = (value) => {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  if (typeof value !== 'string') return '';
  const [first] = value.split(',');
  return (first ?? '').trim();
};

/**
 * Strip a trailing port from an address, handling bracketed IPv6.
 * "1.2.3.4:5678" -> "1.2.3.4", "[::1]:5678" -> "::1", "::1" -> "::1"
 */
const stripPort = (value) => {
  const address = value.trim();
  if (address === '') return '';

  if (address.startsWith('[')) {
    const end = address.indexOf(']');
    return end > 0 ? address.slice(1, end) : '';
  }

  // A bare IPv6 address has several colons; only a single colon means host:port.
  const colonCount = (address.match(/:/g) ?? []).length;
  if (colonCount === 1) return address.slice(0, address.indexOf(':'));
  return address;
};

/**
 * Best-effort client IP for rate limiting.
 *
 * We deliberately do NOT use `req.ip` with `trust proxy: true`, because that
 * returns the LEFT-most X-Forwarded-For entry, which the client supplies and
 * can therefore forge to bypass the limiter. Each proxy *appends* to the
 * header, so the RIGHT-most entry is the one written by the closest trusted
 * proxy (App Service's front end) and is the one worth trusting.
 */
export const clientIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;

  if (typeof raw === 'string' && raw.trim() !== '') {
    const parts = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const closest = parts.at(-1);
    if (closest) {
      const address = stripPort(closest);
      if (address !== '') return address;
    }
  }

  return req.socket?.remoteAddress ?? 'unknown';
};

/**
 * Absolute origin for this request, derived at runtime so the QR code works
 * unchanged on localhost and on Azure.
 *
 * The Host header is client-controllable, so we only echo it back when it
 * matches a strict hostname pattern.
 */
export const publicBaseUrl = (req, fallbackPort = 3000) => {
  const host =
    firstHeaderValue(req.headers?.['x-forwarded-host']) || firstHeaderValue(req.headers?.host);
  const safeHost = SAFE_HOST.test(host) ? host : `localhost:${fallbackPort}`;

  const forwardedProto = firstHeaderValue(req.headers?.['x-forwarded-proto']).toLowerCase();
  const protocol =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : req.socket?.encrypted
        ? 'https'
        : 'http';

  return `${protocol}://${safeHost}`;
};

/** Host[:port] only — used for the short "go here" label on the wall. */
export const displayHost = (baseUrl) => String(baseUrl).replace(/^https?:\/\//, '');
