import { createLiveFeed } from './live.js';

/** Bright accents; all comfortably above 4.5:1 on the near-black wall. */
const PALETTE = [
  '#7fd1ff',
  '#9ef0c8',
  '#ffd88a',
  '#ff9fb2',
  '#c3b4ff',
  '#8ff0e4',
  '#ffc2ef',
];

const PLACE_ATTEMPTS = 260;
const CYCLE_MS = 12_000;
const MAX_ROTATION_DEG = 5;
const RECENT_PROTECTED = 6;

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => motionQuery.matches;

/**
 * Deterministic 0..1 from a string (FNV-1a). Using the entry id means an
 * answer keeps the same size, colour and tilt across relayouts, so the wall
 * feels stable rather than reshuffling randomly.
 */
const hash01 = (value, salt = 0) => {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

class Zone {
  constructor(section) {
    this.section = section;
    this.question = section.dataset.question;
    this.scatter = section.querySelector('[data-role="scatter"]');
    this.emptyEl = section.querySelector('[data-role="empty"]');

    this.entries = []; // oldest first
    this.byId = new Map();
    this.placed = new Map(); // id -> { el, box }
    this.overflow = []; // ids with no room right now
    this.scale = 1;
    this.relayoutTimer = null;
  }

  /* --------------------------------------------------------- sizing */

  /** Area-based: halving the type size roughly quadruples what fits. */
  scaleFor(count) {
    return clamp(Math.sqrt(14 / Math.max(count, 1)), 0.4, 1);
  }

  fontSizeRem(entry, scale) {
    const [min, max] = this.question === 'q1' ? [2.0, 4.8] : [1.15, 2.3];
    const size = (min + (max - min) * hash01(entry.id, 7)) * scale;
    // Never shrink below readable-from-the-back; cycling handles the rest.
    return Math.max(this.question === 'q1' ? 1.05 : 0.92, size);
  }

  /* -------------------------------------------------------- elements */

  createElement(entry, scale) {
    const el = document.createElement('p');
    el.className = 'item is-measuring';
    el.setAttribute('role', 'listitem');
    el.dataset.id = entry.id;

    // textContent, never innerHTML — this is audience-submitted text.
    el.textContent = entry.text;

    el.style.fontSize = `${this.fontSizeRem(entry, scale).toFixed(3)}rem`;
    el.style.setProperty(
      '--accent',
      PALETTE[Math.floor(hash01(entry.id, 13) * PALETTE.length) % PALETTE.length],
    );

    const rotation = reducedMotion() ? 0 : (hash01(entry.id, 29) * 2 - 1) * MAX_ROTATION_DEG;
    el.style.setProperty('--rot', `${rotation.toFixed(2)}deg`);
    el.dataset.rot = String(rotation);

    return el;
  }

  /** Axis-aligned bounds of the rotated element. */
  measure(el) {
    const radians = (Math.abs(Number(el.dataset.rot) || 0) * Math.PI) / 180;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    return {
      w: width * Math.cos(radians) + height * Math.sin(radians),
      h: width * Math.sin(radians) + height * Math.cos(radians),
      naturalWidth: width,
      naturalHeight: height,
    };
  }

  collides(x, y, box, pad) {
    for (const { box: other } of this.placed.values()) {
      if (
        x < other.x + other.w + pad &&
        x + box.w + pad > other.x &&
        y < other.y + other.h + pad &&
        y + box.h + pad > other.y
      ) {
        return true;
      }
    }
    return false;
  }

  /** Spiral out from the centre so the result reads as a cloud, not confetti. */
  findSpot(box, pad) {
    const zoneWidth = this.scatter.clientWidth;
    const zoneHeight = this.scatter.clientHeight;
    if (box.w > zoneWidth || box.h > zoneHeight) return null;

    const centreX = zoneWidth / 2;
    const centreY = zoneHeight / 2;
    const maxRadius = Math.max(zoneWidth, zoneHeight) * 0.6;

    for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt += 1) {
      const radius = (attempt / PLACE_ATTEMPTS) * maxRadius;
      const angle = Math.random() * Math.PI * 2;

      const x = clamp(centreX + Math.cos(angle) * radius - box.w / 2, 0, zoneWidth - box.w);
      // Squash vertically: the zones are wider than they are tall.
      const y = clamp(centreY + Math.sin(angle) * radius * 0.8 - box.h / 2, 0, zoneHeight - box.h);

      if (!this.collides(x, y, box, pad)) return { x, y, w: box.w, h: box.h };
    }
    return null;
  }

  place(entry, { isNew = false, delay = 0 } = {}) {
    if (this.placed.has(entry.id)) return true;

    const el = this.createElement(entry, this.scale);
    this.scatter.appendChild(el);

    const metrics = this.measure(el);
    const spot = this.findSpot(metrics, 12) ?? this.findSpot(metrics, 3);
    if (!spot) {
      el.remove();
      return false;
    }

    // offsetWidth/Height are unrotated, so centre them inside the rotated box.
    const left = spot.x + (spot.w - metrics.naturalWidth) / 2;
    const top = spot.y + (spot.h - metrics.naturalHeight) / 2;
    el.style.setProperty('--x', `${Math.round(left)}px`);
    el.style.setProperty('--y', `${Math.round(top)}px`);

    if (delay > 0) el.style.animationDelay = `${delay}ms`;
    el.classList.remove('is-measuring');
    el.classList.add(isNew ? 'is-new' : 'is-entering');

    this.placed.set(entry.id, { el, box: spot });
    return true;
  }

  /** Frees the slot immediately; the element fades out on its own. */
  unplace(id, keepForLater = false) {
    const record = this.placed.get(id);
    if (!record) return;

    this.placed.delete(id);
    record.el.classList.remove('is-entering', 'is-new');
    record.el.classList.add('is-leaving');
    window.setTimeout(() => record.el.remove(), 480);

    if (keepForLater && !this.overflow.includes(id)) this.overflow.push(id);
  }

  pickVictim() {
    const protectedIds = new Set(this.entries.slice(-RECENT_PROTECTED).map((entry) => entry.id));
    const candidates = [...this.placed.keys()].filter((id) => !protectedIds.has(id));
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  fillFromOverflow(limit) {
    let filled = 0;
    while (filled < limit && this.overflow.length > 0) {
      const id = this.overflow.shift();
      const entry = this.byId.get(id);
      if (!entry) continue;

      if (this.place(entry)) {
        filled += 1;
      } else {
        // Still no room — put it back and stop hammering the placer.
        this.overflow.push(id);
        break;
      }
    }
  }

  /* ------------------------------------------------------- mutations */

  add(entry) {
    if (this.byId.has(entry.id)) return;

    this.byId.set(entry.id, entry);
    this.entries.push(entry);

    // A new answer MUST be seen landing, so evict older items if we have to.
    let placed = this.place(entry, { isNew: true });
    let evictions = 0;
    while (!placed && evictions < 4) {
      const victim = this.pickVictim();
      if (!victim) break;
      this.unplace(victim, true);
      evictions += 1;
      placed = this.place(entry, { isNew: true });
    }
    if (!placed && !this.overflow.includes(entry.id)) this.overflow.push(entry.id);

    this.updateEmpty();
    this.scheduleRelayoutIfNeeded();
  }

  remove(id) {
    this.unplace(id);
    const queued = this.overflow.indexOf(id);
    if (queued >= 0) this.overflow.splice(queued, 1);

    this.byId.delete(id);
    this.entries = this.entries.filter((entry) => entry.id !== id);

    this.fillFromOverflow(1);
    this.updateEmpty();
  }

  setAll(entries) {
    this.entries = [...entries];
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.relayout({ stagger: true });
  }

  relayout({ stagger = false } = {}) {
    for (const { el } of this.placed.values()) el.remove();
    this.placed.clear();
    this.overflow = [];
    this.scale = this.scaleFor(this.entries.length);

    // Newest first so the freshest answers win the central spots.
    const ordered = [...this.entries].reverse();
    ordered.forEach((entry, index) => {
      const delay = stagger ? Math.min(index * 45, 1400) : 0;
      if (!this.place(entry, { delay })) this.overflow.push(entry.id);
    });

    this.updateEmpty();
  }

  /** Re-flow once the count has drifted far enough to change type size. */
  scheduleRelayoutIfNeeded() {
    if (this.relayoutTimer) return;
    if (Math.abs(this.scaleFor(this.entries.length) - this.scale) < 0.07) return;

    // Delay so the room sees the new answer land before the wall re-flows.
    this.relayoutTimer = window.setTimeout(() => {
      this.relayoutTimer = null;
      this.relayout();
    }, 1800);
  }

  /** Rotate overflow answers into view so nothing is hidden forever. */
  cycle() {
    if (this.overflow.length === 0) return;

    const swaps = Math.min(3, this.overflow.length);
    let freed = 0;
    for (let i = 0; i < swaps; i += 1) {
      const victim = this.pickVictim();
      if (!victim) break;
      this.unplace(victim, true);
      freed += 1;
    }
    this.fillFromOverflow(freed);
  }

  updateEmpty() {
    this.emptyEl.hidden = this.entries.length > 0;
  }
}

/* ------------------------------------------------------------- wiring */

const zones = new Map(
  [...document.querySelectorAll('.zone')].map((section) => [
    section.dataset.question,
    new Zone(section),
  ]),
);

const countEl = document.getElementById('count');
const dotEl = document.getElementById('live-dot');
const labelEl = document.getElementById('live-label');

const STATUS_TEXT = {
  live: 'Live',
  polling: 'Polling',
  connecting: 'Connecting',
  offline: 'Reconnecting',
};

const setStatus = (state) => {
  dotEl.dataset.state = state;
  labelEl.textContent = STATUS_TEXT[state] ?? state;
};

/** id -> question, so a removal knows which zone owns it. */
let known = new Map();
let initialised = false;

const setCount = (value) => {
  if (typeof value === 'number') countEl.textContent = String(value);
};

const addOne = (entry) => {
  const zone = zones.get(entry.question);
  if (!zone || known.has(entry.id)) return;
  known.set(entry.id, entry.question);
  zone.add(entry);
};

const removeOne = (id) => {
  const question = known.get(id);
  known.delete(id);
  zones.get(question)?.remove(id);
};

/**
 * Handles both the SSE snapshot and every polling response. After the first
 * load it reconciles deltas rather than rebuilding, so polling does not make
 * the wall flicker.
 */
const applySnapshot = ({ entries = [], count }) => {
  if (!initialised) {
    initialised = true;
    known = new Map(entries.map((entry) => [entry.id, entry.question]));
    for (const [question, zone] of zones) {
      zone.setAll(entries.filter((entry) => entry.question === question));
    }
    setCount(count ?? entries.length);
    return;
  }

  const incoming = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of [...known.keys()]) {
    if (!incoming.has(id)) removeOne(id);
  }
  for (const [id, entry] of incoming) {
    if (!known.has(id)) addOne(entry);
  }
  setCount(count ?? entries.length);
};

createLiveFeed({
  onSnapshot: applySnapshot,
  onAdded: ({ entries = [], count }) => {
    entries.forEach(addOne);
    setCount(count);
  },
  onRemoved: ({ ids = [], count }) => {
    ids.forEach(removeOne);
    setCount(count);
  },
  onStatus: setStatus,
}).start();

window.setInterval(() => {
  for (const zone of zones.values()) zone.cycle();
}, CYCLE_MS);

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    for (const zone of zones.values()) zone.relayout();
  }, 260);
});
