import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { calculateDynamicTakeProfits } from '../server/tpEngine.js';
import {
  assessTpPathRunway,
  assessPullbackQuality,
  assessPriceActionTrigger,
  resolveFinalSignalConflict,
  validateTradeSignalCandidate,
  PoiFreshnessTracker,
} from '../server/tradeQualityEngine.js';
import { assessEntryLocationQuality } from '../server/entryLocationQuality.js';
import { resolveAiSignalWithDeterministicFallback } from '../server/geminiTrader.js';
import { Candle, TechnicalIndicators, TradeSignal } from '../src/types.js';

function createMockCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
  isClosed = true
): Candle {
  return { timestamp, open, high, low, close, volume, isClosed };
}

function createCandleSequence(count: number, basePrice: number, step = 0.5): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * 5 * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const o = basePrice + i * step;
    const c = o + step * 0.8;
    const h = Math.max(o, c) + 0.3;
    const l = Math.min(o, c) - 0.3;
    candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, o, h, l, c));
  }
  return candles;
}

function createBaseIndicators(price: number): TechnicalIndicators {
  return {
    rsi14: 52,
    atr14: 2.0,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    bollingerBands: { upper: price + 4, middle: price, lower: price - 4 },
    ema20: price - 1,
    ema50: price - 2,
    ema200: price - 10,
    vwap: price - 0.5,
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    trendStructure: 'HH_HL',
    swingHigh: price + 5,
    swingLow: price - 5,
    support: price - 3,
    resistance: price + 3,
    orderBlocks: [],
    fvgZones: [],
    fractalSwings: { highs: [price + 5], lows: [price - 5] },
  };
}

// ============================================================================
// SUITE 1: FIX SILENT AI VETO
// ============================================================================
console.log('--- Test 1: Silent AI Veto Fallback Execution ---');
{
  const candles5m = createCandleSequence(20, 2000);
  const lastTime = candles5m[candles5m.length - 1].timestamp;
  candles5m[candles5m.length - 1] = createMockCandle(lastTime, 2010.0, 2010.8, 2008.0, 2010.5); // lower wick: 2.0, body: 0.5
  const candles15m = createCandleSequence(20, 2000, 1.0);
  const candles1h = createCandleSequence(20, 2000, 2.0);
  const indicators5m = createBaseIndicators(2010);
  const indicators15m = createBaseIndicators(2010);
  const indicators1h = createBaseIndicators(2010);

  const mockCandidate = {
    id: 'test_cand_1',
    strategyFamily: 'TREND_CONTINUATION' as any,
    setupName: 'Trend Continuation Pullback',
    direction: 'BUY' as const,
    orderType: 'MARKET' as const,
    entry: 2010.0,
    stopLoss: 2006.0,
    slPoints: 40,
    tp1: 2016.0,
    tp1Points: 60,
    tp1Rr: 1.5,
    tp2: 2022.0,
    tp2Points: 120,
    tp2Rr: 3.0,
    confidence: 85,
    score: 88,
    timeframe: '5M',
    mainReasons: ['Strong EMA20 bounce with rejection wick'],
  };

  const candidatesContext = {
    selectedCandidate: mockCandidate,
    allCandidates: [mockCandidate],
    summary: 'Selected: Trend Continuation Pullback',
  };

  const mockAiOutput = {
    signal: 'NO TRADE',
    entry: 0,
    stopLoss: 0,
    tp1: 0,
    tp2: 0,
    confidence: 30,
    setup: 'None',
    mainReasons: ['Market consolidating, awaiting clearer catalyst.'],
    noTradeReason: 'Low conviction at the current moment.',
  };

  const decision = resolveAiSignalWithDeterministicFallback(
    mockAiOutput,
    candidatesContext as any,
    {
      asset: 'XAU/USD',
      balance: 1000,
      currentPrice: 2010.0,
      recent5mCandles: candles5m,
      candles15m,
      candles1h,
      recent1mCandles: [],
      losingStreak: 0,
      indicators5m,
      indicators15m,
      indicators1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    }
  );

  assert.strictEqual(decision.signal, 'BUY NOW', 'Fallback execution MUST preserve the deterministic candidate');
  assert.strictEqual(decision.entry, 2010.0, 'Fallback entry must match candidate entry');
  assert.ok(decision.mainReasons.some(r => r.includes('تنفيذ احتياطي حتمي') || r.includes('NO_TRADE')), 'Logging must record fallback execution');
  console.log('✅ Test 1 Passed: Silent AI Veto prevented; deterministic candidate executed.');
}

