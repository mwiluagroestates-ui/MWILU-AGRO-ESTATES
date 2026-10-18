-- Mwilu Agro Estate – PostgreSQL schema (safe to re-run; never drops data)
CREATE TABLE IF NOT EXISTS collections (
  key        text PRIMARY KEY,
  version    integer NOT NULL DEFAULT 1,
  data       jsonb   NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
CREATE TABLE IF NOT EXISTS collection_history (
  id bigserial PRIMARY KEY, key text NOT NULL, version integer NOT NULL,
  data jsonb NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(), saved_by text
);
CREATE INDEX IF NOT EXISTS ch_key_ver ON collection_history(key, version DESC);
CREATE TABLE IF NOT EXISTS credentials (username text PRIMARY KEY, pin_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS ops (op_id text PRIMARY KEY, result jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now());
