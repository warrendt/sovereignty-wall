import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '../src/lib/rate-limit.js';

/** Limiter with a clock we control, so nothing depends on wall time. */
const withClock = (options = {}) => {
  let current = 1_000_000;
  const limiter = createRateLimiter({
    max: 10,
    windowMs: 60_000,
    now: () => current,
    ...options,
  });
  return { limiter, advance: (ms) => { current += ms; }, at: () => current };
};

test('allows up to max requests inside the window', () => {
  const { limiter } = withClock();

  for (let i = 0; i < 10; i += 1) {
    assert.equal(limiter.consume('1.2.3.4').allowed, true, `request ${i + 1} should pass`);
  }
});

test('blocks the request after max is reached', () => {
  const { limiter } = withClock();
  for (let i = 0; i < 10; i += 1) limiter.consume('1.2.3.4');

  const blocked = limiter.consume('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0);
});

test('reports a shrinking remaining count', () => {
  const { limiter } = withClock({ max: 3 });
  assert.equal(limiter.consume('ip').remaining, 2);
  assert.equal(limiter.consume('ip').remaining, 1);
  assert.equal(limiter.consume('ip').remaining, 0);
});

test('limits are tracked per key', () => {
  const { limiter } = withClock({ max: 2 });

  limiter.consume('a');
  limiter.consume('a');
  assert.equal(limiter.consume('a').allowed, false);
  assert.equal(limiter.consume('b').allowed, true);
});

test('the window slides rather than resetting in fixed blocks', () => {
  const { limiter, advance } = withClock({ max: 2 });

  limiter.consume('ip'); // t=0
  advance(30_000);
  limiter.consume('ip'); // t=30s
  assert.equal(limiter.consume('ip').allowed, false);

  // t=61s: the first hit has aged out, the second has not.
  advance(31_000);
  assert.equal(limiter.consume('ip').allowed, true);
  assert.equal(limiter.consume('ip').allowed, false);
});

test('the key is fully released once the window passes', () => {
  const { limiter, advance } = withClock({ max: 2 });

  limiter.consume('ip');
  limiter.consume('ip');
  assert.equal(limiter.consume('ip').allowed, false);

  advance(60_001);
  assert.equal(limiter.consume('ip').allowed, true);
});

test('retryAfterMs counts down to when the oldest hit expires', () => {
  const { limiter, advance } = withClock({ max: 1 });

  limiter.consume('ip');
  advance(20_000);

  const blocked = limiter.consume('ip');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 40_000);
});

test('sweep drops expired keys so the map stays bounded', () => {
  const { limiter, advance } = withClock();

  limiter.consume('a');
  limiter.consume('b');
  assert.equal(limiter.size, 2);

  advance(60_001);
  limiter.sweep();
  assert.equal(limiter.size, 0);
});

test('missing or nullish keys are bucketed rather than crashing', () => {
  const { limiter } = withClock({ max: 1 });

  assert.equal(limiter.consume(undefined).allowed, true);
  assert.equal(limiter.consume(undefined).allowed, false);
});

test('invalid configuration is rejected up front', () => {
  assert.throws(() => createRateLimiter({ max: 0, windowMs: 1000 }), TypeError);
  assert.throws(() => createRateLimiter({ max: 5, windowMs: 0 }), TypeError);
});