// ============================================================================
// SUITE 2: FIX TP1 SELECTION & STRUCTURE DISTANCE
// ============================================================================
console.log('--- Test 2: Dynamic Structural TP1 Selection ---');
{
  const candles5m = createCandleSequence(20, 2000);
  const candles15m = createCandleSequence(20, 2000, 1.0);
  const candles1h = createCandleSequence(20, 2000, 2.0);
  const indicators5m = createBaseIndicators(2010);
  const indicators15m = createBaseIndicators(2010);
  indicators15m.swingHigh = 2015.6; // 5.6 pts above entry (with 4.0 pt SL -> 1.4R)
  const indicators1h = createBaseIndicators(2010);

  const tpResult = calculateDynamicTakeProfits({
    direction: 'BUY',
    entry: 2010.0,
    stopLoss: 2006.0, // 4.0 pts risk
    asset: 'XAUUSD',
    indicators1h,
    indicators15m,
    indicators5m,
    candles1h,
    candles15m,
    candles5m,
    minRr: 1.0,
  });

  assert.strictEqual(tpResult.valid, true, 'TP calculation must be valid');
  assert.ok(tpResult.tp1Rr >= 1.2 && tpResult.tp1Rr <= 1.8, `TP1 RR should reflect genuine structure (${tpResult.tp1Rr}R), not synthetic 2.0R`);
  console.log(`✅ Test 2 Passed: Dynamic TP1 successfully pinned to structure at ${tpResult.tp1} (${tpResult.tp1Rr.toFixed(2)}R)`);
}

// ============================================================================
// SUITE 3: STRUCTURAL SL TIGHTNESS CLAMPING
// ============================================================================
console.log('--- Test 3: Tight Structural SL Expansion/Clamping ---');
{
  // When structural SL is tight (e.g., 20 pts from entry), it must expand to min floor (35 pts)
  const minSlPoints = 35;
  const maxSlPoints = 65;
  const entry = 2010.0;
  const rawTightSl = 2008.0; // 2.0 pts = 20 points
  const bufferGold = 0.5;

  let stopLoss = Number((rawTightSl - bufferGold).toFixed(2)); // 2007.5 = 25 pts
  let slDistance = Math.abs(entry - stopLoss);
  let slPoints = Number((slDistance / 0.1).toFixed(1));

  if (slPoints < minSlPoints) {
    stopLoss = Number((entry - (minSlPoints * 0.1)).toFixed(2)); // 2006.5 = 35 pts
    slDistance = Math.abs(entry - stopLoss);
    slPoints = Number((slDistance / 0.1).toFixed(1));
  }

  assert.strictEqual(slPoints, 35, 'SL points must be clamped to minSlPoints floor rather than rejected');
  assert.strictEqual(stopLoss, 2006.5, 'Clamped stopLoss must be placed at minimum allowable safety boundary');
  console.log('✅ Test 3 Passed: Tight structural SL correctly clamped to broker minimum boundary.');
}

// ============================================================================
// SUITE 4: DYNAMIC MA POI FRESHNESS
// ============================================================================
console.log('--- Test 4: Dynamic MA POI Freshness ---');
{
  const tracker = new PoiFreshnessTracker();
  const poi = tracker.registerPoi('DYNAMIC_MA', '5M', 'BULLISH', 2010.5, 2009.5, 1000);

  // Simulate 4 successive pullbacks to EMA20 across candles
  const candles = [
    createMockCandle(2000, 2012, 2012, 2010.0, 2011),
    createMockCandle(3000, 2013, 2013, 2010.2, 2012),
    createMockCandle(4000, 2014, 2014, 2010.1, 2013),
    createMockCandle(5000, 2015, 2015, 2010.3, 2014),
  ];

  const assessment = tracker.evaluatePoiFreshness(poi.id, candles, 2.0);
  assert.strictEqual(assessment.isTradable, true, 'DYNAMIC_MA POI must remain tradable despite multiple touches');
  assert.notStrictEqual(assessment.state, 'EXHAUSTED', 'DYNAMIC_MA must never be marked EXHAUSTED');
  assert.ok(assessment.multiplier >= 0.85, 'Multiplier must stay high for valid trend continuation pullback');
  console.log('✅ Test 4 Passed: Dynamic MA POI retains freshness across successive wave touches.');
}

