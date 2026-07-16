-- 007_sessions.sql — DB-backed session store (spec 11 §8 debt, folded into
-- Phase 10.0: "DB-backed session store before multi-worker uvicorn").
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Replaces the Phase 1 in-process session dict so sessions survive a restart
-- and are shared across uvicorn workers. Only a SHA-256 hex digest of the
-- opaque cookie token is stored — the token itself is never at rest, so a DB
-- read (backup, dump, injection) cannot yield a usable session cookie.
-- Expiry is enforced in code (compare in Python, portable across MariaDB and
-- the SQLite test DB); expired rows are purged opportunistically on login.
--
-- rollback: (sessions are ephemeral credentials — dropping the table just
--  signs everyone out; nothing to export)
--   DROP TABLE IF EXISTS sessions;
--   DELETE FROM schema_migrations WHERE version='007';

CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64)     NOT NULL,              -- sha256(cookie token), hex
    username   VARCHAR(128) NOT NULL,
    role       VARCHAR(16)  NOT NULL,              -- viewer | operator | admin
    groups_json TEXT        NOT NULL,              -- JSON array of group ids
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP    NOT NULL,
    PRIMARY KEY (token_hash),
    KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
