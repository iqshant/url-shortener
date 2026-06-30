CREATE TABLE IF NOT EXISTS urls (
    id              BIGINT PRIMARY KEY,
    short_code      VARCHAR(16) UNIQUE NOT NULL,
    long_url        TEXT NOT NULL,
    is_custom_alias BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    clicks          BIGINT NOT NULL DEFAULT 0,
    worker_id       INT,
    created_by_ip   VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls (short_code);
CREATE INDEX IF NOT EXISTS idx_urls_expires_at ON urls (expires_at) WHERE expires_at IS NOT NULL;