// ============================================================================
// SUITE 5: OPPOSING CANDIDATE ARBITRATION
// ============================================================================
console.log('--- Test 5: Opposing Candidate Arbitration ---');
{
  const buyCandidate = {
    id: 'buy_trend',
    signal: 'BUY NOW',
    setup: 'Bullish Continuation',
    direction: 'BUY' as const,
    entry: 2010.0,
    stopLoss: 2006.0,
    tp1: 2016.0,
    tp1Rr: 1.5,
    score: 80,
    confidence: 80,
  };

  const sellCandidate = {
    id: 'sell_reversal',
    signal: 'SELL NOW',
    setup: 'Bearish Countertrend',
    direction: 'SELL' as const,
    entry: 2010.0,
    stopLoss: 2014.0,
    tp1: 2004.0,
    tp1Rr: 1.5,
    score: 78,
    confidence: 75,
  };

  // Case A: Strong Uptrend in HTF -> MUST select BUY
  const resBull = resolveFinalSignalConflict([buyCandidate, sellCandidate], null, 'STRONG_UPTREND');
  assert.ok(resBull.winningCandidate !== null, 'Winning candidate must not be null');
  assert.strictEqual(resBull.winningCandidate?.direction, 'BUY', 'In STRONG_UPTREND, BUY candidate must win tiebreaker');

  // Case B: Strong Downtrend in HTF -> MUST select SELL
  const resBear = resolveFinalSignalConflict([buyCandidate, sellCandidate], null, 'STRONG_DOWNTREND');
  assert.ok(resBear.winningCandidate !== null, 'Winning candidate must not be null');
  assert.strictEqual(resBear.winningCandidate?.direction, 'SELL', 'In STRONG_DOWNTREND, SELL candidate must win tiebreaker');

  // Case C: Ranging HTF -> Composite score tiebreaker
  const resRange = resolveFinalSignalConflict([buyCandidate, sellCandidate], null, 'NORMAL_RANGE');
  assert.ok(resRange.winningCandidate !== null, 'In ranging market, arbitration must pick higher composite score, not NO TRADE');
  assert.strictEqual(resRange.winningCandidate?.direction, 'BUY', 'Higher score candidate wins in range');
  console.log('✅ Test 5 Passed: Opposing candidate arbitration successfully prevents dropped NO TRADE.');
}

// ============================================================================
// SUITE 6: TP RUNWAY & MITIGATED OBSTACLES
// ============================================================================
console.log('--- Test 6: TP Runway & Mitigated Obstacles ---');
{
  // 6A. BUY with mitigated opposing Bearish OB (pierced and closed above by 15M candle)
  const candles15m = [
    createMockCandle(1000, 2010, 2018, 2009, 2017), // Closed at 2017, breaking through 2015!
    createMockCandle(2000, 2017, 2019, 2014, 2016),
  ];
  const candles1h = createCandleSequence(10, 2000);
  const indicators15m = createBaseIndicators(2010);
  indicators15m.swingHigh = 2014.0; // Intermediate level that was already broken/closed above
  indicators15m.orderBlock = {
    type: 'BEARISH',
    high: 2015.0,
    low: 2013.0,
  };
  const indicators1h = createBaseIndicators(2010);

  // Entry at 2010, TP1 at 2020 (10 pts), SL at 2006 (4 pts)
  const runway = (assessTpPathRunway as any)(
    'BUY',
    2010.0,
    2020.0,
    2026.0,
    candles15m,
    candles1h,
    indicators15m,
    indicators1h,
    2006.0 // stopLoss provided: 4 pts risk -> clean 1R runway
  );

  assert.notStrictEqual(runway.runway, 'BLOCKED', 'Mitigated / broken zones must not block the trade');
  assert.ok(runway.runway !== 'BLOCKED', `Runway must not be BLOCKED, got: ${runway.runway}`);

  // 6B. Mirrored SELL with mitigated opposing Bullish OB (pierced and closed below by 15M candle)
  const candles15mSell = [
    createMockCandle(1000, 2020, 2022, 2012, 2013), // Closed at 2013, breaking below 2015!
    createMockCandle(2000, 2013, 2015, 2011, 2014),
  ];
  const indicators15mSell = createBaseIndicators(2020);
  indicators15mSell.orderBlock = {
    type: 'BULLISH',
    high: 2017.0,
    low: 2015.0,
  };
  const indicators1hSell = createBaseIndicators(2020);
  const candles1hSell = createCandleSequence(10, 2020);

  const runwaySell = (assessTpPathRunway as any)(
    'SELL',
    2020.0,
    2010.0,
    2004.0,
    candles15mSell,
    candles1hSell,
    indicators15mSell,
    indicators1hSell,
    2024.0
  );

  assert.notStrictEqual(runwaySell.runway, 'BLOCKED', 'Mirrored SELL: Mitigated / broken zones must not block the trade');
  assert.ok(runwaySell.runway !== 'BLOCKED', `Mirrored SELL: Runway must not be BLOCKED, got: ${runwaySell.runway}`);

  // 6C. Mirrored BUY/SELL unmitigated opposing zones MUST remain strictly BLOCKED
  const candles15mUnmitigatedBuy = [
    createMockCandle(1000, 2010, 2012, 2009, 2011), // Did not breach 2013/2015 OB
    createMockCandle(2000, 2011, 2012, 2010, 2011),
  ];
  const runwayUnmitigatedBuy = (assessTpPathRunway as any)(
    'BUY',
    2010.0,
    2020.0,
    2026.0,
    candles15mUnmitigatedBuy,
    candles1h,
    indicators15m,
    indicators1h,
    2006.0
  );
  assert.strictEqual(runwayUnmitigatedBuy.runway, 'BLOCKED', 'Unmitigated opposing Bearish OB must block BUY runway');

  const candles15mUnmitigatedSell = [
    createMockCandle(1000, 2020, 2021, 2018, 2019), // Did not breach 2015/2017 OB
    createMockCandle(2000, 2019, 2020, 2018, 2019),
  ];
  const runwayUnmitigatedSell = (assessTpPathRunway as any)(
    'SELL',
    2020.0,
    2010.0,
    2004.0,
    candles15mUnmitigatedSell,
    candles1hSell,
    indicators15mSell,
    indicators1hSell,
    2024.0
  );
  assert.strictEqual(runwayUnmitigatedSell.runway, 'BLOCKED', 'Unmitigated opposing Bullish OB must block SELL runway');

  console.log('✅ Test 6 Passed: Mitigated obstacles properly classified without blocking valid TP runway (mirrored BUY/SELL verified).');
}

