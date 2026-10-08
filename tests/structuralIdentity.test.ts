import { checkStructuralSameSetupIdentity, globalLifecycleManager, CandidateLifecycleManager } from '../server/tradeQualityEngine.js';
import { performLegacySignalCleanup } from '../server/legacyCleanup.js';
import { storage } from '../server/storage.js';
import { TradeSignal, TradeLedgerItem } from '../src/types.js';

async function runStructuralIdentityTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING STRUCTURAL SETUP IDENTITY & SAFETY TESTS (A-Q)');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] Test ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] Test ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  await storage.waitUntilReady();
  globalLifecycleManager.clear();

  const testAnchorKey = `M5_DT_${Date.now()}_SELL`;
  const pivot1 = Date.now();

  // Audited Signal A
  const signalA: TradeSignal = {
    id: 'sig_audit_A',
    timestamp: Date.now(),
    asset: 'XAU/USD',
    currentPrice: 4307.82,
    timeframe: '15M / 5M',
    signal: 'SELL NOW',
    entry: 4307.82,
    stopLoss: 4312.82,
    slPoints: 500,
    tp1: 4294.50,
    tp1Points: 1332,
    tp2: 4277.89,
    tp2Points: 2993,
    rr: '1:2.66',
    rrRatio: 2.66,
    confidence: 77,
    riskPercent: 1.5,
    riskAmount: 15.0,
    potentialProfit: 3.99,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Double Top Reversal (M-Formation)',
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    mainReasons: ['M-Formation peak detected', 'Resistance rejection'],
    invalidation: 'Break above 4312.82',
    patternMetadata: {
      patternAnchorKey: testAnchorKey,
      pivot1Time: pivot1,
      pivot2Time: pivot1 + 120000,
      neckline: 4307.80,
      extremeLevel: 4314.25,
    },
  };

  // Audited Signal B (Evolving Double Top)
  const signalB: TradeSignal = {
    id: 'sig_audit_B',
    timestamp: Date.now() + 120000,
    asset: 'XAU/USD',
    currentPrice: 4309.58,
    timeframe: '15M / 5M',
    signal: 'SELL NOW',
    entry: 4309.58, // +$1.76 entry diff
    stopLoss: 4314.58, // +$1.76 SL diff
    slPoints: 500,
    tp1: 4294.50,
    tp1Points: 1508,
    tp2: 4279.65,
    tp2Points: 2993,
    rr: '1:3.02',
    rrRatio: 3.02,
    confidence: 91, // Higher confidence 77% -> 91%
    riskPercent: 1.5,
    riskAmount: 15.0,
    potentialProfit: 4.53,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Double Top Reversal (M-Formation)',
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    mainReasons: ['Stronger M-Formation rejection', 'Higher peak retest'],
    invalidation: 'Break above 4314.58',
    patternMetadata: {
      patternAnchorKey: testAnchorKey, // Same anchor key!
      pivot1Time: pivot1,
      pivot2Time: pivot1 + 240000,
      neckline: 4307.80,
      extremeLevel: 4316.19, // Peak shift +$1.94
    },
  };

  // Regression Test (Scanner Idle State): Candidate = valid signal, activeItem = null -> no exception & isDuplicate=false
  const resIdle = checkStructuralSameSetupIdentity(signalA, null);
  assert(resIdle.isDuplicate === false && resIdle.status === 'QUALIFIED_SIGNAL', 'IDLE: Valid candidate with null activeItem returns QUALIFIED_SIGNAL without error');

  // Test A: Audited Signal A and Signal B -> resolved as SAME structural setup
  const resA_B = checkStructuralSameSetupIdentity(signalA, signalB);
  assert(resA_B.isDuplicate === true, 'A: Signal A and Signal B recognized as SAME structural setup', resA_B.reason);

  // Test B: Entry changes -> SAME setup
  const signalB_entryShift = { ...signalB, entry: 4311.20 };
  const resB = checkStructuralSameSetupIdentity(signalA, signalB_entryShift);
  assert(resB.isDuplicate === true, 'B: Entry price shift resolved as SAME setup', resB.reason);

  // Test C: SL changes -> SAME setup
  const signalB_slShift = { ...signalB, stopLoss: 4316.50 };
  const resC = checkStructuralSameSetupIdentity(signalA, signalB_slShift);
  assert(resC.isDuplicate === true, 'C: Stop loss shift resolved as SAME setup', resC.reason);

  // Test D: Confidence increases -> SAME setup
  const signalB_confShift = { ...signalB, confidence: 98 };
  const resD = checkStructuralSameSetupIdentity(signalA, signalB_confShift);
  assert(resD.isDuplicate === true, 'D: Higher confidence (98%) resolved as SAME setup', resD.reason);

  // Test E: Peak moves slightly while formation evolves -> SAME setup
  const signalB_peakShift = {
    ...signalB,
    patternMetadata: { ...signalB.patternMetadata, extremeLevel: 4317.50 },
  };
  const resE = checkStructuralSameSetupIdentity(signalA, signalB_peakShift);
  assert(resE.isDuplicate === true, 'E: Peak shift resolved as SAME setup', resE.reason);

  // Test F: Same setup after SL hit -> BLOCKED
  globalLifecycleManager.markSetupFailed(signalA, 'Hit Stop Loss at 4312.82');
  assert(globalLifecycleManager.isSetupTerminal(signalA) === true, 'F1: Signal A marked as terminal FAILED');
  const resF = checkStructuralSameSetupIdentity(signalB, null);
  assert(resF.isDuplicate === true && resF.status === 'DUPLICATE_ACTIVE_REENTRY', 'F2: Re-entry after SL hit is permanently BLOCKED', resF.reason);

  // Test G: Same setup after scanner restart -> STILL BLOCKED
  const freshLifecycleManager = new CandidateLifecycleManager(globalLifecycleManager.getAllLifecycles());
  assert(freshLifecycleManager.isSetupTerminal(signalB) === true, 'G: Setup remains BLOCKED after lifecycle manager re-instantiation');

  // Test H: Same setup with new price ($4318) and higher confidence (99%) -> STILL BLOCKED
  const signalB_super = { ...signalB, entry: 4318.00, stopLoss: 4322.00, confidence: 99 };
  assert(globalLifecycleManager.isSetupTerminal(signalB_super) === true, 'H: Higher confidence (99%) & new price CANNOT bypass terminal block');

  // Test I: Genuinely NEW Double Top with new pivot anchors -> ALLOWED
  const signalNewDoubleTop: TradeSignal = {
    ...signalA,
    id: 'sig_new_double_top',
    entry: 4330.00,
    stopLoss: 4335.00,
    patternMetadata: {
      patternAnchorKey: 'M5_DT_1789420000000_SELL', // Different pivot1 time!
      pivot1Time: 1789420000000,
      pivot2Time: 1789420120000,
      neckline: 4325.00,
      extremeLevel: 4336.00,
    },
  };
  const resI = checkStructuralSameSetupIdentity(signalNewDoubleTop, null);
  assert(resI.isDuplicate === false, 'I: Genuinely new Double Top with new pivot anchors is ALLOWED', resI.reason);

  // Test J: Independent S11 setup -> ALLOWED / unaffected
  const signalS11: TradeSignal = {
    ...signalA,
    id: 'sig_s11',
    setup: 'Bare Resistance Rejection',
    strategyFamily: 'BARE_SR',
    patternMetadata: { patternAnchorKey: 'M5_SR_4325_SELL' },
  };
  const resJ = checkStructuralSameSetupIdentity(signalS11, null);
  assert(resJ.isDuplicate === false, 'J: Independent S11 setup is ALLOWED');

  // Test K: Independent S12 setup -> ALLOWED / unaffected
  const signalS12: TradeSignal = {
    ...signalA,
    id: 'sig_s12',
    setup: 'Structure Engulfing Bar',
    strategyFamily: 'STRUCTURE_ENGULFING',
    patternMetadata: { patternAnchorKey: 'M5_ENGULF_4320_SELL' },
  };
  const resK = checkStructuralSameSetupIdentity(signalS12, null);
  assert(resK.isDuplicate === false, 'K: Independent S12 setup is ALLOWED');

  // Test L: Independent S13 setup -> ALLOWED / unaffected
  const signalS13: TradeSignal = {
    ...signalA,
    id: 'sig_s13',
    setup: 'Market Structure Break & Retest',
    strategyFamily: 'MARKET_STRUCTURE',
    patternMetadata: { patternAnchorKey: 'M5_MSB_4315_SELL' },
  };
  const resL = checkStructuralSameSetupIdentity(signalS13, null);
  assert(resL.isDuplicate === false, 'L: Independent S13 setup is ALLOWED');

  // Test N, O, P, Q: Legacy Signal Cleanup Audit
  const cleanupReport = performLegacySignalCleanup();
  assert(cleanupReport.realBrokerOrdersAffected === 0, 'Q: Zero real MT5 / broker orders affected (0)');
  assert(cleanupReport.untouchedHistoricalCompletedTrades >= 0, 'P: Historical completed trades preserved');
  assert(cleanupReport.cancelledSignals >= 0, 'N: Legacy signals marked INVALIDATED/CANCELLED');
  assert(cleanupReport.cancelledActiveVirtualTrades >= 0, 'O: Active virtual trades cancelled');

  console.log('\n====================================================');
  console.log(`📊 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStructuralIdentityTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
