CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY,
  alibaba_account TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS license_events (
  id UUID PRIMARY KEY,
  license_id UUID REFERENCES licenses(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS client_logins (
  id UUID PRIMARY KEY,
  alibaba_account TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(alibaba_account, device_id)
);

ALTER TABLE licenses ADD COLUMN IF NOT EXISTS allow_multi_device BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS active_device_id TEXT;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Existing installations migrate per account; newly created accounts require a code.
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS credential_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS credential_hash TEXT;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS credential_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS offline_grace_minutes INTEGER NOT NULL DEFAULT 1440;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='licenses_offline_grace_minutes_check' AND conrelid='licenses'::regclass) THEN
    ALTER TABLE licenses DROP CONSTRAINT licenses_offline_grace_minutes_check;
    UPDATE licenses SET offline_grace_minutes=1440 WHERE offline_grace_minutes=5
      AND NOT EXISTS (SELECT 1 FROM license_events e WHERE e.license_id=licenses.id AND e.action='connection');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='licenses_connection_grace_days_check' AND conrelid='licenses'::regclass) THEN
    ALTER TABLE licenses ADD CONSTRAINT licenses_connection_grace_days_check CHECK (offline_grace_minutes BETWEEN 1 AND 21600);
  END IF;
END $$;
ALTER TABLE licenses ALTER COLUMN offline_grace_minutes SET DEFAULT 1440;
CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  password_fingerprint TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_alibaba_account_key;
CREATE UNIQUE INDEX IF NOT EXISTS licenses_current_account ON licenses(alibaba_account) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notice','popup')),
  status TEXT NOT NULL CHECK (status IN ('draft','published','withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1,
  author TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_published ON announcements(status, published_at DESC);