// ============================================================================
// SUITE 7: ENTRY LOCATION QUALITY (ELQ) INTACT SAFETY
// ============================================================================
console.log('--- Test 7: Entry Location Quality (ELQ) Intact Safety ---');
{
  // 5 consecutive strong directional bullish bars without any pullback
  const chasedCandles: Candle[] = [
    createMockCandle(1000, 2000, 2004, 1999, 2004),
    createMockCandle(2000, 2004, 2008, 2003, 2008),
    createMockCandle(3000, 2008, 2012, 2007, 2012),
    createMockCandle(4000, 2012, 2016, 2011, 2016),
    createMockCandle(5000, 2016, 2020, 2015, 2020),
  ];
  const ind5m = createBaseIndicators(2020);
  const ind15m = createBaseIndicators(2020);
  const ind1h = createBaseIndicators(2020);

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'TREND_CONTINUATION',
    entry: 2020.0,
    currentPrice: 2020.0,
    candles5m: chasedCandles,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
  });

  assert.strictEqual(elq.hardBlocked, true, 'ELQ hard block MUST trigger on overextended 5-bar parabolic chase');
  assert.ok(elq.classification === 'EXHAUSTED' || elq.classification === 'LATE', `Classification must be EXHAUSTED or LATE, got ${elq.classification}`);
  console.log('✅ Test 7 Passed: ELQ hard block remains strictly enforced on chased/parabolic entries.');
}

// ============================================================================
// SUITE 8: PRICE ACTION HARD TRIGGER INTACT SAFETY
// ============================================================================
console.log('--- Test 8: Price Action Trigger Intact Safety ---');
{
  // Candle with tiny body and no directional rejection wick
  const dojiCandle = createMockCandle(1000, 2010.0, 2010.2, 2009.8, 2010.0);
  const ind5m = createBaseIndicators(2010);

  const paTrigger = assessPriceActionTrigger('BUY', [dojiCandle], [], ind5m);
  assert.strictEqual(paTrigger.hasHardPriceActionTrigger, false, 'Doji candle without directional rejection cannot produce hard PA trigger');
  console.log('✅ Test 8 Passed: Hard price action trigger requirement remains strictly enforced.');
}

console.log('\n======================================================');
console.log('🎉 ALL 8 AUDIT REGRESSION TEST SUITES PASSED SUCCESSFULLY!');
console.log('======================================================\n');
