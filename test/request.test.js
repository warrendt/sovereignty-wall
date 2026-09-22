import test from 'node:test';
import assert from 'node:assert/strict';

import { clientIp, publicBaseUrl, displayHost } from '../src/lib/request.js';

const fakeRequest = ({ headers = {}, socket = {} } = {}) => ({
  headers,
  socket: { remoteAddress: '127.0.0.1', ...socket },
});

/* -------------------------------------------------------------- clientIp */

test('falls back to the socket address with no proxy header', () => {
  assert.equal(clientIp(fakeRequest({ socket: { remoteAddress: '10.0.0.7' } })), '10.0.0.7');
});

test('uses the right-most X-Forwarded-For entry', () => {
  // The right-most entry is the one appended by the closest trusted proxy.
  // Anything to its left came from the client and is forgeable.
  const req = fakeRequest({ headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.5' } });
  assert.equal(clientIp(req), '203.0.113.5');
});

test('a spoofed X-Forwarded-For prefix cannot change the resolved IP', () => {
  const honest = fakeRequest({ headers: { 'x-forwarded-for': '203.0.113.5' } });
  const spoofed = fakeRequest({
    headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.5' },
  });

  // Both resolve to the same bucket, so the attacker gains no extra quota.
  assert.equal(clientIp(spoofed), clientIp(honest));
});

test('strips the port App Service appends to the forwarded address', () => {
  const req = fakeRequest({ headers: { 'x-forwarded-for': '203.0.113.5:49812' } });
  assert.equal(clientIp(req), '203.0.113.5');
});

test('handles bracketed IPv6 with a port', () => {
  const req = fakeRequest({ headers: { 'x-forwarded-for': '[2001:db8::1]:443' } });
  assert.equal(clientIp(req), '2001:db8::1');
});

test('leaves a bare IPv6 address intact', () => {
  const req = fakeRequest({ headers: { 'x-forwarded-for': '2001:db8::1' } });
  assert.equal(clientIp(req), '2001:db8::1');
});

test('ignores an empty or whitespace-only forwarded header', () => {
  const req = fakeRequest({
    headers: { 'x-forwarded-for': '  ,  ' },
    socket: { remoteAddress: '10.0.0.7' },
  });
  assert.equal(clientIp(req), '10.0.0.7');
});

test('never returns undefined', () => {
  assert.equal(clientIp({ headers: {}, socket: {} }), 'unknown');
});

/* --------------------------------------------------------- publicBaseUrl */

test('builds the origin from the Host header', () => {
  const req = fakeRequest({ headers: { host: 'localhost:3000' } });
  assert.equal(publicBaseUrl(req), 'http://localhost:3000');
});

test('honours X-Forwarded-Proto so a proxied request yields https', () => {
  const req = fakeRequest({
    headers: { host: 'wall.example.com', 'x-forwarded-proto': 'https' },
  });
  assert.equal(publicBaseUrl(req), 'https://wall.example.com');
});

test('prefers X-Forwarded-Host over Host', () => {
  const req = fakeRequest({
    headers: { host: 'internal:8080', 'x-forwarded-host': 'wall.example.com' },
  });
  assert.equal(publicBaseUrl(req), 'http://wall.example.com');
});

test('takes only the first entry of a comma-joined forwarded header', () => {
  const req = fakeRequest({
    headers: { 'x-forwarded-host': 'wall.example.com, evil.example.net' },
  });
  assert.equal(publicBaseUrl(req), 'http://wall.example.com');
});

test('rejects a malicious Host and falls back to localhost', () => {
  // The Host header is client-controlled, so we only echo it back when it
  // looks like a plain hostname.
  for (const host of ['evil.com/"><script>', 'evil.com?x=1', 'a b c', 'evil.com#frag']) {
    const req = fakeRequest({ headers: { host } });
    assert.equal(publicBaseUrl(req, 3000), 'http://localhost:3000', `host: ${host}`);
  }
});

test('ignores a bogus X-Forwarded-Proto value', () => {
  const req = fakeRequest({
    headers: { host: 'wall.example.com', 'x-forwarded-proto': 'javascript' },
  });
  assert.equal(publicBaseUrl(req), 'http://wall.example.com');
});

test('detects https from an encrypted socket', () => {
  const req = fakeRequest({ headers: { host: 'wall.example.com' }, socket: { encrypted: true } });
  assert.equal(publicBaseUrl(req), 'https://wall.example.com');
});

/* ------------------------------------------------------------ displayHost */

test('displayHost drops the scheme', () => {
  assert.equal(displayHost('https://wall.example.com'), 'wall.example.com');
  assert.equal(displayHost('http://localhost:3000'), 'localhost:3000');
});
