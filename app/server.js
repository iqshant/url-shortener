const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");
const os = require("os");

const { pool, waitForDb } = require("./db");
const {
  client: redis,
  waitForRedis,
  CACHE_TTL_SECONDS,
  URL_CACHE_PREFIX,
  CLICK_BUFFER_PREFIX,
} = require("./redis");
const { Snowflake, toBase62 } = require("./snowflake");

const PORT = process.env.PORT || 3000;
const WORKER_ID = Number(process.env.WORKER_ID || 0);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:8080`;
const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;

const snowflake = new Snowflake(WORKER_ID);
const app = express();

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Trust the nginx reverse proxy in front of us so req.ip / X-Forwarded-For
// resolve to the real client, not the proxy's internal IP. Required for
// rate limiting and click logging to be meaningful behind a load balancer.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    // Prevent shortening URLs that point back at this service, which would
    // otherwise create infinite redirect loops.
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting: protects the write path from abuse. Each app instance
// enforces its own limit; since nginx round-robins requests, a client
// hammering the service spreads across instances, but each still caps
// individually as a defense-in-depth measure (a stricter shared limit could
// be added with a Redis store if needed).
// ---------------------------------------------------------------------------
const shortenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

// ---------------------------------------------------------------------------
// POST /api/shorten  { url, customAlias?, expiresInDays? }
// ---------------------------------------------------------------------------
app.post("/api/shorten", shortenLimiter, async (req, res) => {
  try {
    const { url, customAlias, expiresInDays } = req.body || {};

    if (typeof url !== "string" || !isValidUrl(url)) {
      return res.status(400).json({ error: "Provide a valid http(s) URL." });
    }

    let expiresAt = null;
    if (expiresInDays !== undefined) {
      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return res.status(400).json({ error: "expiresInDays must be a positive number (max 3650)." });
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    let shortCode;
    let isCustom = false;

    if (customAlias !== undefined) {
      if (typeof customAlias !== "string" || !ALIAS_REGEX.test(customAlias)) {
        return res.status(400).json({
          error: "customAlias must be 3-20 characters: letters, numbers, _ or -.",
        });
      }
      shortCode = customAlias;
      isCustom = true;
    }

    const id = snowflake.nextId();

    if (!shortCode) {
      shortCode = toBase62(id);
    }

    const clientIp = req.ip;

    try {
      const result = await pool.query(
        `INSERT INTO urls (id, short_code, long_url, is_custom_alias, expires_at, worker_id, created_by_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING short_code, created_at`,
        [id.toString(), shortCode, url, isCustom, expiresAt, WORKER_ID, clientIp]
      );

      const row = result.rows[0];

      // Warm the cache so the very first redirect is fast too.
      await redis.set(
        URL_CACHE_PREFIX + row.short_code,
        JSON.stringify({ longUrl: url, expiresAt }),
        { EX: CACHE_TTL_SECONDS }
      );

      return res.status(201).json({
        shortCode: row.short_code,
        shortUrl: `${PUBLIC_BASE_URL}/${row.short_code}`,
        longUrl: url,
        createdAt: row.created_at,
        expiresAt,
      });
    } catch (err) {
      if (err.code === "23505") {
        // unique_violation on short_code
        if (isCustom) {
          return res.status(409).json({ error: "That custom alias is already taken." });
        }
        // Astronomically unlikely for a snowflake id, but handle gracefully
        // rather than silently failing.
        return res.status(503).json({ error: "Short code collision, please retry." });
      }
      throw err;
    }
  } catch (err) {
    console.error("[POST /api/shorten] error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ---------------------------------------------------------------------------
// GET /:code  -> redirect to long URL (the hot path)
// ---------------------------------------------------------------------------
app.get("/:code", async (req, res, next) => {
  const { code } = req.params;

  // Skip anything that's obviously not a short code (e.g. favicon.ico) so
  // we don't pollute the cache / DB lookups with junk.
  if (!/^[a-zA-Z0-9_-]{1,16}$/.test(code)) return next();

  try {
    let longUrl;
    let expiresAt;

    const cached = await redis.get(URL_CACHE_PREFIX + code);
    if (cached) {
      const parsed = JSON.parse(cached);
      longUrl = parsed.longUrl;
      expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;
    } else {
      const result = await pool.query(
        "SELECT long_url, expires_at FROM urls WHERE short_code = $1",
        [code]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Short URL not found." });
      }
      longUrl = result.rows[0].long_url;
      expiresAt = result.rows[0].expires_at;

      await redis.set(
        URL_CACHE_PREFIX + code,
        JSON.stringify({ longUrl, expiresAt }),
        { EX: CACHE_TTL_SECONDS }
      );
    }

    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ error: "This short URL has expired." });
    }

    // Buffer the click in Redis (cheap, atomic) instead of writing to
    // Postgres on every single redirect. A background job periodically
    // flushes these counters in batches. This keeps the hot redirect path
    // fast and avoids hammering the database under load.
    redis.incr(CLICK_BUFFER_PREFIX + code).catch((err) => {
      console.error("[click buffer] failed to incr:", err);
    });

    return res.redirect(302, longUrl);
  } catch (err) {
    console.error("[GET /:code] error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stats/:code
// ---------------------------------------------------------------------------
app.get("/api/stats/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const result = await pool.query(
      "SELECT short_code, long_url, clicks, created_at, expires_at FROM urls WHERE short_code = $1",
      [code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Short URL not found." });
    }

    const row = result.rows[0];
    const pendingClicks = Number((await redis.get(CLICK_BUFFER_PREFIX + code)) || 0);

    return res.json({
      shortCode: row.short_code,
      longUrl: row.long_url,
      clicks: Number(row.clicks) + pendingClicks,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    console.error("[GET /api/stats/:code] error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ---------------------------------------------------------------------------
// GET /health  -> useful for verifying the load balancer is actually
// distributing traffic across distinct instances.
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    workerId: WORKER_ID,
    hostname: os.hostname(),
    pid: process.pid,
  });
});

// ---------------------------------------------------------------------------
// Background job: flush buffered click counts from Redis into Postgres.
// Using a Lua-free approach: GET the value, then DEL it, accepting the
// small race window (an in-flight increment between GET and DEL would be
// dropped) is an acceptable tradeoff for analytics counters. For a stricter
// guarantee, swap this for a Redis MULTI/EXEC or a Lua GETDEL+reset script.
// ---------------------------------------------------------------------------
async function flushClickBuffer() {
  try {
    let cursor = "0";
    const keys = [];
    do {
      const reply = await redis.scan(cursor, { MATCH: CLICK_BUFFER_PREFIX + "*", COUNT: 100 });
      cursor = reply.cursor;
      keys.push(...reply.keys);
    } while (cursor !== "0");

    if (keys.length === 0) return;

    for (const key of keys) {
      const code = key.slice(CLICK_BUFFER_PREFIX.length);
      const countStr = await redis.getDel(key);
      const count = Number(countStr || 0);
      if (count > 0) {
        await pool.query("UPDATE urls SET clicks = clicks + $1 WHERE short_code = $2", [
          count,
          code,
        ]);
      }
    }
  } catch (err) {
    console.error("[flushClickBuffer] error:", err);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  await waitForDb();
  await waitForRedis();

  const flushIntervalMs = 5000;
  const flushTimer = setInterval(flushClickBuffer, flushIntervalMs);

  const server = app.listen(PORT, () => {
    console.log(`[server] worker ${WORKER_ID} listening on port ${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down gracefully...`);
    clearInterval(flushTimer);
    await flushClickBuffer();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
