import { validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { hasConfirmedReversalStructure } from './indicators.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

console.log('================================================================');
console.log('RUNNING M5-ONLY COUNTER-TREND BYPASS REGRESSION TEST SUITE');
console.log('================================================================\n');

const now = Date.now() - 100 * 300000;
const createCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed: boolean = true
): Candle => ({
  timestamp: now + i * 300000,
  open,
  high,
  low,
  close,
  volume: 1000,
  isClosed,
});

const defaultBrokerSpecs = {
  minRr: 1.0,
  minGoldSlPoints: 35,
  maxGoldSlPoints: 65,
  minSlPoints: 35,
  maxSlPoints: 65,
  spread: 0.2,
};

// Base Bullish HTF Indicators
const createStrongBullishInd1h = (): TechnicalIndicators => ({
  ema20: 4330,
  ema50: 4310,
  ema200: 4280,
  vwap: 4325,
  rsi14: 62,
  macd: { macd: 2.5, signal: 1.8, histogram: 0.7 },
  atr14: 5.0,
  bollingerBands: { upper: 4350, middle: 4320, lower: 4290 },
  swingHigh: 4345,
  swingLow: 4310,
  support: 4310,
  resistance: 4345,
  structure: 'BULLISH',
  marketRegime: 'STRONG_UPTREND',
  trendStructure: 'HH_HL',
  structureShift: 'None',
});

const createStrongBullishInd15m = (): TechnicalIndicators => ({
  ema20: 4332,
  ema50: 4322,
  ema200: 4300,
  vwap: 4330,
  rsi14: 58,
  macd: { macd: 1.2, signal: 0.8, histogram: 0.4 },
  atr14: 3.5,
  bollingerBands: { upper: 4342, middle: 4330, lower: 4318 },
  swingHigh: 4340,
  swingLow: 4320,
  support: 4320,
  resistance: 4340,
  structure: 'BULLISH',
  marketRegime: 'STRONG_UPTREND',
  trendStructure: 'HH_HL',
  structureShift: 'None',
});

// Base Bearish HTF Indicators
const createStrongBearishInd1h = (): TechnicalIndicators => ({
  ema20: 4310,
  ema50: 4330,
  ema200: 4360,
  vwap: 4315,
  rsi14: 38,
  macd: { macd: -2.5, signal: -1.8, histogram: -0.7 },
  atr14: 5.0,
  bollingerBands: { upper: 4350, middle: 4320, lower: 4290 },
  swingHigh: 4345,
  swingLow: 4300,
  support: 4300,
  resistance: 4345,
  structure: 'BEARISH',
  marketRegime: 'STRONG_DOWNTREND',
  trendStructure: 'LH_LL',
  structureShift: 'None',
});

const createStrongBearishInd15m = (): TechnicalIndicators => ({
  ema20: 4308,
  ema50: 4318,
  ema200: 4340,
  vwap: 4310,
  rsi14: 42,
  macd: { macd: -1.2, signal: -0.8, histogram: -0.4 },
  atr14: 3.5,
  bollingerBands: { upper: 4340, middle: 4318, lower: 4296 },
  swingHigh: 4330,
  swingLow: 4300,
  support: 4300,
  resistance: 4330,
  structure: 'BEARISH',
  marketRegime: 'STRONG_DOWNTREND',
  trendStructure: 'LH_LL',
  structureShift: 'None',
});

const createStrongBullishInd5m = (): TechnicalIndicators => ({
  ema20: 4333,
  ema50: 4328,
  ema200: 4315,
  vwap: 4332,
  rsi14: 56,
  macd: { macd: 0.8, signal: 0.5, histogram: 0.3 },
  atr14: 2.0,
  bollingerBands: { upper: 4340, middle: 4330, lower: 4320 },
  swingHigh: 4338,
  swingLow: 4322,
  support: 4322,
  resistance: 4338,
  structure: 'BULLISH',
  marketRegime: 'STRONG_UPTREND',
  trendStructure: 'HH_HL',
  structureShift: 'None',
});

function createCandleArray(basePrice: number, count: number = 20): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    candles.push(createCandle(i, basePrice, basePrice + 1.0, basePrice - 1.0, basePrice + 0.2));
  }
  return candles;
}

