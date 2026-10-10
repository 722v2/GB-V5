import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  isSupabaseConfigured,
  getSupabaseStatus,
  getSupabaseDiagnostics,
  recordSupabaseSuccess,
  recordSupabaseError,
  setSupabaseClientForTesting,
  resetSupabaseStateForTesting,
  executeSupabaseQuery,
} from '../server/supabase.js';
import { storage } from '../server/storage.js';

async function runSupabasePersistenceTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 SUPABASE SCHEMA & PERSISTENCE READINESS REGRESSION SUITE');
  console.log('========================================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: SQL Schema Contract & Table Inventory Verification
  // --------------------------------------------------------------------------
  console.log('TEST 1: Schema contract verification against actual application tables');
  const schemaPath = path.join(process.cwd(), 'supabase', 'schema.sql');
  assert.ok(fs.existsSync(schemaPath), 'supabase/schema.sql must exist');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  const requiredTables = [
    'app_settings',
    'account_state',
    'trade_ledger',
    'trade_outcomes',
    'signals',
    'scans',
    'opportunities',
    'telegram_config',
    'candidate_lifecycles',
    'poi_records',
    'terminal_setups',
    'experience_records',
  ];

  for (const table of requiredTables) {
    const tableRegex = new RegExp(`CREATE TABLE IF NOT EXISTS (?:public\\.)?${table}\\b`, 'i');
    assert.ok(tableRegex.test(schemaSql), `Schema must declare table: ${table}`);
  }
  console.log(`✅ [PASS] TEST 1: All ${requiredTables.length} application tables declared in supabase/schema.sql.\n`);

  // --------------------------------------------------------------------------
  // TEST 2: Primary Keys & Upsert Conflict Key Alignment
  // --------------------------------------------------------------------------
  console.log('TEST 2: Verify primary keys and conflict target alignment');
  // trade_outcomes uses signal_id as primary key
  assert.ok(
    /CREATE TABLE IF NOT EXISTS (?:public\.)?trade_outcomes\s*\(\s*signal_id TEXT PRIMARY KEY/i.test(schemaSql),
    'trade_outcomes primary key must be signal_id'
  );
  // All other entities use id TEXT PRIMARY KEY
  for (const table of requiredTables.filter((t) => t !== 'trade_outcomes')) {
    const pkRegex = new RegExp(`CREATE TABLE IF NOT EXISTS (?:public\\.)?${table}\\s*\\(\\s*id TEXT PRIMARY KEY`, 'i');
    assert.ok(pkRegex.test(schemaSql), `${table} primary key must be id`);
  }
  console.log('✅ [PASS] TEST 2: All tables have explicit primary keys matching application upsert targets.\n');

  // --------------------------------------------------------------------------
  // TEST 3: RLS and Security Model in SQL Schema
  // --------------------------------------------------------------------------
  console.log('TEST 3: Verify RLS is enabled on all tables with untrusted access revoked');
  for (const table of requiredTables) {
    const rlsRegex = new RegExp(`ALTER TABLE (?:public\\.)?${table} ENABLE ROW LEVEL SECURITY;`, 'i');
    assert.ok(rlsRegex.test(schemaSql), `RLS must be enabled on table ${table}`);
  }
  assert.ok(
    /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;/i.test(schemaSql),
    'Public/anon access must be revoked in schema.sql'
  );
  assert.ok(
    /GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;/i.test(schemaSql),
    'service_role must be granted table access'
  );
  console.log('✅ [PASS] TEST 3: RLS and backend-only service_role grants verified.\n');

  // --------------------------------------------------------------------------
  // TEST 4: Baseline Balance Seeding Does Not Overwrite Existing Data
  // --------------------------------------------------------------------------
  console.log('TEST 4: Account state baseline seeding safety (ON CONFLICT DO NOTHING)');
  assert.ok(
    /INSERT INTO (?:public\.)?account_state/i.test(schemaSql) &&
    /ON CONFLICT\s*\(id\)\s*DO NOTHING/i.test(schemaSql),
    'account_state seeding must use ON CONFLICT (id) DO NOTHING'
  );
  console.log('✅ [PASS] TEST 4: Account baseline seeding is idempotent and cannot overwrite existing data.\n');

  // --------------------------------------------------------------------------
  // TEST 5: Standalone Migration Consistency
  // --------------------------------------------------------------------------
  console.log('TEST 5: Verify migration_experience_records.sql consistency');
  const migrationPath = path.join(process.cwd(), 'supabase', 'migration_experience_records.sql');
  assert.ok(fs.existsSync(migrationPath), 'migration_experience_records.sql must exist');
  const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  assert.ok(/CREATE TABLE IF NOT EXISTS public\.experience_records/i.test(migrationSql));
  assert.ok(/ALTER TABLE public\.experience_records ENABLE ROW LEVEL SECURITY;/i.test(migrationSql));
  assert.ok(/REVOKE ALL ON TABLE public\.experience_records FROM anon, authenticated;/i.test(migrationSql));
  assert.ok(/GRANT ALL ON TABLE public\.experience_records TO service_role;/i.test(migrationSql));
  console.log('✅ [PASS] TEST 5: Standalone migration file matches security and schema requirements.\n');

  // --------------------------------------------------------------------------
  // TEST 6: Unconfigured Environment Behavior (Local Fallback & Degraded Status)
  // --------------------------------------------------------------------------
  console.log('TEST 6: Behavior when Supabase credentials are absent (Mocked unconfigured)');
  resetSupabaseStateForTesting();
  setSupabaseClientForTesting(null, 'NOT_CONFIGURED');

  assert.strictEqual(getSupabaseStatus(), 'NOT_CONFIGURED', 'Status must be NOT_CONFIGURED when credentials absent');
  const unconfiguredStats = storage.getStats();
  assert.strictEqual(unconfiguredStats.durablePersistence, false, 'Persistence must not be durable when unconfigured');
  assert.strictEqual(unconfiguredStats.persistenceMode, 'LOCAL_FALLBACK', 'Must be in LOCAL_FALLBACK mode');
  assert.strictEqual(unconfiguredStats.supabaseStatus, 'NOT_CONFIGURED');
  assert.ok(unconfiguredStats.persistenceWarning?.includes('DEPLOYMENT BLOCKER'), 'Must report deployment blocker warning');
  console.log('✅ [PASS] TEST 6: Accurately reports NOT_CONFIGURED and LOCAL_FALLBACK with deployment blocker.\n');

  // --------------------------------------------------------------------------
  // TEST 7: Query Failure / Network Error Handling (Mocked Degraded)
  // --------------------------------------------------------------------------
  console.log('TEST 7: Handling failed connectivity/queries (Mocked error simulation)');
  const mockFailingClient = {
    from: (_table: string) => ({
      select: () => Promise.resolve({ data: null, error: { message: 'Network connection refused (ECONNREFUSED)' } }),
      upsert: () => Promise.resolve({ data: null, error: { message: 'Database query timeout' } }),
    }),
  } as any;

  setSupabaseClientForTesting(mockFailingClient, 'INITIALIZING');
  
  // Execute a query that fails
  const queryResult = await executeSupabaseQuery((c) => c.from('account_state').select('*'), 'test:query_fail');
  assert.ok(queryResult === null || queryResult.error, 'Failed query must return error or null in backoff');
  assert.strictEqual(getSupabaseStatus(), 'DEGRADED', 'Status must transition to DEGRADED on failure');

  const degradedStats = storage.getStats();
  assert.strictEqual(degradedStats.durablePersistence, false, 'Persistence must be false when DEGRADED');
  assert.strictEqual(degradedStats.persistenceMode, 'LOCAL_FALLBACK', 'Must report LOCAL_FALLBACK when queries fail');
  assert.strictEqual(degradedStats.supabaseStatus, 'DEGRADED');
  console.log('✅ [PASS] TEST 7: Failed queries correctly transition to DEGRADED without crashing.\n');

  // --------------------------------------------------------------------------
  // TEST 8: Successful Database Operations (Mocked Connectivity Verification)
  // --------------------------------------------------------------------------
  console.log('TEST 8: Verified database operations transition to CONNECTED (Mocked success)');
  const mockWorkingClient = {
    from: (_table: string) => ({
      select: () => Promise.resolve({ data: [{ id: 'main', current_balance: 91.0 }], error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
      delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  } as any;

  setSupabaseClientForTesting(mockWorkingClient, 'INITIALIZING');
  assert.strictEqual(getSupabaseStatus(), 'INITIALIZING', 'Must NOT be CONNECTED prior to verified query');

  // Execute successful query
  const successResult = await executeSupabaseQuery((c) => c.from('app_settings').select('*'), 'test:query_success');
  assert.ok(successResult && !successResult.error, 'Successful query must succeed');
  assert.strictEqual(getSupabaseStatus(), 'CONNECTED', 'Status must transition to CONNECTED only after verified query');

  const connectedStats = storage.getStats();
  assert.strictEqual(connectedStats.durablePersistence, true, 'durablePersistence must be true when CONNECTED');
  assert.strictEqual(connectedStats.persistenceMode, 'DURABLE_SUPABASE', 'persistenceMode must be DURABLE_SUPABASE');
  assert.strictEqual(connectedStats.supabaseStatus, 'CONNECTED');
  assert.strictEqual(connectedStats.persistenceWarning, undefined, 'No warning when healthy');
  console.log('✅ [PASS] TEST 8: Verified query transitions state to CONNECTED and DURABLE_SUPABASE.\n');

  // Clean up test state
  resetSupabaseStateForTesting();

  // --------------------------------------------------------------------------
  // TEST 9: Row Formatter & Parser Precision
  // --------------------------------------------------------------------------
  console.log('TEST 9: Row formatter and parser numerical fidelity');
  const sampleTrade: any = {
    id: 'test_tr_123',
    tradeNumber: 42,
    date: '2026-10-10',
    isoTime: '2026-10-10T12:00:00.000Z',
    asset: 'XAU/USD',
    direction: 'BUY',
    entry: 2650.5,
    sl: 2645.0,
    slPoints: 55.0,
    tp1: 2660.0,
    tp1Points: 95.0,
    tp2: 2670.0,
    tp2Points: 195.0,
    rr: '1:1.7',
    riskPercent: 15,
    riskAmount: 13.65,
    lotSize: 0.02,
    confidence: 80,
    setup: 'GB-V5 Break & Retest',
    result: 'WIN',
    isActive: false,
    pl: 19.0,
    realizedPnl: 19.0,
    balanceAfterTrade: 110.0,
    closedAt: 1791620000000,
    brokerDealId: 'deal_998877',
    brokerOrderId: 'ord_112233',
  };

  const formattedRow = (storage as any).formatTradeRow(sampleTrade);
  assert.strictEqual(formattedRow.id, sampleTrade.id);
  assert.strictEqual(formattedRow.broker_deal_id, 'deal_998877');
  assert.strictEqual(formattedRow.closed_at, 1791620000000);
  assert.strictEqual(formattedRow.realized_pnl, 19.0);
  assert.ok(formattedRow.raw_data, 'raw_data JSONB must be populated');

  const parsedBack = (storage as any).parseTradeRow(formattedRow);
  assert.strictEqual(parsedBack.id, sampleTrade.id);
  assert.strictEqual(parsedBack.brokerDealId, sampleTrade.brokerDealId);
  assert.strictEqual(parsedBack.realizedPnl, sampleTrade.realizedPnl);
  console.log('✅ [PASS] TEST 9: Row formatter and parser faithfully serialize and deserialize trade data.\n');

  console.log('========================================================================');
  console.log('🎉 ALL 9 SUPABASE SCHEMA & PERSISTENCE REGRESSION TESTS PASSED (9/9)!');
  console.log('========================================================================\n');
}

runSupabasePersistenceTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
