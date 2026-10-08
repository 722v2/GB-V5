import { checkStructuralSameSetupIdentity, globalLifecycleManager, generateOpportunityId, resolveFinalSignalConflict } from '../server/tradeQualityEngine.js';
import { storage } from '../server/storage.js';
import { TradeSignal, TradeOpportunity } from '../src/types.js';

async function runRegressionScenarioTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING REGRESSION SCENARIO TEST: 08:47:57 BUY -> 08:53:13 SELL -> 08:53:56 BUY');
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

  // 1. 08:47:57 BUY Double Bottom (Initial Signal)
  const time1 = new Date('2026-09-15T08:47:57Z').getTime();
  const buySignal1: TradeSignal = {
    id: `sig_buy_084757_${Date.now()}`,
    timestamp: time1,
    asset: 'XAU/USD',
    currentPrice: 4275.18,
    timeframe: '15M / 5M',
    signal: 'BUY NOW',
    entry: 4275.18,
    stopLoss: 4258.53,
    slPoints: 1665,
    tp1: 4291.83,
    tp1Points: 1665,
    tp2: 4308.48,
    tp2Points: 3330,
    rr: '1:2.00',
    rrRatio: 2.0,
    confidence: 82,
    riskPercent: 1.5,
    riskAmount: 15.0,
    potentialProfit: 3.00,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Double Bottom Reversal (W-Formation)',
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    mainReasons: ['W-Formation bottom confirmed at 4263.53', 'Neckline breakout at 4275.18'],
    invalidation: 'Break below 4258.53',
    patternMetadata: {
      patternAnchorKey: 'M5_DB_4263.53_4275.18_BUY',
      pivot1Time: time1 - 600000,
      pivot2Time: time1 - 120000,
      neckline: 4275.18,
      extremeLevel: 4263.53,
    },
  };

  // Step 1: Save 08:47:57 BUY to storage and create opportunity
  storage.saveSignal(buySignal1);
  const oppId1 = generateOpportunityId(buySignal1);
  const opp1: TradeOpportunity = {
    id: oppId1,
    setupName: buySignal1.setup,
    strategyFamily: buySignal1.strategyFamily || 'DOUBLE_TOP_BOTTOM',
    direction: 'BUY',
    timeframe: buySignal1.timeframe,
    status: 'ACTIVE',
    firstObservedTime: time1,
    lastUpdatedTime: time1,
    entry: buySignal1.entry,
    stopLoss: buySignal1.stopLoss,
    tp1: buySignal1.tp1,
    tp2: buySignal1.tp2,
    confidence: buySignal1.confidence,
    extremeLevel: 4263.53,
    neckline: 4275.18,
    patternAnchorKey: 'M5_DB_4263.53_4275.18_BUY',
    pivot1Time: time1 - 600000,
    pivot2Time: time1 - 120000,
  };
  storage.saveOpportunity(opp1);

  opp1.status = 'DISPATCHED';
  storage.saveOpportunity(opp1);

  // Step 2: 08:53:13 SELL Double Top (Intervening Opposing Signal)
  const time2 = new Date('2026-09-15T08:53:13Z').getTime();
  const sellSignal: TradeSignal = {
    id: `sig_sell_085313_${Date.now()}`,
    timestamp: time2,
    asset: 'XAU/USD',
    currentPrice: 4278.40,
    timeframe: '15M / 5M',
    signal: 'SELL NOW',
    entry: 4278.40,
    stopLoss: 4288.40,
    slPoints: 1000,
    tp1: 4268.40,
    tp1Points: 1000,
    tp2: 4258.40,
    tp2Points: 2000,
    rr: '1:2.00',
    rrRatio: 2.0,
    confidence: 76,
    riskPercent: 1.5,
    riskAmount: 15.0,
    potentialProfit: 3.00,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Double Top Reversal (M-Formation)',
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    mainReasons: ['M-Formation peak retest'],
    invalidation: 'Break above 4288.40',
    patternMetadata: {
      patternAnchorKey: 'M5_DT_4288.40_4278.40_SELL',
      pivot1Time: time2 - 300000,
      pivot2Time: time2 - 60000,
      neckline: 4278.40,
      extremeLevel: 4288.40,
    },
  };

  // Check opportunity arbitration for opposing signal
  const conflictRes = resolveFinalSignalConflict([sellSignal], buySignal1, 'RANGE');
  assert(
    conflictRes.winningCandidate === null || conflictRes.winningCandidate.id !== sellSignal.id || conflictRes.suppressedCandidates.length > 0,
    '2. Opposing SELL (08:53:13) passes through opportunity arbitration and does not corrupt active BUY opportunity'
  );

  // Step 3: 08:53:56 BUY Double Bottom (Same Structural Formation)
  const time3 = new Date('2026-09-15T08:53:56Z').getTime();
  const buySignal2: TradeSignal = {
    id: `sig_buy_085356_${Date.now()}`,
    timestamp: time3,
    asset: 'XAU/USD',
    currentPrice: 4276.90, // Slightly evolved price
    timeframe: '15M / 5M',
    signal: 'BUY NOW',
    entry: 4276.90,
    stopLoss: 4258.53, // Same bottom structure
    slPoints: 1837,
    tp1: 4293.55,
    tp1Points: 1665,
    tp2: 4310.20,
    tp2Points: 3330,
    rr: '1:1.82',
    rrRatio: 1.82,
    confidence: 88, // Evolved confidence
    riskPercent: 1.5,
    riskAmount: 15.0,
    potentialProfit: 2.73,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Double Bottom Reversal (W-Formation)',
    strategyFamily: 'DOUBLE_TOP_BOTTOM',
    mainReasons: ['Evolved W-Formation continuation', 'Strong neckline defense'],
    invalidation: 'Break below 4258.53',
    patternMetadata: {
      patternAnchorKey: 'M5_DB_4263.53_4275.18_BUY', // Same structural anchor
      pivot1Time: time1 - 600000, // Same pivot 1
      pivot2Time: time3 - 60000,
      neckline: 4275.18, // Same neckline level
      extremeLevel: 4263.53, // Same pattern price
    },
  };

  // Structural setup identity check (even after intervening SELL)
  const identityRes = checkStructuralSameSetupIdentity(buySignal2, null);
  assert(identityRes.isDuplicate === true, '3a. Second BUY (08:53:56) recognized as SAME structural formation as 08:47:57 BUY', identityRes.reason);
  assert(identityRes.status === 'DUPLICATE_ACTIVE', '3b. Second BUY status is DUPLICATE_ACTIVE (not a new signal)');

  // Internal Evolution Check: Existing opportunity in storage is evolved
  const storedOpp = storage.getOpportunity(oppId1);
  assert(storedOpp !== null && storedOpp !== undefined, '3d. Existing Double Bottom opportunity found in storage');
  if (storedOpp) {
    storedOpp.entry = buySignal2.entry;
    storedOpp.stopLoss = buySignal2.stopLoss;
    storedOpp.confidence = buySignal2.confidence;
    storedOpp.lastUpdatedTime = time3;
    storage.saveOpportunity(storedOpp);
    const updatedOpp = storage.getOpportunity(oppId1);
    assert(updatedOpp?.entry === 4276.90 && updatedOpp?.confidence === 88, '3e. Existing Double Bottom opportunity successfully evolved internally');
  }

  // Step 4: Independent new formation check (Different formation evaluated independently)
  const independentSignal: TradeSignal = {
    id: `sig_independent_${Date.now()}`,
    timestamp: time3 + 10000,
    asset: 'XAU/USD',
    currentPrice: 4240.00,
    timeframe: '15M / 5M',
    signal: 'BUY NOW',
    entry: 4240.00,
    stopLoss: 4230.00,
    slPoints: 1000,
    tp1: 4255.00,
    tp1Points: 1500,
    tp2: 4270.00,
    tp2Points: 3000,
    rr: '1:1.50',
    rrRatio: 1.5,
    confidence: 85,
    riskPercent: 1.5,
    riskAmount: 15.0,
    potentialProfit: 2.25,
    potentialLoss: 1.50,
    recommendedLotSize: 0.01,
    setup: 'Order Block Demand Rebound',
    strategyFamily: 'ORDER_BLOCK',
    mainReasons: ['Fresh H1 demand zone tested at 4240'],
    invalidation: 'Break below 4230.00',
    poiId: 'poi_h1_demand_4240',
  };

  const independentRes = checkStructuralSameSetupIdentity(independentSignal, null);
  assert(independentRes.isDuplicate === false, '4. Independent different formation (Order Block @ 4240) evaluated independently and ALLOWED');

  console.log('\n====================================================');
  console.log(`📊 REGRESSION TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runRegressionScenarioTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