// ============================================================================
// TEST A: M5-only bearish reversal against strong bullish HTF
// ============================================================================
console.log('[TEST A] M5-only Bearish Reversal against Strong Bullish HTF (1H/15M STRONG_UPTREND)');
{
  const ind1h = createStrongBullishInd1h();
  const ind15m = createStrongBullishInd15m(); // No M15 structure shift!
  const ind5m: TechnicalIndicators = {
    ...createStrongBullishInd15m(),
    atr14: 2.0,
    structureShift: 'CHOCH_BEARISH', // M5-ONLY bearish shift
  };

  const c1h = createCandleArray(4330, 20);
  const c15m = createCandleArray(4330, 20);
  const c5m = createCandleArray(4330, 20);

  // Last 5M candle gives a valid price action trigger (rejection wick / displacement)
  c5m[19] = createCandle(19, 4333.0, 4334.0, 4329.5, 4330.0);

  const sellCandidate = {
    id: 'CAND_M5_BEAR_01',
    direction: 'SELL' as const,
    entry: 4330.0,
    stopLoss: 4334.5, // 45 pts SL
    tp1: 4320.0,      // 100 pts TP1 -> 2.22R
    setupName: 'Order Block Retest',
    strategyFamily: 'ORDER_BLOCK' as const,
    poiPrice: 4332.0,
    poiMeta: { top: 4333.0, bottom: 4331.0, poiPrice: 4332.0, type: 'ORDER_BLOCK' as const },
  };

  const isConfirmed = hasConfirmedReversalStructure('SELL', ind15m, ind5m, c15m, c5m, 3.5);
  console.log(`  [Trace Test A] hasConfirmedReversalStructure('SELL') = ${isConfirmed}`);

  const validation = validateTradeSignalCandidate(sellCandidate, {
    currentPrice: 4330.0,
    candles5m: c5m,
    candles15m: c15m,
    candles1h: c1h,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  console.log(`  [Trace Test A] validateTradeSignalCandidate.isValid = ${validation.isValid}, rejectionReason = ${validation.rejectionReason}`);

  assert(
    !isConfirmed,
    'hasConfirmedReversalStructure MUST return FALSE for M5-only bearish shift against strong bullish HTF'
  );
  assert(
    !validation.isValid,
    'Candidate SELL in strong bullish HTF with M5-only reversal MUST be REJECTED'
  );
  assert(
    (validation.rejectionReason || '').includes('HTF_CONTRADICTION'),
    'Rejection reason MUST cite HTF_CONTRADICTION'
  );
}

// ============================================================================
// TEST B: M5-only bullish reversal against strong bearish HTF
// ============================================================================
console.log('\n[TEST B] M5-only Bullish Reversal against Strong Bearish HTF (1H/15M STRONG_DOWNTREND)');
{
  const ind1h = createStrongBearishInd1h();
  const ind15m = createStrongBearishInd15m(); // No M15 structure shift!
  const ind5m: TechnicalIndicators = {
    ...createStrongBearishInd15m(),
    atr14: 2.0,
    structureShift: 'CHOCH_BULLISH', // M5-ONLY bullish shift
  };

  const c1h = createCandleArray(4310, 20);
  const c15m = createCandleArray(4310, 20);
  const c5m = createCandleArray(4310, 20);

  c5m[19] = createCandle(19, 4307.0, 4310.5, 4306.0, 4310.0);

  const buyCandidate = {
    id: 'CAND_M5_BULL_01',
    direction: 'BUY' as const,
    entry: 4310.0,
    stopLoss: 4305.5, // 45 pts SL
    tp1: 4320.0,      // 100 pts TP1 -> 2.22R
    setupName: 'Order Block Retest',
    strategyFamily: 'ORDER_BLOCK' as const,
    poiPrice: 4308.0,
    poiMeta: { top: 4309.0, bottom: 4307.0, poiPrice: 4308.0, type: 'ORDER_BLOCK' as const },
  };

  const isConfirmed = hasConfirmedReversalStructure('BUY', ind15m, ind5m, c15m, c5m, 3.5);
  console.log(`  [Trace Test B] hasConfirmedReversalStructure('BUY') = ${isConfirmed}`);

  const validation = validateTradeSignalCandidate(buyCandidate, {
    currentPrice: 4310.0,
    candles5m: c5m,
    candles15m: c15m,
    candles1h: c1h,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  console.log(`  [Trace Test B] validateTradeSignalCandidate.isValid = ${validation.isValid}, rejectionReason = ${validation.rejectionReason}`);

  assert(
    !isConfirmed,
    'hasConfirmedReversalStructure MUST return FALSE for M5-only bullish shift against strong bearish HTF'
  );
  assert(
    !validation.isValid,
    'Candidate BUY in strong bearish HTF with M5-only reversal MUST be REJECTED'
  );
  assert(
    (validation.rejectionReason || '').includes('HTF_CONTRADICTION'),
    'Rejection reason MUST cite HTF_CONTRADICTION'
  );
}

// ============================================================================
// TEST C: M15 confirmed reversal should be allowed
// ============================================================================
console.log('\n[TEST C] M15 Confirmed Reversal (15M CHOCH_BEARISH) counter-trend should be ALLOWED');
{
  const ind1h = createStrongBullishInd1h();
  const ind15m: TechnicalIndicators = {
    ...createStrongBullishInd15m(),
    structureShift: 'CHOCH_BEARISH', // Confirmed 15M reversal!
  };
  const ind5m: TechnicalIndicators = {
    ...createStrongBullishInd15m(),
    atr14: 2.0,
    structureShift: 'CHOCH_BEARISH',
  };

  const c1h = createCandleArray(4330, 20);
  const c15m = createCandleArray(4330, 20);
  const c5m = createCandleArray(4330, 20);

  c5m[19] = createCandle(19, 4333.0, 4334.0, 4329.5, 4330.0);

  const sellCandidate = {
    id: 'CAND_M15_BEAR_01',
    direction: 'SELL' as const,
    entry: 4330.0,
    stopLoss: 4334.5,
    tp1: 4320.0,
    setupName: 'Countertrend Order Block Retest',
    strategyFamily: 'ORDER_BLOCK' as const,
    poiPrice: 4332.0,
    poiMeta: { top: 4333.0, bottom: 4331.0, poiPrice: 4332.0, type: 'ORDER_BLOCK' as const },
  };

  const isConfirmed = hasConfirmedReversalStructure('SELL', ind15m, ind5m, c15m, c5m, 3.5);
  console.log(`  [Trace Test C] hasConfirmedReversalStructure('SELL') = ${isConfirmed}`);

  const validation = validateTradeSignalCandidate(sellCandidate, {
    currentPrice: 4330.0,
    candles5m: c5m,
    candles15m: c15m,
    candles1h: c1h,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  console.log(`  [Trace Test C] validateTradeSignalCandidate.isValid = ${validation.isValid}, rejectionReason = ${validation.rejectionReason}`);

  assert(
    isConfirmed,
    'hasConfirmedReversalStructure MUST return TRUE when M15 has confirmed CHOCH_BEARISH'
  );
  assert(
    validation.isValid,
    'Candidate SELL with confirmed M15 reversal MUST be VALID'
  );
}

// ============================================================================
// TEST D: H1/M15 trend + no reversal confirmation at all
// ============================================================================
console.log('\n[TEST D] H1/M15 Trend + No Reversal Confirmation at all');
{
  const ind1h = createStrongBullishInd1h();
  const ind15m = createStrongBullishInd15m();
  const ind5m = createStrongBullishInd5m(); // structureShift = 'None'

  const c1h = createCandleArray(4330, 20);
  const c15m = createCandleArray(4330, 20);
  const c5m = createCandleArray(4330, 20);

  c5m[19] = createCandle(19, 4333.0, 4334.0, 4329.5, 4330.0);

  const sellCandidate = {
    id: 'CAND_NO_REV_01',
    direction: 'SELL' as const,
    entry: 4330.0,
    stopLoss: 4334.5,
    tp1: 4320.0,
    setupName: 'Order Block Retest',
    strategyFamily: 'ORDER_BLOCK' as const,
    poiPrice: 4332.0,
    poiMeta: { top: 4333.0, bottom: 4331.0, poiPrice: 4332.0, type: 'ORDER_BLOCK' as const },
  };

  const isConfirmed = hasConfirmedReversalStructure('SELL', ind15m, ind5m, c15m, c5m, 3.5);
  console.log(`  [Trace Test D] hasConfirmedReversalStructure('SELL') = ${isConfirmed}`);

  const validation = validateTradeSignalCandidate(sellCandidate, {
    currentPrice: 4330.0,
    candles5m: c5m,
    candles15m: c15m,
    candles1h: c1h,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  console.log(`  [Trace Test D] validateTradeSignalCandidate.isValid = ${validation.isValid}, rejectionReason = ${validation.rejectionReason}`);

  assert(
    !isConfirmed,
    'hasConfirmedReversalStructure MUST return FALSE when no structure shift exists'
  );
  assert(
    !validation.isValid,
    'Candidate SELL in strong bullish HTF with NO reversal confirmation MUST be REJECTED'
  );
  assert(
    (validation.rejectionReason || '').includes('HTF_CONTRADICTION'),
    'Rejection reason MUST cite HTF_CONTRADICTION'
  );
}

// ============================================================================
// TEST E: Direct evaluation of hasConfirmedReversalStructure
// ============================================================================
console.log('\n[TEST E] Direct Evaluation of hasConfirmedReversalStructure() for M5-only shift');
{
  const ind15mBullish = createStrongBullishInd15m();
  const ind5mBearishShift: TechnicalIndicators = {
    ...createStrongBullishInd15m(),
    structureShift: 'CHOCH_BEARISH',
  };

  const c15m = createCandleArray(4330, 20);
  const c5m = createCandleArray(4330, 20);

  const bearResult = hasConfirmedReversalStructure('SELL', ind15mBullish, ind5mBearishShift, c15m, c5m, 3.5);
  console.log(`  [Direct Test E - Bearish] Bullish HTF + M5 CHOCH_BEARISH -> hasConfirmedReversalStructure = ${bearResult}`);
  assert(
    !bearResult,
    'hasConfirmedReversalStructure("SELL") MUST be false for M5-only bearish shift'
  );

  const ind15mBearish = createStrongBearishInd15m();
  const ind5mBullishShift: TechnicalIndicators = {
    ...createStrongBearishInd15m(),
    structureShift: 'CHOCH_BULLISH',
  };

  const bullResult = hasConfirmedReversalStructure('BUY', ind15mBearish, ind5mBullishShift, c15m, c5m, 3.5);
  console.log(`  [Direct Test E - Bullish] Bearish HTF + M5 CHOCH_BULLISH -> hasConfirmedReversalStructure = ${bullResult}`);
  assert(
    !bullResult,
    'hasConfirmedReversalStructure("BUY") MUST be false for M5-only bullish shift'
  );
}

console.log('\n================================================================');
console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
