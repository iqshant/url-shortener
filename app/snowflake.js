/**
 * Snowflake-style unique ID generator.
 *
 * Why this exists: in a distributed URL shortener, multiple app instances
 * generate short codes concurrently. If we used a simple auto-increment
 * counter or Math.random(), we'd risk collisions across nodes. Snowflake IDs
 * solve this WITHOUT any coordination between nodes by combining:
 *
 *   [ 41 bits timestamp (ms) ][ 10 bits worker id ][ 12 bits sequence ]
 *
 * - timestamp: milliseconds since a custom epoch -> IDs are roughly sortable
 *   by creation time and won't repeat across time.
 * - worker id: unique per app instance (0-1023), set via WORKER_ID env var.
 *   Different instances can NEVER produce the same ID because they own a
 *   disjoint worker id namespace.
 * - sequence: a per-millisecond counter (0-4095) on a single worker, so even
 *   if the same worker generates >1 id in the same millisecond, IDs stay
 *   unique.
 *
 * Total capacity: up to 4096 IDs per millisecond per worker, across up to
 * 1024 workers, for ~69 years from EPOCH before the timestamp bits overflow.
 */

const EPOCH = 1735689600000; // 2025-01-01T00:00:00Z, custom epoch to keep numbers small

const WORKER_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;

const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n; // 1023
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n; // 4095

const WORKER_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS;

class Snowflake {
  constructor(workerId) {
    const id = BigInt(workerId);
    if (id < 0n || id > MAX_WORKER_ID) {
      throw new Error(`WORKER_ID must be between 0 and ${MAX_WORKER_ID}, got ${workerId}`);
    }
    this.workerId = id;
    this.sequence = 0n;
    this.lastTimestamp = -1n;
  }

  _now() {
    return BigInt(Date.now());
  }

  _waitNextMillis(lastTimestamp) {
    let timestamp = this._now();
    while (timestamp <= lastTimestamp) {
      timestamp = this._now();
    }
    return timestamp;
  }

  nextId() {
    let timestamp = this._now();

    if (timestamp < this.lastTimestamp) {
      // Clock moved backwards (e.g. NTP adjustment). Refuse to generate an
      // id that could collide with one already issued, rather than risk a
      // silent collision.
      throw new Error(
        `Clock moved backwards. Refusing to generate id for ${this.lastTimestamp - timestamp}ms`
      );
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // Sequence exhausted for this millisecond, spin until the clock ticks.
        timestamp = this._waitNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      ((timestamp - BigInt(EPOCH)) << TIMESTAMP_SHIFT) |
      (this.workerId << WORKER_ID_SHIFT) |
      this.sequence;

    return id;
  }
}

// --- Base62 encoding -------------------------------------------------------
// Used to turn the (large) numeric snowflake id into a short, URL-safe code.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = BigInt(ALPHABET.length);

function toBase62(num) {
  if (num === 0n) return ALPHABET[0];
  let n = num;
  let out = "";
  while (n > 0n) {
    const rem = n % BASE;
    out = ALPHABET[Number(rem)] + out;
    n = n / BASE;
  }
  return out;
}

function fromBase62(str) {
  let n = 0n;
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base62 character: ${ch}`);
    n = n * BASE + BigInt(idx);
  }
  return n;
}

module.exports = { Snowflake, toBase62, fromBase62 };
