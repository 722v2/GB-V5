-- =============================================================================
-- Supabase PostgreSQL Database Schema
-- Scalping Trade Automation & Persistence Layer (GB-V5)
-- =============================================================================

BEGIN;

-- 1. App Settings Table
CREATE TABLE IF NOT EXISTS public.app_settings (
  id TEXT PRIMARY KEY DEFAULT 'main',
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 2. Account Balance State Table (Canonical GB-V5 account baseline tracking)
CREATE TABLE IF NOT EXISTS public.account_state (
  id TEXT PRIMARY KEY DEFAULT 'main',
  starting_balance NUMERIC(12, 2) NOT NULL DEFAULT 25.00,
  current_balance NUMERIC(12, 2) NOT NULL DEFAULT 25.00,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Trade Ledger Table
CREATE TABLE IF NOT EXISTS public.trade_ledger (
  id TEXT PRIMARY KEY,
  trade_number INTEGER,
  date TEXT,
  iso_time TEXT,
  asset TEXT DEFAULT 'XAU/USD',
  direction TEXT,
  entry NUMERIC(12, 2),
  sl NUMERIC(12, 2),
  sl_points NUMERIC(12, 2),
  tp1 NUMERIC(12, 2),
  tp1_points NUMERIC(12, 2),
  tp2 NUMERIC(12, 2),
  tp2_points NUMERIC(12, 2),
  rr TEXT,
  risk_percent NUMERIC(8, 2),
  risk_amount NUMERIC(12, 2),
  lot_size NUMERIC(8, 4) DEFAULT 0.01,
  confidence NUMERIC(8, 2),
  setup TEXT,
  result TEXT,
  is_active BOOLEAN DEFAULT FALSE,
  pl NUMERIC(12, 2) DEFAULT 0,
  realized_pnl NUMERIC(12, 2) DEFAULT 0,
  balance_after_trade NUMERIC(12, 2),
  exit_price NUMERIC(12, 2),
  exit_time TEXT,
  closed_at BIGINT, -- Epoch milliseconds
  close_reason TEXT,
  source TEXT DEFAULT 'MANUAL',
  broker_deal_id TEXT,
  broker_order_id TEXT,
  theoretical_tp1_profit NUMERIC(12, 2),
  theoretical_tp2_profit NUMERIC(12, 2),
  notes TEXT,
  signal_id TEXT,
  setup_id TEXT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_ledger_trade_number ON public.trade_ledger(trade_number DESC);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_result ON public.trade_ledger(result);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_is_active ON public.trade_ledger(is_active);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_closed_at ON public.trade_ledger(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_broker_deal_id ON public.trade_ledger(broker_deal_id);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_signal_id ON public.trade_ledger(signal_id);

-- 4. Trade Outcomes Table (Telegram, Manual & Broker Resolutions)
CREATE TABLE IF NOT EXISTS public.trade_outcomes (
  signal_id TEXT PRIMARY KEY,
  trade_id TEXT,
  direction TEXT,
  order_type TEXT,
  entry NUMERIC(12, 2),
  stop_loss NUMERIC(12, 2),
  tp1 NUMERIC(12, 2),
  tp2 NUMERIC(12, 2),
  outcome TEXT,
  timestamp BIGINT, -- Epoch milliseconds
  iso_time TEXT,
  chat_id TEXT,
  user_id TEXT,
  pl NUMERIC(12, 2),
  realized_pnl NUMERIC(12, 2),
  exit_price NUMERIC(12, 2),
  source TEXT,
  broker_deal_id TEXT,
  broker_order_id TEXT,
  closed_at BIGINT, -- Epoch milliseconds
  close_reason TEXT,
  notes TEXT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_outcomes_timestamp ON public.trade_outcomes(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_outcome ON public.trade_outcomes(outcome);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_trade_id ON public.trade_outcomes(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_broker_deal_id ON public.trade_outcomes(broker_deal_id);

-- 5. Signals Table
CREATE TABLE IF NOT EXISTS public.signals (
  id TEXT PRIMARY KEY,
  timestamp BIGINT, -- Epoch milliseconds
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON public.signals(timestamp DESC);

-- 6. Scans Table
CREATE TABLE IF NOT EXISTS public.scans (
  id TEXT PRIMARY KEY,
  timestamp BIGINT, -- Epoch milliseconds
  status TEXT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON public.scans(timestamp DESC);

-- 7. Opportunities Table
CREATE TABLE IF NOT EXISTS public.opportunities (
  id TEXT PRIMARY KEY,
  last_updated_time BIGINT, -- Epoch milliseconds
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunities_last_updated ON public.opportunities(last_updated_time DESC);

-- 8. Telegram Bot Configuration
CREATE TABLE IF NOT EXISTS public.telegram_config (
  id TEXT PRIMARY KEY DEFAULT 'main',
  chat_id TEXT NOT NULL,
  registered_at TEXT,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 9. Candidate Lifecycles
CREATE TABLE IF NOT EXISTS public.candidate_lifecycles (
  id TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 10. POI Records
CREATE TABLE IF NOT EXISTS public.poi_records (
  id TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 11. Terminal Setups (Cooldown & Invalidation Dedup)
CREATE TABLE IF NOT EXISTS public.terminal_setups (
  id TEXT PRIMARY KEY,
  setup_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminal_setups_key ON public.terminal_setups(setup_key);

-- 12. Experience Records Table (Experience Memory Engine)
CREATE TABLE IF NOT EXISTS public.experience_records (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  trade_id TEXT,
  combination_key TEXT NOT NULL,
  factors JSONB NOT NULL,
  direction TEXT NOT NULL,
  setup_family TEXT NOT NULL,
  outcome TEXT NOT NULL,
  realized_pnl NUMERIC(12, 2) NOT NULL DEFAULT 0,
  rr NUMERIC(8, 2),
  completed_at BIGINT NOT NULL, -- Epoch milliseconds
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experience_records_completed_at ON public.experience_records(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_experience_records_combination_key ON public.experience_records(combination_key);
CREATE INDEX IF NOT EXISTS idx_experience_records_signal_id ON public.experience_records(signal_id);
CREATE INDEX IF NOT EXISTS idx_experience_records_setup_family ON public.experience_records(setup_family);

-- Seed Account State with canonical baseline starting balance ONLY if no record exists yet.
-- ON CONFLICT (id) DO NOTHING ensures existing balance is NEVER overwritten.
-- When the application connects, initSupabaseData() synchronizes the live/configured account state.
INSERT INTO public.account_state (id, starting_balance, current_balance, updated_at)
VALUES ('main', 25.00, 25.00, NOW())
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Security, Permissions & Row-Level Security (RLS) Configuration
-- =============================================================================

-- Enable Row-Level Security (RLS) on all persistent tables
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poi_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminal_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experience_records ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all access from untrusted client roles (anon, authenticated).
-- Public PostgREST API access is completely blocked.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Grant full schema and table privileges exclusively to the backend service_role.
-- Note: The service_role key has the PostgreSQL BYPASSRLS attribute,
-- allowing the trusted server backend full read/write access.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Ensure any future tables also default to service_role-only access
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

COMMIT;


