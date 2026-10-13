import assert from 'assert';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { storage, PersistentStorage } from '../server/storage.js';
import { runAccountingTests } from '../server/accountingTests.js';
import { runTradeManagementTests } from '../server/tradeManagementTests.js';

function getFileHash(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

async function runStorageIsolationRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PHASE 4 STORAGE ISOLATION & HARD SAFETY GUARD REGRESSION TESTS');
  console.log('========================================================================\n');

  await storage.waitUntilReady();

  // 0. Capture Pre-Test File Hashes for Telegram Queue and Dispatches
  const queuePath = 'data/telegram_retry_queue.json';
  const dispatchPath = 'data/telegram_dispatches.json';
  const initialQueueHash = getFileHash(queuePath);
  const initialDispatchHash = getFileHash(dispatchPath);

  // 1. Capture Production Storage Snapshot BEFORE running tests
  const initialTrades = [...storage.getTrades(300)];
  const initialOutcomes = [...storage.getTradeOutcomes(500)];
  const initialCurrentBalance = storage.getCurrentBalance();
  const initialStartingBalance = storage.getStartingBalance();
  const initialDispatches = [...storage.getTelegramDispatches()];
  const initialSettingsJSON = JSON.stringify(storage.getSettings());
  const initialSignals = [...storage.getSignals(100)];
  const initialScans = [...storage.getScans(100)];
  const initialPois = [...storage.getPois()];
  const initialLifecycles = [...storage.getLifecycles()];
  const initialOpportunities = [...storage.getOpportunities()];
  const initialTerminalSetups = [...storage.getTerminalSetups()];
  const initialFactorSnapshots = { ...storage.getFactorSnapshots() };
  const initialExperienceRecords = [...storage.getCompletedExperienceRecords()];

  console.log(`[Production Storage Snapshot BEFORE Tests]`);
  console.log(`  • Trades count: ${initialTrades.length}`);
  console.log(`  • Outcomes count: ${initialOutcomes.length}`);
  console.log(`  • Current Balance: $${initialCurrentBalance}`);
  console.log(`  • Starting Balance: $${initialStartingBalance}`);
  console.log(`  • Telegram Dispatches: ${initialDispatches.length}`);
  console.log(`  • Signals count: ${initialSignals.length}`);
  console.log(`  • Scans count: ${initialScans.length}`);
  console.log(`  • POIs count: ${initialPois.length}`);
  console.log(`  • Lifecycles count: ${initialLifecycles.length}`);
  console.log(`  • Opportunities count: ${initialOpportunities.length}`);
  console.log(`  • Terminal Setups count: ${initialTerminalSetups.length}`);
  console.log(`  • Factor Snapshots count: ${Object.keys(initialFactorSnapshots).length}`);
  console.log(`  • Experience Records count: ${initialExperienceRecords.length}\n`);

  // Setup Fetch Interception Guard with explicit integer attempt counter
  const originalFetch = globalThis.fetch;
  let telegramFetchAttemptCount = 0;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      telegramFetchAttemptCount++;
      throw new Error('Test Isolation Violation: Outbound Telegram network call attempted');
    }
    return originalFetch(input, init);
  };

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Run Accounting Tests against Isolated Storage Instance
    // --------------------------------------------------------------------------
    console.log('TEST 1: Run Accounting Test Suite against Isolated Test Storage Instance');
    const accountingReport = runAccountingTests();
    if (!accountingReport.allPassed) {
      console.error('Accounting Report Failures:', accountingReport.results.filter(r => !r.passed));
    }
    assert.strictEqual(accountingReport.allPassed, true, 'All 14 accounting tests must pass on isolated storage');
    assert.strictEqual(accountingReport.results.length, 14, 'Must execute all 14 accounting tests');
    console.log('✅ [PASS] TEST 1: Accounting tests executed cleanly against isolated storage (14/14 passed).\n');

    // --------------------------------------------------------------------------
    // TEST 2: Run Trade Management Tests against Isolated Storage Instance
    // --------------------------------------------------------------------------
    console.log('TEST 2: Run Trade Management Test Suite against Isolated Test Storage Instance');
    const tmReport = await runTradeManagementTests();
    if (!tmReport.allPassed) {
      console.error('Trade Management Report Failures:', tmReport.results.filter(r => !r.passed));
    }
    assert.strictEqual(tmReport.allPassed, true, 'All 18 trade management tests must pass on isolated storage');
    assert.strictEqual(tmReport.results.length, 18, 'Must execute all 18 trade management tests');
    console.log('✅ [PASS] TEST 2: Trade management tests executed cleanly against isolated storage (18/18 passed).\n');

    // --------------------------------------------------------------------------
    // TEST 3: Repeated Execution Isolation (Run 3x repeatedly to prove idempotency)
    // --------------------------------------------------------------------------
    console.log('TEST 3: Repeated test suite execution against fresh isolated instances');
    for (let i = 1; i <= 3; i++) {
      const accRep = runAccountingTests();
      assert.strictEqual(accRep.allPassed, true, `Run ${i}: Accounting tests must pass`);
      const tmRep = await runTradeManagementTests();
      assert.strictEqual(tmRep.allPassed, true, `Run ${i}: Trade management tests must pass`);
    }
    console.log('✅ [PASS] TEST 3: Repeated test executions remain 100% isolated and idempotent.\n');

  } finally {
    globalThis.fetch = originalFetch;
  }

  // Log observed count and assert zero outbound Telegram fetch attempts
  console.log(`[Isolation Audit] Observed Telegram fetch request-attempt count: ${telegramFetchAttemptCount}`);
  assert.strictEqual(telegramFetchAttemptCount, 0, 'Zero outbound fetch calls to telegram.org must be made during test execution');

  // Assert file hashes remain byte-for-byte unchanged
  const finalQueueHash = getFileHash(queuePath);
  const finalDispatchHash = getFileHash(dispatchPath);
  assert.strictEqual(finalQueueHash, initialQueueHash, 'telegram_retry_queue.json must remain byte-for-byte unchanged');
  assert.strictEqual(finalDispatchHash, initialDispatchHash, 'telegram_dispatches.json must remain byte-for-byte unchanged');
  console.log('✅ [PASS] Telegram queue and dispatch files remain byte-for-byte immutable (SHA-256 match).\n');

  // --------------------------------------------------------------------------
  // TEST 4: Production Storage State Equality Verification (Before vs After)
  // --------------------------------------------------------------------------
  console.log('TEST 4: Production Storage State Before vs After Equality Verification (13 Storage Categories)');
  const finalTrades = [...storage.getTrades(300)];
  const finalOutcomes = [...storage.getTradeOutcomes(500)];
  const finalCurrentBalance = storage.getCurrentBalance();
  const finalStartingBalance = storage.getStartingBalance();
  const finalDispatches = [...storage.getTelegramDispatches()];
  const finalSettingsJSON = JSON.stringify(storage.getSettings());
  const finalSignals = [...storage.getSignals(100)];
  const finalScans = [...storage.getScans(100)];
  const finalPois = [...storage.getPois()];
  const finalLifecycles = [...storage.getLifecycles()];
  const finalOpportunities = [...storage.getOpportunities()];
  const finalTerminalSetups = [...storage.getTerminalSetups()];
  const finalFactorSnapshots = { ...storage.getFactorSnapshots() };
  const finalExperienceRecords = [...storage.getCompletedExperienceRecords()];

  assert.strictEqual(finalTrades.length, initialTrades.length, 'Trades count in production storage must remain unchanged');
  assert.deepStrictEqual(finalTrades, initialTrades, 'Trades in production storage must remain strictly equal');

  assert.strictEqual(finalOutcomes.length, initialOutcomes.length, 'Outcomes count in production storage must remain unchanged');
  assert.deepStrictEqual(finalOutcomes, initialOutcomes, 'Outcomes in production storage must remain strictly equal');

  assert.strictEqual(finalCurrentBalance, initialCurrentBalance, 'Current balance in production storage must remain unchanged');
  assert.strictEqual(finalStartingBalance, initialStartingBalance, 'Starting balance in production storage must remain unchanged');

  assert.strictEqual(finalDispatches.length, initialDispatches.length, 'Telegram dispatches count in production storage must remain unchanged');
  assert.deepStrictEqual(finalDispatches, initialDispatches, 'Telegram dispatches in production storage must remain strictly equal');

  assert.strictEqual(finalSettingsJSON, initialSettingsJSON, 'Settings in production storage must remain unchanged');

  assert.strictEqual(finalSignals.length, initialSignals.length, 'Signals count in production storage must remain unchanged');
  assert.deepStrictEqual(finalSignals, initialSignals, 'Signals in production storage must remain strictly equal');

  assert.strictEqual(finalScans.length, initialScans.length, 'Scans count in production storage must remain unchanged');
  assert.deepStrictEqual(finalScans, initialScans, 'Scans in production storage must remain strictly equal');

  assert.strictEqual(finalPois.length, initialPois.length, 'POIs count in production storage must remain unchanged');
  assert.deepStrictEqual(finalPois, initialPois, 'POIs in production storage must remain strictly equal');

  assert.strictEqual(finalLifecycles.length, initialLifecycles.length, 'Lifecycles count in production storage must remain unchanged');
  assert.deepStrictEqual(finalLifecycles, initialLifecycles, 'Lifecycles in production storage must remain strictly equal');

  assert.strictEqual(finalOpportunities.length, initialOpportunities.length, 'Opportunities count in production storage must remain unchanged');
  assert.deepStrictEqual(finalOpportunities, initialOpportunities, 'Opportunities in production storage must remain strictly equal');

  assert.strictEqual(finalTerminalSetups.length, initialTerminalSetups.length, 'Terminal setups count in production storage must remain unchanged');
  assert.deepStrictEqual(finalTerminalSetups, initialTerminalSetups, 'Terminal setups in production storage must remain strictly equal');

  assert.strictEqual(Object.keys(finalFactorSnapshots).length, Object.keys(initialFactorSnapshots).length, 'Factor snapshots count in production storage must remain unchanged');
  assert.deepStrictEqual(finalFactorSnapshots, initialFactorSnapshots, 'Factor snapshots in production storage must remain strictly equal');

  assert.strictEqual(finalExperienceRecords.length, initialExperienceRecords.length, 'Experience records count in production storage must remain unchanged');
  assert.deepStrictEqual(finalExperienceRecords, initialExperienceRecords, 'Experience records in production storage must remain strictly equal');

  console.log(`[Production Storage Snapshot AFTER Tests]`);
  console.log(`  • Trades count: ${finalTrades.length} (Unchanged)`);
  console.log(`  • Outcomes count: ${finalOutcomes.length} (Unchanged)`);
  console.log(`  • Current Balance: $${finalCurrentBalance} (Unchanged)`);
  console.log(`  • Starting Balance: $${finalStartingBalance} (Unchanged)`);
  console.log(`  • Telegram Dispatches: ${finalDispatches.length} (Unchanged)`);
  console.log(`  • Signals count: ${finalSignals.length} (Unchanged)`);
  console.log(`  • Scans count: ${finalScans.length} (Unchanged)`);
  console.log(`  • POIs count: ${finalPois.length} (Unchanged)`);
  console.log(`  • Lifecycles count: ${finalLifecycles.length} (Unchanged)`);
  console.log(`  • Opportunities count: ${finalOpportunities.length} (Unchanged)`);
  console.log(`  • Terminal Setups count: ${finalTerminalSetups.length} (Unchanged)`);
  console.log(`  • Factor Snapshots count: ${Object.keys(finalFactorSnapshots).length} (Unchanged)`);
  console.log(`  • Experience Records count: ${finalExperienceRecords.length} (Unchanged)`);
  console.log('✅ [PASS] TEST 4: Production storage singleton state across all 13 categories remains 100% untouched and equal.\n');

  // --------------------------------------------------------------------------
  // TEST 5: Hard Safety Guard Verification (Fails Closed on Production Storage)
  // --------------------------------------------------------------------------
  console.log('TEST 5: Hard Safety Guard Verification (Refuses destructive test operations on production storage)');
  
  // 5.1 setTestingMode on production storage
  assert.throws(
    () => {
      storage.setTestingMode(true);
    },
    (err: any) => err?.message?.includes('HARD SAFETY GUARD TRIGGERED'),
    'setTestingMode() on production storage must throw HARD SAFETY GUARD Error'
  );

  // 5.2 clearAllTrades on production storage
  let resetErrorThrown = false;
  try {
    await storage.clearAllTrades();
  } catch (err: any) {
    if (err?.message?.includes('HARD SAFETY GUARD TRIGGERED')) {
      resetErrorThrown = true;
    } else {
      throw err;
    }
  }
  assert.strictEqual(resetErrorThrown, true, 'clearAllTrades() on production storage must throw HARD SAFETY GUARD Error');

  console.log('✅ [PASS] TEST 5: Hard Safety Guard successfully blocks destructive operations on production storage.\n');

  // --------------------------------------------------------------------------
  // TEST 6: Isolated Storage Instance Mutation Isolation
  // --------------------------------------------------------------------------
  console.log('TEST 6: Isolated Storage Instance Mutation Isolation Verification');
  const isolatedInst = PersistentStorage.createIsolatedTestInstance(500.0);
  assert.strictEqual(isolatedInst.isProductionStorage, false, 'Isolated instance isProductionStorage must be false');
  assert.strictEqual(isolatedInst.isTestingMode(), true, 'Isolated instance isTestingMode must be true');

  // Perform destructive mutation on isolated instance
  isolatedInst.saveTrade({
    id: 'test-isolation-trade-001',
    tradeNumber: 1,
    date: 'Today',
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 2500,
    sl: 2490,
    tp1: 2510,
    tp2: 2520,
    rr: '1:2',
    riskPercent: 1.0,
    riskAmount: 5.0,
    lotSize: 0.01,
    confidence: 85,
    setup: 'Isolation Test',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: 500.0,
  });

  assert.strictEqual(isolatedInst.getTrades().length, 1, 'Isolated instance has 1 trade');
  assert.strictEqual(storage.getTrades(300).length, initialTrades.length, 'Production storage singleton trade count remains unchanged');

  await isolatedInst.clearAllTrades();
  assert.strictEqual(isolatedInst.getTrades().length, 0, 'Isolated instance clearAllTrades succeeds');
  assert.strictEqual(storage.getTrades(300).length, initialTrades.length, 'Production storage singleton remains untouched after clearAllTrades on isolated instance');

  console.log('✅ [PASS] TEST 6: Isolated test storage mutations remain 100% contained in isolated instance.\n');

  console.log('========================================================================');
  console.log('🎉 ALL 6 STORAGE ISOLATION & SAFETY REGRESSION TESTS PASSED (6/6)');
  console.log('========================================================================\n');
}

runStorageIsolationRegressionTests().catch((err) => {
  console.error('❌ Storage Isolation Regression Test Failed:', err);
  process.exit(1);
});
