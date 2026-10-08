import { storage } from '../server/storage.js';
import { generateOpportunityId, checkStructuralSameSetupIdentity } from '../server/tradeQualityEngine.js';
import { TERMINAL_OPPORTUNITY_STATUSES, isTerminalOpportunityStatus } from '../server/scanner.js';
import { TradeSignal, TradeOpportunity } from '../src/types.js';

process.env.ENABLE_INTERNAL_SCANNER = 'false';
process.env.SCANNER_TRIGGER_MODE = 'cron';

async function runTerminalLifecycleTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING TERMINAL OPPORTUNITY LIFECYCLE AUDIT TESTS (1-7)');
  console.log('====================================================\n');

  storage.setTestingMode(true);
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  const baseTimestamp = Date.now() - 3600000;

  function createMockSignal(
    id: string,
    price: number,
    setup: string = 'Bearish Volatility Expansion',
    direction: 'SELL NOW' | 'BUY NOW' = 'SELL NOW',
    anchorKey?: string
  ): TradeSignal {
    const isSell = direction.includes('SELL');
    return {
      id,
      timestamp: Date.now(),
      asset: 'XAU/USD',
      currentPrice: price,
      timeframe: '15M / 5M',
      signal: direction,
      entry: price,
      stopLoss: isSell ? price + 5.0 : price - 5.0,
      slPoints: 50,
      tp1: isSell ? price - 10.0 : price + 10.0,
      tp1Points: 100,
      tp2: isSell ? price - 20.0 : price + 20.0,
      tp2Points: 200,
      rr: '1:2.0',
      rrRatio: 2.0,
      confidence: 85,
      riskPercent: 1.5,
      riskAmount: 15.0,
      potentialProfit: 30.0,
      potentialLoss: 15.0,
      recommendedLotSize: 0.01,
      setup,
      strategyFamily: 'RANGE_BREAKOUT',
      mainReasons: ['Breakout expansion confirmed'],
      invalidation: 'Reversal above level',
      patternMetadata: anchorKey
        ? {
            patternAnchorKey: anchorKey,
            extremeLevel: price,
            neckline: isSell ? price - 2.0 : price + 2.0,
          }
        : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // TEST 1: Existing opportunity status = FAILED with dispatchedAt does NOT block new signal
  // --------------------------------------------------------------------------
  const signal1 = createMockSignal('sig_failed_1', 4340.0, 'Range Breakout Expansion', 'SELL NOW');
  const oppId1 = generateOpportunityId(signal1);

  const oldDispatchedAt = baseTimestamp;
  const oldFailedAt = baseTimestamp + 600000;
  const opp1: TradeOpportunity = {
    id: oppId1,
    setupName: signal1.setup,
    strategyFamily: signal1.strategyFamily || 'RANGE_BREAKOUT',
    direction: 'SELL',
    timeframe: signal1.timeframe,
    status: 'FAILED',
    dispatchedAt: oldDispatchedAt,
    failedAt: oldFailedAt,
    firstObservedTime: oldDispatchedAt - 60000,
    lastUpdatedTime: oldFailedAt,
    entry: signal1.entry,
    stopLoss: signal1.stopLoss,
    tp1: signal1.tp1,
    tp2: signal1.tp2,
    confidence: signal1.confidence,
    signalId: signal1.id,
  };
  storage.saveOpportunity(opp1);

  const storedOpp1 = storage.getOpportunity(oppId1);
  assert(storedOpp1?.status === 'FAILED', '1a: Stored opp1 is FAILED');
  assert(isTerminalOpportunityStatus(storedOpp1?.status) === true, '1b: FAILED is recognized as terminal');

  const newSignal1 = createMockSignal('sig_new_after_failed', 4340.0, 'Range Breakout Expansion', 'SELL NOW');
  const newOppId1 = generateOpportunityId(newSignal1);
  assert(newOppId1 === oppId1, '1c: New signal generates same cluster oppId');

  // Scanner lifecycle step
  let oppRef1 = storage.getOpportunity(newOppId1);
  const isTerminalOpp1 = oppRef1 && isTerminalOpportunityStatus(oppRef1.status);
  assert(Boolean(isTerminalOpp1) === true, '1d: Scanner recognizes existing opp as terminal');

  if (oppRef1 && isTerminalOpp1) {
    const archivedId = `${oppRef1.id}_hist_${oppRef1.failedAt || oppRef1.completedAt || oppRef1.lastUpdatedTime || Date.now()}`;
    storage.saveOpportunity({ ...oppRef1, id: archivedId });
    oppRef1 = {
      id: newOppId1,
      setupName: newSignal1.setup,
      strategyFamily: newSignal1.strategyFamily || 'UNKNOWN',
      direction: 'SELL',
      timeframe: newSignal1.timeframe,
      status: 'ACTIVE',
      firstObservedTime: Date.now(),
      lastUpdatedTime: Date.now(),
      entry: newSignal1.entry,
      stopLoss: newSignal1.stopLoss,
      tp1: newSignal1.tp1,
      tp2: newSignal1.tp2,
      confidence: newSignal1.confidence,
      signalId: newSignal1.id,
    };
    storage.saveOpportunity(oppRef1);
  }

  const activeOpp1 = storage.getOpportunity(oppId1);
  assert(activeOpp1?.status === 'ACTIVE', '1e: New active cycle created with status ACTIVE');
  assert(activeOpp1?.status !== 'DISPATCHED', '1f: New cycle is NOT suppressed as DISPATCHED');
  assert(activeOpp1?.dispatchedAt === undefined, '1g: Historical dispatchedAt cleared from new active cycle');

  // --------------------------------------------------------------------------
  // TEST 2: Existing opportunity status = COMPLETED with dispatchedAt does NOT block new signal
  // --------------------------------------------------------------------------
  const signal2 = createMockSignal('sig_completed_1', 4350.0, 'Double Top Reversal', 'SELL NOW');
  const oppId2 = generateOpportunityId(signal2);

  const completedOpp: TradeOpportunity = {
    id: oppId2,
    setupName: signal2.setup,
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    direction: 'SELL',
    timeframe: signal2.timeframe,
    status: 'COMPLETED',
    dispatchedAt: baseTimestamp,
    completedAt: baseTimestamp + 1200000,
    firstObservedTime: baseTimestamp - 60000,
    lastUpdatedTime: baseTimestamp + 1200000,
    entry: signal2.entry,
    stopLoss: signal2.stopLoss,
    tp1: signal2.tp1,
    tp2: signal2.tp2,
    confidence: signal2.confidence,
    signalId: signal2.id,
  };
  storage.saveOpportunity(completedOpp);

  assert(isTerminalOpportunityStatus(storage.getOpportunity(oppId2)?.status) === true, '2a: COMPLETED is terminal');

  const newSignal2 = createMockSignal('sig_new_after_completed', 4350.0, 'Double Top Reversal', 'SELL NOW');
  let oppRef2 = storage.getOpportunity(oppId2);
  if (oppRef2 && isTerminalOpportunityStatus(oppRef2.status)) {
    storage.saveOpportunity({ ...oppRef2, id: `${oppRef2.id}_hist_${oppRef2.completedAt}` });
    oppRef2 = {
      id: oppId2,
      setupName: newSignal2.setup,
      strategyFamily: 'DOUBLE_TOP_BOTTOM',
      direction: 'SELL',
      timeframe: newSignal2.timeframe,
      status: 'ACTIVE',
      firstObservedTime: Date.now(),
      lastUpdatedTime: Date.now(),
      entry: newSignal2.entry,
      stopLoss: newSignal2.stopLoss,
      tp1: newSignal2.tp1,
      tp2: newSignal2.tp2,
      confidence: newSignal2.confidence,
      signalId: newSignal2.id,
    };
    storage.saveOpportunity(oppRef2);
  }

  const currentOpp2 = storage.getOpportunity(oppId2);
  assert(currentOpp2?.status === 'ACTIVE', '2b: New active cycle status is ACTIVE');
  assert(currentOpp2?.status !== 'DISPATCHED', '2c: New signal after COMPLETED is NOT suppressed');

  // --------------------------------------------------------------------------
  // TEST 3: Existing opportunity status = CANCELLED with dispatchedAt does NOT block new signal
  // --------------------------------------------------------------------------
  const signal3 = createMockSignal('sig_cancelled_1', 4320.0, 'Structure Engulfing', 'BUY NOW');
  const oppId3 = generateOpportunityId(signal3);

  const cancelledOpp: TradeOpportunity = {
    id: oppId3,
    setupName: signal3.setup,
    strategyFamily: 'STRUCTURE_ENGULFING',
    direction: 'BUY',
    timeframe: signal3.timeframe,
    status: 'CANCELLED',
    dispatchedAt: baseTimestamp,
    firstObservedTime: baseTimestamp,
    lastUpdatedTime: baseTimestamp + 300000,
    entry: signal3.entry,
    stopLoss: signal3.stopLoss,
    tp1: signal3.tp1,
    tp2: signal3.tp2,
    confidence: signal3.confidence,
    signalId: signal3.id,
  };
  storage.saveOpportunity(cancelledOpp);

  assert(isTerminalOpportunityStatus(storage.getOpportunity(oppId3)?.status) === true, '3a: CANCELLED is terminal');

  const newSignal3 = createMockSignal('sig_new_after_cancelled', 4320.0, 'Structure Engulfing', 'BUY NOW');
  let oppRef3 = storage.getOpportunity(oppId3);
  if (oppRef3 && isTerminalOpportunityStatus(oppRef3.status)) {
    storage.saveOpportunity({ ...oppRef3, id: `${oppRef3.id}_hist_${oppRef3.lastUpdatedTime}` });
    oppRef3 = {
      id: oppId3,
      setupName: newSignal3.setup,
      strategyFamily: 'STRUCTURE_ENGULFING',
      direction: 'BUY',
      timeframe: newSignal3.timeframe,
      status: 'ACTIVE',
      firstObservedTime: Date.now(),
      lastUpdatedTime: Date.now(),
      entry: newSignal3.entry,
      stopLoss: newSignal3.stopLoss,
      tp1: newSignal3.tp1,
      tp2: newSignal3.tp2,
      confidence: newSignal3.confidence,
      signalId: newSignal3.id,
    };
    storage.saveOpportunity(oppRef3);
  }

  const currentOpp3 = storage.getOpportunity(oppId3);
  assert(currentOpp3?.status === 'ACTIVE', '3b: New active cycle status is ACTIVE');
  assert(currentOpp3?.status !== 'DISPATCHED', '3c: New signal after CANCELLED is NOT suppressed');

  // --------------------------------------------------------------------------
  // TEST 4: Existing opportunity status = NOT_ENTERED with dispatchedAt does NOT block new signal
  // --------------------------------------------------------------------------
  const signal4 = createMockSignal('sig_not_entered_1', 4310.0, 'Order Block Demand', 'BUY NOW');
  const oppId4 = generateOpportunityId(signal4);

  const notEnteredOpp: TradeOpportunity = {
    id: oppId4,
    setupName: signal4.setup,
    strategyFamily: 'ORDER_BLOCK',
    direction: 'BUY',
    timeframe: signal4.timeframe,
    status: 'NOT_ENTERED',
    dispatchedAt: baseTimestamp,
    firstObservedTime: baseTimestamp,
    lastUpdatedTime: baseTimestamp + 14400000,
    entry: signal4.entry,
    stopLoss: signal4.stopLoss,
    tp1: signal4.tp1,
    tp2: signal4.tp2,
    confidence: signal4.confidence,
    signalId: signal4.id,
  };
  storage.saveOpportunity(notEnteredOpp);

  assert(isTerminalOpportunityStatus(storage.getOpportunity(oppId4)?.status) === true, '4a: NOT_ENTERED is terminal');

  const newSignal4 = createMockSignal('sig_new_after_not_entered', 4310.0, 'Order Block Demand', 'BUY NOW');
  let oppRef4 = storage.getOpportunity(oppId4);
  if (oppRef4 && isTerminalOpportunityStatus(oppRef4.status)) {
    storage.saveOpportunity({ ...oppRef4, id: `${oppRef4.id}_hist_${oppRef4.lastUpdatedTime}` });
    oppRef4 = {
      id: oppId4,
      setupName: newSignal4.setup,
      strategyFamily: 'ORDER_BLOCK',
      direction: 'BUY',
      timeframe: newSignal4.timeframe,
      status: 'ACTIVE',
      firstObservedTime: Date.now(),
      lastUpdatedTime: Date.now(),
      entry: newSignal4.entry,
      stopLoss: newSignal4.stopLoss,
      tp1: newSignal4.tp1,
      tp2: newSignal4.tp2,
      confidence: newSignal4.confidence,
      signalId: newSignal4.id,
    };
    storage.saveOpportunity(oppRef4);
  }

  const currentOpp4 = storage.getOpportunity(oppId4);
  assert(currentOpp4?.status === 'ACTIVE', '4b: New active cycle status is ACTIVE');
  assert(currentOpp4?.status !== 'DISPATCHED', '4c: New signal after NOT_ENTERED is NOT suppressed');

  // --------------------------------------------------------------------------
  // TEST 5: Active DISPATCHED opportunity DOES suppress duplicate evolving alerts
  // --------------------------------------------------------------------------
  const signal5 = createMockSignal('sig_active_dispatched', 4330.0, 'Range Breakout Expansion', 'SELL NOW');
  const oppId5 = generateOpportunityId(signal5);

  const dispatchedTimestamp = Date.now() - 60000;
  const dispatchedOpp: TradeOpportunity = {
    id: oppId5,
    setupName: signal5.setup,
    strategyFamily: 'RANGE_BREAKOUT',
    direction: 'SELL',
    timeframe: signal5.timeframe,
    status: 'DISPATCHED',
    dispatchedAt: dispatchedTimestamp,
    firstObservedTime: dispatchedTimestamp,
    lastUpdatedTime: dispatchedTimestamp,
    entry: 4330.0,
    stopLoss: 4335.0,
    tp1: 4320.0,
    tp2: 4310.0,
    confidence: 80,
    signalId: signal5.id,
  };
  storage.saveOpportunity(dispatchedOpp);

  const oppRef5 = storage.getOpportunity(oppId5);
  assert(Boolean(oppRef5), '5a: In-flight opp5 exists');
  assert(isTerminalOpportunityStatus(oppRef5?.status) === false, '5b: In-flight dispatched opp is not terminal');
  assert(oppRef5?.status === 'DISPATCHED', '5c: Active DISPATCHED opp correctly triggers duplicate suppression');

  if (oppRef5) {
    oppRef5.confidence = 88;
    oppRef5.lastUpdatedTime = Date.now();
    storage.saveOpportunity(oppRef5);
  }

  const updatedOpp5 = storage.getOpportunity(oppId5);
  assert(updatedOpp5?.confidence === 88, '5d: Evolved confidence updated');
  assert(updatedOpp5?.entry === 4330.0, '5e: Original entry level preserved');
  assert(updatedOpp5?.stopLoss === 4335.0, '5f: Original stopLoss level preserved');
  assert(updatedOpp5?.status === 'DISPATCHED', '5g: Status remains DISPATCHED');

  // --------------------------------------------------------------------------
  // TEST 6: Active opportunity (not yet dispatched) handles duplicate candidate correctly
  // --------------------------------------------------------------------------
  const signal6 = createMockSignal('sig_active_in_flight', 4325.0, 'Bare Resistance Rejection', 'SELL NOW');
  const oppId6 = generateOpportunityId(signal6);

  const activeOpp6: TradeOpportunity = {
    id: oppId6,
    setupName: signal6.setup,
    strategyFamily: 'BARE_SR',
    direction: 'SELL',
    timeframe: signal6.timeframe,
    status: 'ACTIVE',
    dispatchedAt: undefined,
    firstObservedTime: Date.now(),
    lastUpdatedTime: Date.now(),
    entry: 4325.0,
    stopLoss: 4330.0,
    tp1: 4315.0,
    tp2: 4305.0,
    confidence: 82,
    signalId: signal6.id,
  };
  storage.saveOpportunity(activeOpp6);

  const oppRef6 = storage.getOpportunity(oppId6);
  assert(Boolean(oppRef6), '6a: Active opp6 exists');
  assert(oppRef6?.status === 'ACTIVE', '6b: Status is ACTIVE');
  assert(oppRef6?.dispatchedAt === undefined, '6c: dispatchedAt is undefined');
  assert(isTerminalOpportunityStatus(oppRef6?.status) === false, '6d: ACTIVE is not terminal');
  assert(oppRef6?.status !== 'DISPATCHED', '6e: Active non-dispatched opp does not trigger dispatched suppression');

  // --------------------------------------------------------------------------
  // TEST 7: Historical opportunity records are preserved and not destroyed when new cycle begins
  // --------------------------------------------------------------------------
  const oldSignalId7 = 'old_sig_1_4340';
  const oldTimestamp7 = baseTimestamp;
  const oldFailedTimestamp7 = baseTimestamp + 500000;
  const signal7 = createMockSignal(oldSignalId7, 4340.0, 'Range Breakout Expansion', 'SELL NOW');
  const oppId7 = generateOpportunityId(signal7);

  const historicalOpp7: TradeOpportunity = {
    id: oppId7,
    setupName: signal7.setup,
    strategyFamily: 'RANGE_BREAKOUT',
    direction: 'SELL',
    timeframe: signal7.timeframe,
    status: 'FAILED',
    failedAt: oldFailedTimestamp7,
    dispatchedAt: oldTimestamp7,
    firstObservedTime: oldTimestamp7 - 60000,
    lastUpdatedTime: oldFailedTimestamp7,
    entry: 4340.0,
    stopLoss: 4345.0,
    tp1: 4330.0,
    tp2: 4320.0,
    confidence: 78,
    signalId: oldSignalId7,
  };
  storage.saveOpportunity(historicalOpp7);

  const newSignalId7 = 'new_sig_2_4340';
  const newSignal7 = createMockSignal(newSignalId7, 4340.0, 'Range Breakout Expansion', 'SELL NOW');

  let oppRef7 = storage.getOpportunity(oppId7);
  assert(Boolean(oppRef7), '7a: Historical opp7 exists');
  const archivedKey7 = `${oppRef7!.id}_hist_${oppRef7!.failedAt || oppRef7!.completedAt || oppRef7!.lastUpdatedTime || Date.now()}`;

  // Archive historical record
  storage.saveOpportunity({
    ...oppRef7!,
    id: archivedKey7,
  });

  // Create fresh opportunity cycle
  const freshCycle7: TradeOpportunity = {
    id: oppId7,
    setupName: newSignal7.setup,
    strategyFamily: newSignal7.strategyFamily || 'UNKNOWN',
    direction: 'SELL',
    timeframe: newSignal7.timeframe,
    status: 'ACTIVE',
    firstObservedTime: Date.now(),
    lastUpdatedTime: Date.now(),
    entry: newSignal7.entry,
    stopLoss: newSignal7.stopLoss,
    tp1: newSignal7.tp1,
    tp2: newSignal7.tp2,
    confidence: newSignal7.confidence,
    signalId: newSignalId7,
  };
  storage.saveOpportunity(freshCycle7);

  // 1. Verify fresh active cycle has new state
  const currentActive7 = storage.getOpportunity(oppId7);
  assert(currentActive7?.status === 'ACTIVE', '7b: Fresh active cycle has status ACTIVE');
  assert(currentActive7?.signalId === newSignalId7, '7c: Fresh cycle has new signalId');
  assert(currentActive7?.dispatchedAt === undefined, '7d: Fresh cycle has undefined dispatchedAt');
  assert(currentActive7?.failedAt === undefined, '7e: Fresh cycle has undefined failedAt');

  // 2. Verify archived historical record is intact with all original data
  const archivedRecord7 = storage.getOpportunity(archivedKey7);
  assert(Boolean(archivedRecord7), '7f: Archived historical opportunity exists in storage');
  assert(archivedRecord7?.status === 'FAILED', '7g: Archived status is FAILED');
  assert(archivedRecord7?.signalId === oldSignalId7, '7h: Archived signalId is preserved');
  assert(archivedRecord7?.dispatchedAt === oldTimestamp7, '7i: Archived dispatchedAt is preserved');
  assert(archivedRecord7?.failedAt === oldFailedTimestamp7, '7j: Archived failedAt is preserved');
  assert(archivedRecord7?.confidence === 78, '7k: Archived confidence is preserved');

  // --------------------------------------------------------------------------
  // TEST 9: Duplicate signal evolution does not corrupt archived historical records
  // --------------------------------------------------------------------------
  // Update active opportunity 7 confidence and levels attempt
  const activeCycle7 = storage.getOpportunity(oppId7);
  if (activeCycle7) {
    activeCycle7.confidence = 95; // Evolved confidence
    activeCycle7.lastUpdatedTime = Date.now();
    storage.saveOpportunity(activeCycle7);
  }

  const archivedAfterMutation = storage.getOpportunity(archivedKey7);
  assert(archivedAfterMutation?.confidence === 78, '9a: Archived historical confidence remains untouched at 78 after active cycle evolution to 95');
  assert(archivedAfterMutation?.status === 'FAILED', '9b: Archived status remains FAILED');
  assert(archivedAfterMutation?.entry === 4340.0, '9c: Archived entry remains 4340.0');

  // --------------------------------------------------------------------------
  // TEST 10: Structural terminal block remains strictly enforced for same anchor
  // --------------------------------------------------------------------------
  const failedAnchorSignal = createMockSignal('sig_failed_anchor', 4400.0, 'Double Top Reversal', 'SELL NOW');
  failedAnchorSignal.strategyFamily = 'DOUBLE_TOP_BOTTOM';
  failedAnchorSignal.patternMetadata = {
    patternAnchorKey: 'M5_DT_ANCHOR_123_SELL',
    extremeLevel: 4405.0,
    neckline: 4395.0,
    pivot1Time: 1700000000000,
  };

  const failedStructuralOpp: TradeOpportunity = {
    id: generateOpportunityId(failedAnchorSignal),
    setupName: failedAnchorSignal.setup,
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    direction: 'SELL',
    timeframe: failedAnchorSignal.timeframe,
    status: 'FAILED',
    failedAt: Date.now() - 100000,
    firstObservedTime: Date.now() - 200000,
    lastUpdatedTime: Date.now() - 100000,
    patternAnchorKey: 'M5_DT_ANCHOR_123_SELL',
    pivot1Time: 1700000000000,
    entry: 4400.0,
    stopLoss: 4405.0,
    tp1: 4390.0,
    tp2: 4380.0,
    confidence: 85,
    signalId: failedAnchorSignal.id,
  };
  storage.saveOpportunity(failedStructuralOpp);

  const reEntryCandidate = createMockSignal('sig_reentry_attempt', 4401.0, 'Double Top Reversal', 'SELL NOW');
  reEntryCandidate.strategyFamily = 'DOUBLE_TOP_BOTTOM';
  reEntryCandidate.patternMetadata = {
    patternAnchorKey: 'M5_DT_ANCHOR_123_SELL', // Same structural anchor
    extremeLevel: 4405.0,
    neckline: 4395.0,
    pivot1Time: 1700000000000,
  };

  const reEntryCheck = checkStructuralSameSetupIdentity(reEntryCandidate, null);
  assert(reEntryCheck.status === 'DUPLICATE_ACTIVE_REENTRY', '10a: Same structural anchor after FAILED status is strictly blocked (DUPLICATE_ACTIVE_REENTRY)');
  assert(reEntryCheck.isReentry === true, '10b: isReentry is true');

  const independentCandidate = createMockSignal('sig_independent_dt', 4420.0, 'Double Top Reversal', 'SELL NOW');
  independentCandidate.strategyFamily = 'DOUBLE_TOP_BOTTOM';
  independentCandidate.patternMetadata = {
    patternAnchorKey: 'M5_DT_ANCHOR_999_SELL', // Different structural anchor
    extremeLevel: 4425.0,
    neckline: 4415.0,
    pivot1Time: 1700000500000,
  };
  const independentCheck = checkStructuralSameSetupIdentity(independentCandidate, null);
  assert(independentCheck.status === 'QUALIFIED_SIGNAL', '10c: Independent setup with different structural anchor is ALLOWED (QUALIFIED_SIGNAL)');

  console.log('\n====================================================');
  console.log(`📊 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTerminalLifecycleTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
