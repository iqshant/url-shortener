# Distributed URL Shortener

A horizontally-scalable URL shortener. Multiple stateless app instances sit
behind an nginx load balancer; Postgres is the durable store; Redis caches
hot lookups and buffers click counts.

```
                    ┌──────────┐
   client  ───────▶ │  nginx   │  (load balancer, port 8080)
                    └────┬─────┘
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          ┌──────┐   ┌──────┐   ┌──────┐
          │ app1 │   │ app2 │   │ app3 │   (stateless Node/Express)
          │ wid=1│   │ wid=2│   │ wid=3│
          └───┬──┘   └───┬──┘   └───┬──┘
              └──────────┼──────────┘
                  ┌───────┴───────┐
                  ▼               ▼
             ┌─────────┐    ┌──────────┐
             │  Redis  │    │ Postgres │
             │ cache + │    │  source  │
             │ click   │    │  of      │
             │ buffer  │    │  truth   │
             └─────────┘    └──────────┘
```

## How distribution actually works (not just "3 containers")

1. **Collision-free ID generation without coordination.** Each app instance
   has a unique `WORKER_ID` baked into every short code it mints, via a
   Snowflake-style ID (`timestamp | worker_id | sequence`, see
   `app/snowflake.js`). No instance needs to ask another "has this code been
   used?" before issuing one — the worker_id bits make collisions between
   instances structurally impossible. This is the same idea Twitter/Discord
   use for distributed ID generation.

2. **Stateless app instances.** `app1`/`app2`/`app3` hold no in-memory state
   about which URLs exist. Any instance can serve any request. This is what
   lets nginx round-robin (well, `least_conn`) freely and lets you add a 4th,
   5th, Nth instance by just bumping `WORKER_ID` and adding it to
   `nginx.conf`.

3. **Redis as a shared cache + write buffer.** Hot redirects hit Redis, not
   Postgres, on cache hits. Click counts are buffered in Redis
   (`INCR clicks:<code>`) and flushed to Postgres in batches every 5s
   instead of writing on every single redirect — this is the standard
   pattern for keeping a hot read/write path fast under load.

4. **Postgres as the single source of truth.** Simple, consistent, and fine
   at this scale with proper indexing. For very large scale you'd shard by
   short_code hash or move to a partitioned table — noted below.

## Quick start

```bash
docker compose up --build
```

Then open **http://localhost:8080**.

- `POST /api/shorten` — body `{ "url": "...", "customAlias": "optional", "expiresInDays": optional }`
- `GET /:code` — redirects (302) to the long URL
- `GET /api/stats/:code` — `{ shortCode, longUrl, clicks, createdAt, expiresAt }`
- `GET /health` — `{ workerId, hostname, pid }`, useful to confirm load balancing is actually spreading requests:

```bash
for i in {1..6}; do curl -s http://localhost:8080/health; echo; done
```

You should see different `workerId`/`hostname` values rotate across calls.

## Verifying correctness yourself

```bash
# Create a short link
curl -X POST http://localhost:8080/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://anthropic.com/research"}'
# => {"shortCode":"...","shortUrl":"http://localhost:8080/...", ...}

# Follow it
curl -i http://localhost:8080/<shortCode>   # expect 302 Location: https://anthropic.com/research

# Check stats (clicks should increment after the redirect's been flushed, ~5s)
curl http://localhost:8080/api/stats/<shortCode>
```

Edge cases handled and worth poking at:
- Re-requesting the same `customAlias` → `409 Conflict`.
- Invalid URL / missing protocol → `400`.
- Expired link (`expiresInDays`) → `410 Gone` after expiry.
- Hitting `POST /api/shorten` >30 times/min from one IP → `429`.
- Unknown short code → `404`.

## Project layout

```
url-shortener/
├── docker-compose.yml      # postgres, redis, 3x app, nginx
├── nginx.conf               # least_conn load balancer
├── .env.example
└── app/
    ├── server.js            # Express app: routes + background flush job
    ├── snowflake.js          # distributed ID generation + base62 encode
    ├── db.js                 # Postgres pool
    ├── redis.js               # Redis client + key prefixes
    ├── init.sql                # schema, auto-run on first postgres boot
    ├── package.json
    ├── Dockerfile
    └── public/index.html        # minimal test UI
```

## Scaling beyond this setup

- **Add more instances:** bump `WORKER_ID` (0–1023 available) and add the
  service to `nginx.conf`'s upstream block. No code changes needed.
- **Postgres becomes the bottleneck first.** Options in order of effort:
  read replicas for `GET /api/stats`, then partitioning `urls` by
  `short_code` hash, then a managed distributed SQL store (CockroachDB,
  YugabyteDB) if write volume genuinely requires it.
- **Redis becomes a single point of failure** in this minimal setup. For
  production, run Redis in Sentinel or Cluster mode rather than a single
  container.
- **Rate limiting is per-instance** here (each app enforces its own 30/min).
  For a global limit shared across all instances, swap `express-rate-limit`'s
  default memory store for `rate-limit-redis`.

## Known tradeoffs (so you know what you're getting)

- Click counts have a small possible undercount window: if a click is
  buffered in Redis but the process crashes before the next flush, that
  click is lost. Acceptable for analytics; not used for billing-grade
  counts.
- The click flush is GET-then-DEL, not a single atomic operation — a click
  arriving in that exact race window could be dropped. A Lua script
  (`GETDEL` with reset) would close this gap if exact counts matter.
- Postgres is a single instance here for simplicity. It's the one part of
  this stack that isn't yet horizontally distributed — see "Scaling beyond
  this setup" above.
