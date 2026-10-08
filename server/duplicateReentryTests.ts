import { TradeSignal } from '../src/types.js';
import { checkStructuralSameSetupIdentity, inferStrategyFamily } from './tradeQualityEngine.js';

function createMockSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: `sig_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: Date.now(),
    asset: 'XAU/USD',
    signal: 'SELL NOW',
    currentPrice: 4294.52,
    entry: 4294.52,
    stopLoss: 4298.52,
    slPoints: 40,
    tp1: 4278.29,
    tp1Points: 162.3,
    tp1Rr: 4.05,
    tp1RrString: '1:4.05',
    tp2: 4276.25,
    tp2Points: 182.7,
    tp2Rr: 4.56,
    tp2RrString: '1:4.56',
    primaryTarget: 'TP1',
    rr: '1:4.05',
    rrRatio: 4.05,
    riskPercent: 1.5,
    riskAmount: 15,
    potentialProfit: 60.75,
    potentialLoss: 15,
    recommendedLotSize: 0.04,
    confidence: 85,
    strategyConfidence: 85,
    executionQualityScore: 88,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_5M_BEARISH_4298.52_4292.00',
    timeframe: '5M',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
    mainReasons: ['5M EMA20 rejection', '15M Bearish structure breakdown', 'Clear path to 4278.29 liquidity'],
    invalidation: 'Close above 4298.52',
    ...overrides,
  };
}

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, details?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`❌ [FAIL] ${testName}`, details || '');
    failedCount++;
  }
}

console.log('======================================================================');
console.log('RUNNING STRUCTURAL SAME-SETUP IDENTITY & RE-ENTRY TESTS');
console.log('======================================================================\n');

// TEST 1: Same strategy + same POI + same structural origin + same TP objectives + active trade -> BLOCK
{
  const activeTrade = createMockSignal({
    id: 'active_trade_1',
    signal: 'SELL NOW',
    entry: 4294.52,
    stopLoss: 4298.52,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_5M_BEARISH_4298',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
  });

  const candidate = createMockSignal({
    id: 'candidate_1',
    signal: 'SELL NOW',
    entry: 4292.25, // $2.27 away
    stopLoss: 4298.52,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_5M_BEARISH_4298',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
  });

  const res = checkStructuralSameSetupIdentity(candidate, activeTrade);
  assert(
    res.isDuplicate === true && res.status === 'DUPLICATE_ACTIVE_REENTRY' && res.details?.sameTargetObjective === true,
    'TEST 1: Same strategy + same POI + same structural origin + same TP objectives -> BLOCK DUPLICATE_ACTIVE_REENTRY',
    res
  );
}

// TEST 2: Same strategy + same POI + different structural origin/target -> evaluate as independent
{
  const activeTrade = createMockSignal({
    id: 'active_trade_2',
    signal: 'SELL NOW',
    entry: 4294.52,
    stopLoss: 4298.52,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_5M_BEARISH_4298',
  });

  const candidate = createMockSignal({
    id: 'candidate_2',
    signal: 'SELL NOW',
    entry: 4280.00,
    stopLoss: 4286.00, // Different structural origin
    tp1: 4265.00, // Different structural target objective
    tp2: 4258.00,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_5M_BEARISH_4286',
  });

  const res = checkStructuralSameSetupIdentity(candidate, activeTrade);
  assert(
    res.isDuplicate === false && res.status === 'QUALIFIED_SIGNAL',
    'TEST 2: Same strategy + different structural origin & target -> evaluate as independent',
    res
  );
}

// TEST 3: Different strategy family + independent POI + independent target -> allow normal evaluation
{
  const activeTrade = createMockSignal({
    id: 'active_trade_3',
    signal: 'SELL NOW',
    entry: 4294.52,
    stopLoss: 4298.52,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
  });

  const candidate = createMockSignal({
    id: 'candidate_3',
    signal: 'SELL NOW',
    entry: 4291.00,
    stopLoss: 4295.00,
    tp1: 4282.00,
    tp2: 4270.00,
    strategyFamily: 'LIQUIDITY_SWEEP',
    poiId: 'SWEEP_4295_BSL',
    setup: 'Liquidity Sweep Reversal',
  });

  const res = checkStructuralSameSetupIdentity(candidate, activeTrade);
  assert(
    res.isDuplicate === false && res.status === 'QUALIFIED_SIGNAL',
    'TEST 3: Different strategy family + independent POI + independent target -> allow normal evaluation',
    res
  );
}

// TEST 4: Same setup after price moves away and retraces -> BLOCK while original trade is OPEN
{
  const activeTrade = createMockSignal({
    id: 'active_trade_4',
    signal: 'SELL NOW',
    entry: 4294.52,
    stopLoss: 4298.52,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_SUPPLY_4298',
  });

  // Price dropped to 4283 and bounced back to 4292.25 inside the same supply zone
  const candidateRetrace = createMockSignal({
    id: 'candidate_4',
    signal: 'SELL NOW',
    currentPrice: 4292.25,
    entry: 4292.25,
    stopLoss: 4297.25,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_SUPPLY_4298',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
  });

  const res = checkStructuralSameSetupIdentity(candidateRetrace, activeTrade);
  assert(
    res.isDuplicate === true && res.status === 'DUPLICATE_ACTIVE_REENTRY',
    'TEST 4: Same setup after price moves away and retraces -> BLOCK while original trade is OPEN',
    res
  );
}

// TEST 5: Original trade CLOSED, same setup appears again -> allowed to undergo normal evaluation
{
  const candidate = createMockSignal({
    id: 'candidate_5',
    signal: 'SELL NOW',
    entry: 4292.25,
    stopLoss: 4297.25,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_SUPPLY_4298',
  });

  // When original trade is CLOSED, activeSignal is null
  const res = checkStructuralSameSetupIdentity(candidate, null);
  assert(
    res.isDuplicate === false && res.status === 'QUALIFIED_SIGNAL',
    'TEST 5: Original trade CLOSED (activeSignal is null) -> allowed to undergo normal evaluation',
    res
  );
}

// TEST 6: Active SELL + opposing BUY -> checkStructuralSameSetupIdentity returns non-duplicate (so Opposition Guard handles it)
{
  const activeSell = createMockSignal({
    id: 'active_trade_6',
    signal: 'SELL NOW',
    entry: 4294.52,
  });

  const opposingBuy = createMockSignal({
    id: 'candidate_6',
    signal: 'BUY NOW',
    entry: 4285.00,
  });

  const res = checkStructuralSameSetupIdentity(opposingBuy, activeSell);
  const isOpposingActiveTrade =
    (activeSell.signal.includes('SELL') && opposingBuy.signal.includes('BUY')) ||
    (activeSell.signal.includes('BUY') && opposingBuy.signal.includes('SELL'));

  assert(
    res.isDuplicate === false && isOpposingActiveTrade === true,
    'TEST 6: Active SELL + opposing BUY -> opposition guard strictly detects opposing trade',
    { res, isOpposingActiveTrade }
  );
}

// TEST 7: Same-direction candidate with entry > $1.50 away but identical structural identity -> MUST BLOCK
{
  const activeTrade = createMockSignal({
    id: 'active_trade_7',
    signal: 'SELL NOW',
    entry: 4294.52,
    stopLoss: 4298.52,
    tp1: 4278.29,
    tp2: 4276.25,
    strategyFamily: 'MARKET_STRUCTURE',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
  });

  const candidate = createMockSignal({
    id: 'candidate_7',
    signal: 'SELL NOW',
    entry: 4291.50, // Entry distance $3.02 (> $1.50)
    stopLoss: 4298.00, // Same structural origin
    tp1: 4278.29, // Exact same TP1
    tp2: 4276.25, // Exact same TP2
    strategyFamily: 'MARKET_STRUCTURE',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
  });

  const res = checkStructuralSameSetupIdentity(candidate, activeTrade);
  assert(
    res.isDuplicate === true &&
      res.status === 'DUPLICATE_ACTIVE_REENTRY' &&
      res.details?.entryDistance === 3.02 &&
      res.details?.sameTargetObjective === true,
    'TEST 7: Entry distance > $1.50 ($3.02) but identical structural identity -> MUST BLOCK DUPLICATE_ACTIVE_REENTRY',
    res
  );
}

// TEST 8: Existing active trade + genuinely independent same-direction setup -> MUST NOT be blocked solely because direction is the same
{
  const activeTrade = createMockSignal({
    id: 'active_trade_8',
    signal: 'BUY NOW',
    entry: 4250.00,
    stopLoss: 4245.00,
    tp1: 4265.00,
    tp2: 4275.00,
    strategyFamily: 'ORDER_BLOCK',
    poiId: 'OB_1H_BULLISH_4250',
    setup: 'Bullish 1H Order Block Defense',
  });

  const independentBuy = createMockSignal({
    id: 'candidate_8',
    signal: 'BUY NOW',
    entry: 4258.00,
    stopLoss: 4254.00, // Different SL / structural origin
    tp1: 4288.00, // Different target objective
    tp2: 4300.00,
    strategyFamily: 'RANGE_BREAKOUT_EXPANSION',
    poiId: 'EXPANSION_5M_4258',
    setup: 'Bullish Range Breakout Expansion',
  });

  const res = checkStructuralSameSetupIdentity(independentBuy, activeTrade);
  assert(
    res.isDuplicate === false && res.status === 'QUALIFIED_SIGNAL',
    'TEST 8: Genuinely independent same-direction setup -> MUST NOT be blocked solely because direction is the same',
    res
  );
}

console.log('\n======================================================================');
console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('======================================================================\n');

if (failedCount > 0) {
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED SUCCESSFULLY! 🎉');
  process.exit(0);
}
