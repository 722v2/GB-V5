/**
 * Comprehensive Test Suite for Trading Experience / Feedback Memory Engine
 */

import fs from 'fs';
import path from 'path';
import { storage, PersistentStorage } from '../server/storage.js';
import {
  experienceMemoryEngine,
  MIN_SAMPLE_SIZE,
  MIN_SIMILARITY,
  NormalizedFactors,
  FactorSnapshot,
} from '../server/experienceMemory.js';
import { TradeSignal, TechnicalIndicators } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 TRADING EXPERIENCE / FEEDBACK MEMORY TEST SUITE');
  console.log('====================================================');

  const testStoragePath = path.join(process.cwd(), 'data', 'test_experience_memory.json');
  if (fs.existsSync(testStoragePath)) { try { fs.unlinkSync(testStoragePath); } catch {} }
  const testStorage = new PersistentStorage({ isIsolatedTest: true, storageFilePath: testStoragePath });
  experienceMemoryEngine.resetIndexForTesting();

  const mockInd1h: Partial<TechnicalIndicators> = {
    structure: 'BULLISH',
    ema20: 2400,
    ema50: 2380,
    rsi14: 55,
  };

  const mockInd15m: Partial<TechnicalIndicators> = {
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    liquiditySweepDetected: true,
    orderBlock: { type: 'BULLISH', high: 2410, low: 2405 },
    fvg: { type: 'BULLISH', top: 2415, bottom: 2410 },
    premiumDiscountZone: 'DISCOUNT',
  };

  const mockInd5m: Partial<TechnicalIndicators> = {
    rsi14: 52,
    macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
    atr14: 1.4,
  };

  // -------------------------------------------------------------
  // TEST 1: Factor snapshot capture & price independence
  // -------------------------------------------------------------
  console.log('\n--- 1. Factor Snapshot Capture & Categorical Normalization ---');
  const mockSignal1: TradeSignal = {
    id: 'test_sig_exp_001',
    timestamp: 1700000000000,
    asset: 'XAU/USD',
    signal: 'BUY NOW',
    currentPrice: 2410.5,
    entry: 2410.5,
    stopLoss: 2405.5,
    slPoints: 50,
    tp1: 2418.0,
    tp1Points: 75,
    tp2: 2425.5,
    tp2Points: 150,
    rr: '1:1.5',
    rrRatio: 1.5,
    riskPercent: 15,
    riskAmount: 1.5,
    potentialProfit: 2.25,
    potentialLoss: 1.5,
    recommendedLotSize: 0.01,
    confidence: 85,
    timeframe: '15M',
    setup: 'S1_TREND_CONTINUATION',
    strategyFamily: 'S1_TREND_CONTINUATION',
    mainReasons: ['Bullish order block test'],
    invalidation: 'Break below 2405',
  };

  const snapshot1 = experienceMemoryEngine.captureDecisionSnapshot(
    mockSignal1,
    mockInd1h as any,
    mockInd15m as any,
    mockInd5m as any,
    testStorage
  );

  assert(snapshot1 !== null, '1.1 Decision snapshot successfully captured');
  assert(snapshot1?.signalId === 'test_sig_exp_001', '1.2 Snapshot linked to correct signalId');
  assert(snapshot1?.direction === 'BUY', '1.3 Direction normalized to BUY');
  assert(snapshot1?.factors.htfStructure === 'UPTREND', '1.4 HTF structure mapped to UPTREND');
  assert(snapshot1?.factors.liquidity === 'SWEEP_SELL_SIDE', '1.5 Sweep mapped to SWEEP_SELL_SIDE for BUY');

  // Verify that NO price properties exist in combinationKey
  const key = snapshot1?.combinationKey || '';
  assert(!key.includes('2410.5'), '1.6 combinationKey excludes entry price');
  assert(!key.includes('2405.5'), '1.7 combinationKey excludes stopLoss price');
  assert(!key.includes('2418.0'), '1.8 combinationKey excludes tp1 price');
  assert(!key.includes('entry='), '1.9 combinationKey has no entry field');
  assert(!key.includes('stopLoss='), '1.10 combinationKey has no stopLoss field');

  // Verify snapshot stored in storage
  const storedSnapshot = testStorage.getFactorSnapshot('test_sig_exp_001');
  assert(storedSnapshot?.combinationKey === key, '1.11 Snapshot persisted and retrievable via storage');

  // -------------------------------------------------------------
  // TEST 2: Price Independence Verification
  // -------------------------------------------------------------
  console.log('\n--- 2. Price Independence Verification ---');
  // Create a second signal with totally different prices (e.g. gold at 2700 vs 2400) but identical categorical factors
  const mockSignalDifferentPrice: TradeSignal = {
    ...mockSignal1,
    id: 'test_sig_exp_002',
    currentPrice: 2750.0,
    entry: 2750.0,
    stopLoss: 2745.0,
    tp1: 2760.0,
    tp2: 2775.0,
  };

  const snapshot2 = experienceMemoryEngine.captureDecisionSnapshot(
    mockSignalDifferentPrice,
    mockInd1h as any,
    mockInd15m as any,
    mockInd5m as any,
    testStorage
  );

  assert(
    snapshot1?.combinationKey === snapshot2?.combinationKey,
    '2.1 Identical categorical factors with radically different prices yield IDENTICAL combinationKey'
  );

  // Changing one categorical factor yields a different key
  const mockInd15mRanging = { ...mockInd15m, marketRegime: 'NORMAL_RANGE' };
  const snapshotDifferentFactor = experienceMemoryEngine.captureDecisionSnapshot(
    mockSignalDifferentPrice,
    mockInd1h as any,
    mockInd15mRanging as any,
    mockInd5m as any,
    testStorage
  );
  assert(
    snapshot1?.combinationKey !== snapshotDifferentFactor?.combinationKey,
    '2.2 Changing a categorical factor yields a DIFFERENT combinationKey'
  );

  // -------------------------------------------------------------
  // TEST 3: Outcome Linking (WIN & LOSS)
  // -------------------------------------------------------------
  console.log('\n--- 3. Outcome Linking ---');
  // Linking a WIN
  const winRecord = experienceMemoryEngine.recordCompletedOutcome(
    snapshot1,
    {
      signalId: 'test_sig_exp_001',
      outcome: 'WIN',
      realizedPnl: 2.35,
      timestamp: 1700000050000,
      closedAt: 1700000050000,
    },
    undefined,
    testStorage
  );
  assert(winRecord !== null, '3.1 WIN outcome successfully linked to snapshot');
  assert(winRecord?.outcome === 'WIN', '3.2 Record reflects WIN outcome');
  assert(winRecord?.realizedPnl === 2.35, '3.3 Record reflects realized P&L');
  assert(winRecord?.combinationKey === key, '3.4 Record has canonical combinationKey');

  // -------------------------------------------------------------
  // TEST 4: No snapshot (Unmatched / Manual trades)
  // -------------------------------------------------------------
  console.log('\n--- 4. Unmatched / Manual Trades Protection ---');
  const unlinkedRecord = experienceMemoryEngine.recordCompletedOutcome(
    null,
    {
      signalId: 'manual_trade_without_snapshot',
      outcome: 'WIN',
      realizedPnl: 5.0,
      timestamp: 1700000060000,
    },
    undefined,
    testStorage
  );
  assert(unlinkedRecord === null, '4.1 Trade without snapshot is silently skipped (no record fabricated)');

  // -------------------------------------------------------------
  // TEST 5: Minimum Sample Size & Statistical Thresholds
  // -------------------------------------------------------------
  console.log('\n--- 5. Minimum Sample Size & Statistics ---');
  // Currently we only have 1 record in the index (winRecord).
  // With sampleSize = 1 < MIN_SAMPLE_SIZE (6), getExperienceContext MUST return null.
  const contextUnderSample = experienceMemoryEngine.getExperienceContext(snapshot1!, 1700000100000, testStorage);
  assert(
    contextUnderSample === null,
    `5.1 Sample size 1 (< MIN_SAMPLE_SIZE ${MIN_SAMPLE_SIZE}) returns null (no premature advice)`
  );

  // Seed 6 more completed outcomes with the same combinationKey (total 7 records)
  for (let i = 2; i <= 7; i++) {
    const sId = `test_sig_exp_seed_${i}`;
    const snap: FactorSnapshot = {
      signalId: sId,
      setupFamily: snapshot1!.setupFamily,
      direction: snapshot1!.direction,
      factors: snapshot1!.factors,
      combinationKey: key,
      createdAt: 1700000000000 + i * 1000,
    };
    testStorage.saveFactorSnapshot(snap);
    experienceMemoryEngine.recordCompletedOutcome(
      snap,
      {
        signalId: sId,
        outcome: i <= 6 ? 'WIN' : 'LOSS', // 6 wins total, 1 loss total
        realizedPnl: i <= 6 ? 2.5 : -1.5,
        timestamp: 1700000050000 + i * 1000,
        closedAt: 1700000050000 + i * 1000,
      },
      undefined,
      testStorage
    );
  }

  // Now we have 7 records completed at <= 1700000057000.
  // Query at T = 1700000090000 (after completion).
  const contextSufficient = experienceMemoryEngine.getExperienceContext(
    { combinationKey: key, factors: snapshot1!.factors, signalId: 'test_new_signal' },
    1700000090000,
    testStorage
  );

  assert(contextSufficient !== null, '5.2 Sample size 7 (>= MIN_SAMPLE_SIZE) returns statistics');
  assert(contextSufficient?.sampleSize === 7, '5.3 Sample size correctly counted as 7');
  assert(contextSufficient?.wins === 6, '5.4 Wins correctly counted as 6');
  assert(contextSufficient?.losses === 1, '5.5 Losses correctly counted as 1');
  assert(contextSufficient?.winRate === 85.7, '5.6 Win rate calculated accurately (85.7%)');
  assert(contextSufficient?.avgRealizedPnl > 0, '5.7 Average P&L calculated accurately');
  assert(contextSufficient?.patterns[0].matchType === 'EXACT', '5.8 Match type is EXACT');

  // -------------------------------------------------------------
  // TEST 6: Data Leakage Prevention (Hard Requirement)
  // -------------------------------------------------------------
  console.log('\n--- 6. Data Leakage Prevention ---');
  // Query at a decision time T BEFORE some of the trades completed
  // At T = 1700000052000, only trade 1 & 2 completed (sampleSize = 2 < 6)
  const contextPastTime = experienceMemoryEngine.getExperienceContext(
    { combinationKey: key, factors: snapshot1!.factors, signalId: 'test_leakage_check' },
    1700000052000,
    testStorage
  );
  assert(
    contextPastTime === null,
    '6.1 Query at historical time T excludes outcomes completed after T (no lookahead bias)'
  );

  // Current signal cannot see itself (7 total - 1 self = 6 remaining)
  const contextSelfCheck = experienceMemoryEngine.getExperienceContext(
    { combinationKey: key, factors: snapshot1!.factors, signalId: 'test_sig_exp_001' },
    1700000090000,
    testStorage
  );
  assert(
    contextSelfCheck !== null && contextSelfCheck.sampleSize === 6,
    '6.2 Current active signal is excluded from its own experience sample (leaves 6)'
  );

  // -------------------------------------------------------------
  // TEST 7: Fail-Safe Handling
  // -------------------------------------------------------------
  console.log('\n--- 7. Fail-Safe Engine ---');
  const safeContext = experienceMemoryEngine.getExperienceContext(null as any, Date.now(), testStorage);
  assert(safeContext === null, '7.1 Passing null gracefully returns null without throwing');

  const safeCapture = experienceMemoryEngine.captureDecisionSnapshot(null as any, undefined, undefined, undefined, testStorage);
  assert(safeCapture === null, '7.2 Passing null to capture gracefully returns null');

  // -------------------------------------------------------------
  // TEST 8: Feature Flag
  // -------------------------------------------------------------
  console.log('\n--- 8. Feature Flag ---');
  const currentSettings = testStorage.getSettings();
  testStorage.saveSettings({ ...currentSettings, enableExperienceMemory: false });

  assert(
    experienceMemoryEngine.isFeatureEnabled(testStorage) === false,
    '8.1 Feature flag correctly reports disabled when set to false'
  );

  const disabledContext = experienceMemoryEngine.getExperienceContext(
    { combinationKey: key, factors: snapshot1!.factors, signalId: 'test_flag' },
    1700000090000,
    testStorage
  );
  assert(disabledContext === null, '8.2 When disabled, getExperienceContext returns null');

  const disabledCapture = experienceMemoryEngine.captureDecisionSnapshot(mockSignal1, undefined, undefined, undefined, testStorage);
  assert(disabledCapture === null, '8.3 When disabled, captureDecisionSnapshot returns null');

  // Restore settings
  testStorage.saveSettings({ ...currentSettings, enableExperienceMemory: true });
  assert(experienceMemoryEngine.isFeatureEnabled(testStorage) === true, '8.4 Feature flag restored to true');

  // Clean up temporary test file
  if (fs.existsSync(testStoragePath)) { try { fs.unlinkSync(testStoragePath); } catch {} }

  console.log('====================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  if (fs.existsSync(path.join(process.cwd(), 'data', 'test_experience_memory.json'))) {
    try { fs.unlinkSync(path.join(process.cwd(), 'data', 'test_experience_memory.json')); } catch {}
  }
  process.exit(1);
});
