CREATE TABLE IF NOT EXISTS users (
  wallet_address TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL REFERENCES users(wallet_address),
  policy_hash TEXT NOT NULL,
  policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_address, policy_hash)
);

CREATE TABLE IF NOT EXISTS task_runs (
  run_id UUID PRIMARY KEY,
  wallet_address TEXT NOT NULL REFERENCES users(wallet_address),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('quoted','reserved','submitted','settled','rejected','failed','unknown')),
  response JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_address, idempotency_key)
);

CREATE TABLE IF NOT EXISTS payment_reservations (
  id UUID PRIMARY KEY,
  wallet_address TEXT NOT NULL REFERENCES users(wallet_address),
  day DATE NOT NULL,
  amount_tinybars BIGINT NOT NULL CHECK (amount_tinybars > 0),
  receiver_account_id TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  task_id UUID,
  status TEXT NOT NULL CHECK (status IN ('reserved','submitted','settled','rejected','failed','unknown','ambiguous')),
  transaction_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'settled' OR transaction_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payment_reservations_wallet_day_idx ON payment_reservations(wallet_address, day);
CREATE INDEX IF NOT EXISTS payment_reservations_task_idx ON payment_reservations(wallet_address, task_id);
CREATE INDEX IF NOT EXISTS payment_reservations_recovery_idx ON payment_reservations(status, updated_at)
  WHERE status IN ('reserved','submitted','unknown','ambiguous');

CREATE TABLE IF NOT EXISTS auth_challenges (
  kind TEXT NOT NULL CHECK (kind IN ('authorization','payment-approval')),
  nonce TEXT NOT NULL,
  wallet_address TEXT NOT NULL REFERENCES users(wallet_address),
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, nonce)
);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS auth_grants (
  kind TEXT NOT NULL CHECK (kind IN ('authorization','payment-approval')),
  token_hash TEXT NOT NULL,
  wallet_address TEXT NOT NULL REFERENCES users(wallet_address),
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, token_hash)
);
CREATE INDEX IF NOT EXISTS auth_grants_expiry_idx ON auth_grants(expires_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  wallet_address TEXT NOT NULL REFERENCES users(wallet_address),
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB,
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed','unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, key)
);

CREATE TABLE IF NOT EXISTS audit_metadata (
  id BIGSERIAL PRIMARY KEY,
  wallet_address TEXT,
  event_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_metadata_created_idx ON audit_metadata(created_at DESC);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_ledger_imports (
  source_path TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_spending_holds (
  source_path TEXT NOT NULL REFERENCES legacy_ledger_imports(source_path) DEFERRABLE INITIALLY DEFERRED,
  day DATE NOT NULL,
  reserved_tinybars BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tinybars >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (source_path, day)
);
CREATE INDEX IF NOT EXISTS legacy_spending_holds_day_idx ON legacy_spending_holds(day);
