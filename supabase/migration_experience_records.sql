-- =============================================================================
-- Migration: Create public.experience_records table
-- Purpose: Required for Experience Memory Engine persistence
-- =============================================================================

BEGIN;

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
  completed_at BIGINT NOT NULL,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Performance & Query Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_experience_records_completed_at ON public.experience_records(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_experience_records_combination_key ON public.experience_records(combination_key);
CREATE INDEX IF NOT EXISTS idx_experience_records_signal_id ON public.experience_records(signal_id);
CREATE INDEX IF NOT EXISTS idx_experience_records_setup_family ON public.experience_records(setup_family);

-- Security: Enable Row-Level Security
ALTER TABLE public.experience_records ENABLE ROW LEVEL SECURITY;

-- Revoke all access from untrusted client roles
REVOKE ALL ON TABLE public.experience_records FROM anon, authenticated;

-- Permissions: Grant access exclusively to service_role
GRANT ALL ON TABLE public.experience_records TO service_role;

COMMIT;
