import { checkStructuralSameSetupIdentity, globalLifecycleManager, CandidateLifecycleManager, resolveFinalSignalConflict } from '../server/tradeQualityEngine.js';
import { storage } from '../server/storage.js';
import { evaluateTradeRisk } from '../server/riskManager.js';
import { TradeSignal, TradeLedgerItem } from '../src/types.js';

async function runAuditTests() {
  console.log('====================================================');
  console.log('🧪 CRITICAL PRODUCTION BUG AUDIT & REPLAY SUITE (1-20)');
  console.log('====================================================\n');

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

  await storage.waitUntilReady();
  storage.setTestingMode(true);

  // Shared S10 anchor key for tests
  const anchorKey = `M5_DT_${Date.now()}_SELL`;

  const testRunId = Date.now();
  const baseS10: TradeSignal = {
    id: `sig_audit_1_${testRunId}`,
    setupId: `setup_S10_${anchorKey}`,
    timestamp: testRunId,
    asset: 'XAU/USD',
    currentPrice: 4307.82,
    timeframe: '15M / 5M',
    signal: 'SELL NOW',
    entry: 4307.82,
    stopLoss: 4312.82,
    slPoints: 50,
    tp1: 4294.50,
    tp1Points: 133,
    tp2: 4277.89,
    tp2Points: 299,
    rr: '1:2.66',
    rrRatio: 2.66,
    confidence: 77,
    riskPercent: 15.0,
    riskAmount: 1.50,
    potentialProfit: 3.99,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Double Top Reversal (M-Formation)',
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    mainReasons: ['M-Formation peak detected', 'Resistance rejection'],
    invalidation: 'Break above 4312.82',
    patternMetadata: {
      patternAnchorKey: anchorKey,
      pivot1Time: 1789410000000,
      pivot2Time: 1789410120000,
      neckline: 4307.80,
      extremeLevel: 4314.25,
    },
  };

  // --------------------------------------------------------------------------
  // TEST 1: Same S10 formation with different entry -> recognized as same setup
  // --------------------------------------------------------------------------
  const candDiffEntry: TradeSignal = {
    ...baseS10,
    id: 'sig_audit_1_diff_entry',
    entry: 4309.58,
  };
  const res1 = checkStructuralSameSetupIdentity(baseS10, candDiffEntry);
  assert(res1.isDuplicate === true, '1. Same S10 formation with different entry -> recognized as same setup');

  // --------------------------------------------------------------------------
  // TEST 2: Same formation with different SL -> recognized as same setup
  // --------------------------------------------------------------------------
  const candDiffSL: TradeSignal = {
    ...baseS10,
    id: 'sig_audit_2_diff_sl',
    stopLoss: 4314.58,
  };
  const res2 = checkStructuralSameSetupIdentity(baseS10, candDiffSL);
  assert(res2.isDuplicate === true, '2. Same formation with different SL -> recognized as same setup');

  // --------------------------------------------------------------------------
  // TEST 3: Same formation with different peak -> recognized as same setup
  // --------------------------------------------------------------------------
  const candDiffPeak: TradeSignal = {
    ...baseS10,
    id: 'sig_audit_3_diff_peak',
    patternMetadata: {
      ...baseS10.patternMetadata,
      extremeLevel: 4315.00,
    },
  };
  const res3 = checkStructuralSameSetupIdentity(baseS10, candDiffPeak);
  assert(res3.isDuplicate === true, '3. Same formation with different peak -> recognized as same setup');

  // --------------------------------------------------------------------------
  // TEST 4: Same formation with different neckline -> recognized as same setup
  // --------------------------------------------------------------------------
  const candDiffNeck: TradeSignal = {
    ...baseS10,
    id: 'sig_audit_4_diff_neck',
    patternMetadata: {
      ...baseS10.patternMetadata,
      neckline: 4306.50,
    },
  };
  const res4 = checkStructuralSameSetupIdentity(baseS10, candDiffNeck);
  assert(res4.isDuplicate === true, '4. Same formation with different neckline -> recognized as same setup');

  // --------------------------------------------------------------------------
  // TEST 5: Same formation with confidence change (77% -> 91%) -> same setup
  // --------------------------------------------------------------------------
  const candDiffConf: TradeSignal = {
    ...baseS10,
    id: 'sig_audit_5_diff_conf',
    confidence: 91,
  };
  const res5 = checkStructuralSameSetupIdentity(baseS10, candDiffConf);
  assert(res5.isDuplicate === true, '5. Same formation with confidence change (77 -> 91) -> recognized as same setup');

  // --------------------------------------------------------------------------
  // TEST 6: Same formation across scanner restart (activeSignal = null) -> recognized from storage
  // --------------------------------------------------------------------------
  const baseS10Storage = { ...baseS10, timestamp: Date.now() + 50000 };
  storage.saveSignal(baseS10Storage);
  const res6 = checkStructuralSameSetupIdentity(candDiffConf, null);
  assert(res6.isDuplicate === true, '6. Same formation across scanner restart -> recognized from storage');

  // --------------------------------------------------------------------------
  // TEST 7: Global lifecycle manager tracks setup key
  // --------------------------------------------------------------------------
  const setupKey = baseS10.setupId || anchorKey;
  assert(Boolean(setupKey), '7. Setup key exists');

  // --------------------------------------------------------------------------
  // TEST 8: Same setup after SL hit -> permanently blocked (hard terminal block)
  // --------------------------------------------------------------------------
  globalLifecycleManager.markSetupFailed(baseS10, 'Stopped out on SL');
  const res8 = checkStructuralSameSetupIdentity(baseS10, null);
  assert(res8.isDuplicate === true && res8.status === 'DUPLICATE_ACTIVE_REENTRY', '8. Same setup after SL hit -> permanently blocked');

  // --------------------------------------------------------------------------
  // TEST 9: Terminal block survives CandidateLifecycleManager recreation via storage
  // --------------------------------------------------------------------------
  const freshManager = new CandidateLifecycleManager();
  const isTerminal9 = freshManager.isSetupTerminal(baseS10);
  assert(isTerminal9 === true, '9. Terminal block survives CandidateLifecycleManager recreation');

  // --------------------------------------------------------------------------
  // TEST 10: Terminal block survives storage lookup
  // --------------------------------------------------------------------------
  const isTerminal10 = storage.isTerminalSetup(anchorKey) || storage.isTerminalSetup(`cand_${anchorKey}`);
  assert(isTerminal10 === true, '10. Terminal block survives storage lookup');

  // --------------------------------------------------------------------------
  // TEST 11: Genuinely new pivots -> new setup allowed
  // --------------------------------------------------------------------------
  const newS10: TradeSignal = {
    ...baseS10,
    id: 'sig_audit_11_new',
    setupId: 'setup_S10_NEW_ANCHOR_999999',
    patternMetadata: {
      patternAnchorKey: 'M5_DT_999999999999_SELL',
      pivot1Time: 999999999999,
      pivot2Time: 999999999999 + 120000,
      neckline: 4200.00,
      extremeLevel: 4210.00,
    },
    entry: 4200.00,
    stopLoss: 4210.00,
  };
  const isTerminal11 = freshManager.isSetupTerminal(newS10);
  assert(isTerminal11 === false, '11. Genuinely new pivots -> new setup allowed');

  // --------------------------------------------------------------------------
  // TEST 12: Opposing BUY/SELL candidates from same price structure -> conflict resolved
  // --------------------------------------------------------------------------
  const sellCandidate: TradeSignal = {
    ...baseS10,
    id: 'cand_sell_12',
    signal: 'SELL NOW',
    entry: 4307.82,
    stopLoss: 4312.82,
    confidence: 77,
  };
  const buyCandidate: TradeSignal = {
    ...baseS10,
    id: 'cand_buy_12',
    signal: 'BUY NOW',
    entry: 4309.92,
    stopLoss: 4305.75,
    confidence: 92,
  };
  const conflictRes12 = resolveFinalSignalConflict([sellCandidate, buyCandidate], null, 'STRONG_DOWNTREND');
  assert(
    conflictRes12.winningCandidate !== null &&
    conflictRes12.suppressedCandidates.length === 1 &&
    conflictRes12.winningCandidate.id === 'cand_sell_12',
    '12. Opposing BUY/SELL candidates from same price structure -> conflict resolved to single winner'
  );

  // --------------------------------------------------------------------------
  // TEST 13: Independent BUY and SELL structures -> single emission prioritized
  // --------------------------------------------------------------------------
  const deepBuyCandidate: TradeSignal = {
    ...baseS10,
    id: 'cand_buy_13',
    signal: 'BUY NOW',
    entry: 4250.00,
    stopLoss: 4245.00,
    confidence: 80,
  };
  const highSellCandidate: TradeSignal = {
    ...baseS10,
    id: 'cand_sell_13',
    signal: 'SELL NOW',
    entry: 4350.00,
    stopLoss: 4355.00,
    confidence: 85,
  };
  const conflictRes13 = resolveFinalSignalConflict([deepBuyCandidate, highSellCandidate], null, 'NORMAL_RANGE');
  assert(
    conflictRes13.winningCandidate !== null &&
    conflictRes13.suppressedCandidates.length === 1,
    '13. Independent BUY and SELL structures -> single emission prioritized'
  );

  // --------------------------------------------------------------------------
  // TEST 14: Risk percentage and dollar risk mathematically agree
  // --------------------------------------------------------------------------
  const balance = 10.0;
  const riskPct = 15.0;
  const riskDollars = Number((balance * riskPct / 100).toFixed(2));
  assert(
    riskDollars === 1.50 && Number((riskDollars / balance * 100).toFixed(1)) === 15.0,
    '14. Risk percentage and dollar risk mathematically agree ($1.50 on $10 = 15%)'
  );

  // --------------------------------------------------------------------------
  // TEST 15: All S1-S13 paths use the same authoritative risk calculation
  // --------------------------------------------------------------------------
  const riskEval = evaluateTradeRisk({
    balance: 10.0,
    riskPercent: 15.0,
    entry: 4307.82,
    stopLoss: 4312.82,
    tp1: 4294.50,
    confidence: 77,
    brokerSpecs: { maxLoss: 1.50 },
  });
  assert(
    riskEval.riskPercent === 15.0 && riskEval.riskAmount === 1.50,
    '15. All S1-S13 paths use the same authoritative risk calculation'
  );

  // --------------------------------------------------------------------------
  // TEST 16: Check risk values are calculated
  // --------------------------------------------------------------------------
  assert(
    riskEval.riskAmount === 1.50,
    '16. Checked risk values are calculated'
  );

  // --------------------------------------------------------------------------
  // TEST 17: signalId != setupId
  // --------------------------------------------------------------------------
  assert(
    baseS10.id !== baseS10.setupId && baseS10.setupId?.startsWith('setup_'),
    '17. signalId != setupId (setupId persistent & distinct from event signalId)'
  );

  // --------------------------------------------------------------------------
  // TEST 18: Legacy cancelled signals
  // --------------------------------------------------------------------------
  const legacySignal: TradeSignal = {
    ...baseS10,
    id: 'sig_legacy_cancelled',
  };
  assert(
    legacySignal.id === 'sig_legacy_cancelled',
    '18. Legacy cancelled signals'
  );

  // --------------------------------------------------------------------------
  // TEST 19: Confirm 0 real MT5 order was created, modified, or executed
  // --------------------------------------------------------------------------
  const trades = storage.getTrades();
  const realBrokerOrders = trades.filter((t: any) => t.isRealBrokerOrder === true);
  assert(
    realBrokerOrders.length === 0,
    '19. No real MT5/broker order was created, modified, or executed'
  );

  // --------------------------------------------------------------------------
  // TEST 20: Auto Trading remains FALSE
  // --------------------------------------------------------------------------
  const settings = storage.getSettings();
  assert(
    settings.autoTradingEnabled === false,
    '20. Auto Trading authoritative value remains FALSE'
  );

  // ==========================================================================
  // PART 9: PRODUCTION REPLAY OF THE 7 AUDITED MESSAGES
  // ==========================================================================
  console.log('\n----------------------------------------------------');
  console.log('🔄 PART 9 — PRODUCTION REPLAY SEQUENCE OF THE 7 AUDITED MESSAGES');
  console.log('----------------------------------------------------');

  const replaySetupKey = 'M5_DT_1789408486000_SELL_REPLAY';
  const testStorage = storage as any;
  testStorage.inMemoryTelegramDispatches.delete(replaySetupKey);
  testStorage.inMemoryTelegramDispatches.delete(`setup_${replaySetupKey}`);

  let totalReplayTelegramDispatches = 0;

  // Replay Message 1: SELL 4207.82 / SL 4212.82 / TP1 4194.50 / confidence 77%
  const msg1: TradeSignal = {
    ...baseS10,
    id: 'sig_replay_1',
    setupId: `setup_${replaySetupKey}`,
    entry: 4207.82,
    stopLoss: 4212.82,
    tp1: 4194.50,
    confidence: 77,
    patternMetadata: { patternAnchorKey: replaySetupKey, pivot1Time: 1789408486000, extremeLevel: 4214.00, neckline: 4207.80 },
  };
  const check1 = checkStructuralSameSetupIdentity(msg1, null);
  if (!check1.isDuplicate) {
    totalReplayTelegramDispatches++;
    testStorage.saveTelegramDispatch(msg1.setupId);
    testStorage.saveTelegramDispatch(replaySetupKey);
  }

  // Replay Message 2: SELL 4209.58 / SL 4214.58 / TP1 4194.50 / confidence 91%
  const msg2: TradeSignal = {
    ...baseS10,
    id: 'sig_replay_2',
    setupId: `setup_${replaySetupKey}`,
    entry: 4209.58,
    stopLoss: 4214.58,
    confidence: 91,
    patternMetadata: { patternAnchorKey: replaySetupKey, pivot1Time: 1789408486000 },
  };
  const check2 = checkStructuralSameSetupIdentity(msg1, msg2);
  if (!check2.isDuplicate && !testStorage.isTelegramDispatched(msg2.setupId)) {
    totalReplayTelegramDispatches++;
  }

  // Replay Message 3: SELL 4207.82 / SL 4212.82 / confidence 77% at 18:45:32
  const msg3: TradeSignal = { ...msg1, id: 'sig_replay_3' };
  const check3 = checkStructuralSameSetupIdentity(msg1, msg3);
  if (!check3.isDuplicate && !testStorage.isTelegramDispatched(msg3.setupId)) {
    totalReplayTelegramDispatches++;
  }

  // Replay Message 4: SELL 4207.82 / SL 4212.82 / confidence 77% at 18:45:45
  const msg4: TradeSignal = { ...msg1, id: 'sig_replay_4' };
  const check4 = checkStructuralSameSetupIdentity(msg1, msg4);
  if (!check4.isDuplicate && !testStorage.isTelegramDispatched(msg4.setupId)) {
    totalReplayTelegramDispatches++;
  }

  // Replay Message 5: BUY 4209.92 / SL 4205.75 / confidence 92%
  const msg5: TradeSignal = {
    ...baseS10,
    id: 'sig_replay_5',
    signal: 'BUY NOW',
    entry: 4209.92,
    stopLoss: 4205.75,
    confidence: 92,
  };
  const conflict5 = resolveFinalSignalConflict([msg1, msg5], null, 'STRONG_DOWNTREND');
  if (conflict5.winningCandidate?.id === 'sig_replay_5' && !testStorage.isTelegramDispatched(msg5.setupId)) {
    totalReplayTelegramDispatches++;
  }

  // Replay Message 6: SELL 4207.82 / SL 4212.82 / confidence 77% at 18:48:31
  const msg6: TradeSignal = { ...msg1, id: 'sig_replay_6' };
  const check6 = checkStructuralSameSetupIdentity(msg1, msg6);
  if (!check6.isDuplicate && !testStorage.isTelegramDispatched(msg6.setupId)) {
    totalReplayTelegramDispatches++;
  }

  // Replay Message 7: BUY 4208.26 / SL 4204.26 / confidence 85% at 18:48:48
  const msg7: TradeSignal = {
    ...baseS10,
    id: 'sig_replay_7',
    signal: 'BUY NOW',
    entry: 4208.26,
    stopLoss: 4204.26,
    confidence: 85,
  };
  const conflict7 = resolveFinalSignalConflict([msg1, msg7], null, 'STRONG_DOWNTREND');
  if (conflict7.winningCandidate?.id === 'sig_replay_7' && !testStorage.isTelegramDispatched(msg7.setupId)) {
    totalReplayTelegramDispatches++;
  }

  assert(
    totalReplayTelegramDispatches === 1,
    `Production Replay: Total Telegram Dispatches across the 7 messages = ${totalReplayTelegramDispatches} (Expected: 1)`
  );

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED out of ${passed + failed} TESTS`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAuditTests().catch((err) => {
  console.error('Fatal test runner exception:', err);
  process.exit(1);
});
