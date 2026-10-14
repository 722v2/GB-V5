import { validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { TechnicalIndicators, Candle, StrategyFamily } from '../src/types.js';

console.log('================================================================');
console.log('    TREND CONTINUATION QUALITY GATE REGRESSION TEST SUITE       ');
console.log('================================================================');

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`✗ FAIL: ${testName}`);
    if (detail) console.error(`  Details: ${detail}`);
    failedTests++;
  }
}

// Mock technical indicators helpers
function createBaseIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    ema20: 4345.0,
    ema50: 4350.0,
    ema200: 4360.0,
    vwap: 4346.0,
    rsi14: 45,
    macd: { macd: -0.5, signal: -0.3, histogram: -0.2 },
    atr14: 3.5,
    bollingerBands: { upper: 4360, middle: 4345, lower: 4330 },
    swingHigh: 4355.0,
    swingLow: 4330.0,
    support: 4330.0,
    resistance: 4355.0,
    structure: 'BEARISH',
    marketRegime: 'STRONG_DOWNTREND',
    premiumDiscountZone: 'PREMIUM',
    orderBlock: { type: 'BEARISH', high: 4350, low: 4345 },
    fvg: { type: 'BEARISH', top: 4348, bottom: 4346 },
    ...overrides,
  };
}

function createClosedCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  offsetMinutes = 0
): Candle {
  return {
    timestamp: Date.now() - offsetMinutes * 60000,
    open,
    high,
    low,
    close,
    volume: 100,
    isClosed: true,
  };
}

function createCandleSeries(count: number, lastCandle: Candle): Candle[] {
  const candles: Candle[] = [];
  for (let i = count - 1; i >= 1; i--) {
    candles.push(createClosedCandle(lastCandle.open, lastCandle.high, lastCandle.low, lastCandle.close, i * 5));
  }
  candles.push(lastCandle);
  return candles;
}

const basePoi = {
  poiOriginPrice: 4346.0,
  poiPrice: 4346.0,
  poiMeta: {
    type: 'ORDER_BLOCK' as const,
    top: 4348.0,
    bottom: 4344.0,
    timeframe: '15M' as const,
  },
};

async function runAllTests() {
  const baseIndicators5m = createBaseIndicators();
  const baseIndicators15m = createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' });
  const baseIndicators1h = createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' });

  const default15m = createCandleSeries(20, createClosedCandle(4346, 4348, 4344, 4345));
  const default1h = createCandleSeries(20, createClosedCandle(4350, 4355, 4342, 4345));

  // ---------------------------------------------------------------------------
  // TEST 1: Historical #10020 Replay (SELL @ 4344.68, SL 4349.19, TP1 4340.00, R:R 1.04R)
  // Context: H1 Ranging, M15 Bearish, Zone DISCOUNT, OB BULLISH_OB, FVG BULLISH_FVG
  // Expected: BLOCKED by Trend Continuation Quality Gate
  // ---------------------------------------------------------------------------
  {
    const cand10020 = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4344.68,
      stopLoss: 4349.19,
      tp1: 4340.00,
      slPoints: 45.1,
      tp1Points: 46.8,
      tp1Rr: 1.0377,
      confidence: 78,
      factorSnapshot: {
        factors: {
          htfStructure: 'RANGING',
          zone: 'DISCOUNT',
          orderBlock: 'BULLISH_OB',
          fvg: 'BULLISH_FVG',
        },
      },
    };

    const ind1h = createBaseIndicators({ marketRegime: 'NORMAL_RANGE', structure: 'RANGING' });
    const ind15m = createBaseIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4342, low: 4338 },
      fvg: { type: 'BULLISH', top: 4344, bottom: 4340 },
    });
    const c5m = createCandleSeries(20, createClosedCandle(4343.5, 4345.0, 4343.0, 4344.68));

    const val = validateTradeSignalCandidate(cand10020, {
      currentPrice: 4344.68,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid,
      'TEST 1: Historical #10020 Replay - MUST BE BLOCKED',
      `Expected isValid=false, got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Trend Continuation + H1 Ranging + Low R:R (< 1.25R)
  // Expected: REJECTED with TREND_CONTINUATION_HTF_QUALITY_INSUFFICIENT
  // ---------------------------------------------------------------------------
  {
    const candLowRr = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4350.0, // 5.0 SL
      tp1: 4339.0,     // 6.0 TP1 -> 1.20R (satisfies universal 1.15R, fails H1 ranging 1.25R)
      slPoints: 50,
      tp1Points: 60,
      tp1Rr: 1.20,
      confidence: 75,
    };

    const ind1h = createBaseIndicators({ marketRegime: 'NORMAL_RANGE', structure: 'RANGING' });
    const ind15m = createBaseIndicators({ marketRegime: 'WEAK_DOWNTREND', structure: 'BEARISH' });
    const c5m = createCandleSeries(20, createClosedCandle(4347.0, 4348.0, 4344.0, 4345.0));

    const val = validateTradeSignalCandidate(candLowRr, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid && (val.rejectionReason?.includes('TREND_CONTINUATION_HTF_QUALITY_INSUFFICIENT') ?? false),
      'TEST 2: Trend Continuation + H1 Ranging + Low R:R (< 1.25R) - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Trend Continuation + H1 Ranging + Valid R:R (>= 1.25R) + Closed M5 Rejection
  // Expected: ACCEPTED (isValid === true)
  // ---------------------------------------------------------------------------
  {
    const candValid = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4349.0, // 4.0 SL
      tp1: 4339.0,     // 6.0 TP1 -> 1.50R
      slPoints: 40,
      tp1Points: 60,
      tp1Rr: 1.50,
      confidence: 82,
    };

    const ind1h = createBaseIndicators({ marketRegime: 'NORMAL_RANGE', structure: 'RANGING' });
    const ind15m = createBaseIndicators({ marketRegime: 'WEAK_DOWNTREND', structure: 'BEARISH' });
    // Strong top rejection wick candle
    const c5m = createCandleSeries(20, createClosedCandle(4345.5, 4349.0, 4344.5, 4345.0));

    const val = validateTradeSignalCandidate(candValid, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      val.isValid,
      'TEST 3: Trend Continuation + H1 Ranging + Valid R:R (1.5R) + M5 Top Rejection - MUST BE ALLOWED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Trend Continuation + H1 Opposing Direction (SELL vs H1 STRONG_UPTREND)
  // Expected: REJECTED with HTF_CONTRADICTION
  // ---------------------------------------------------------------------------
  {
    const candOpposing = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4349.0,
      tp1: 4337.0, // 2.0R
      slPoints: 40,
      tp1Points: 80,
      tp1Rr: 2.0,
      confidence: 80,
    };

    const ind1h = createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', trendStructure: 'HH_HL' });
    const ind15m = createBaseIndicators({ marketRegime: 'WEAK_DOWNTREND', structure: 'BEARISH' });
    const c5m = createCandleSeries(20, createClosedCandle(4346.0, 4347.0, 4344.0, 4345.0));

    const val = validateTradeSignalCandidate(candOpposing, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid && (val.rejectionReason?.includes('HTF_CONTRADICTION') ?? false),
      'TEST 4: SELL Continuation against H1 STRONG_UPTREND - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Contradictory Context for SELL Continuation (DISCOUNT + BULLISH_OB + BULLISH_FVG)
  // Expected: REJECTED with CONTRADICTORY_BULLISH_CONTEXT_FOR_SELL_CONTINUATION
  // ---------------------------------------------------------------------------
  {
    const candContradictorySell = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4340.0,
      stopLoss: 4345.0,
      tp1: 4330.0, // 2.0R
      slPoints: 50,
      tp1Points: 100,
      tp1Rr: 2.0,
      confidence: 85,
      factorSnapshot: {
        factors: {
          zone: 'DISCOUNT',
          orderBlock: 'BULLISH_OB',
          fvg: 'BULLISH_FVG',
        },
      },
    };

    const ind15m = createBaseIndicators({
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4342, low: 4338 },
      fvg: { type: 'BULLISH', top: 4344, bottom: 4340 },
    });
    const c5m = createCandleSeries(20, createClosedCandle(4341.0, 4342.0, 4339.0, 4340.0));

    const val = validateTradeSignalCandidate(candContradictorySell, {
      currentPrice: 4340.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: baseIndicators1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid && (val.rejectionReason?.includes('CONTRADICTORY_BULLISH_CONTEXT_FOR_SELL_CONTINUATION') ?? false),
      'TEST 5: SELL Continuation in DISCOUNT + BULLISH_OB + BULLISH_FVG - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 6: Contradictory Context for BUY Continuation (PREMIUM + BEARISH_OB + BEARISH_FVG)
  // Expected: REJECTED with CONTRADICTORY_BEARISH_CONTEXT_FOR_BUY_CONTINUATION
  // ---------------------------------------------------------------------------
  {
    const candContradictoryBuy = {
      ...basePoi,
      setupName: 'Bullish Trend Continuation',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'BUY' as const,
      entry: 4350.0,
      stopLoss: 4345.0,
      tp1: 4360.0, // 2.0R
      slPoints: 50,
      tp1Points: 100,
      tp1Rr: 2.0,
      confidence: 85,
      factorSnapshot: {
        factors: {
          zone: 'PREMIUM',
          orderBlock: 'BEARISH_OB',
          fvg: 'BEARISH_FVG',
        },
      },
    };

    const ind1hBuy = createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' });
    const ind15mBuy = createBaseIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      premiumDiscountZone: 'PREMIUM',
      orderBlock: { type: 'BEARISH', high: 4355, low: 4351 },
      fvg: { type: 'BEARISH', top: 4354, bottom: 4352 },
    });
    const c5m = createCandleSeries(20, createClosedCandle(4349.0, 4351.0, 4348.5, 4350.0));

    const val = validateTradeSignalCandidate(candContradictoryBuy, {
      currentPrice: 4350.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1hBuy,
      indicators15m: ind15mBuy,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid && (val.rejectionReason?.includes('CONTRADICTORY_BEARISH_CONTEXT_FOR_BUY_CONTINUATION') ?? false),
      'TEST 6: BUY Continuation in PREMIUM + BEARISH_OB + BEARISH_FVG - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 7: Trend Continuation + H1 Ranging + Missing Closed M5 Rejection Trigger
  // Expected: REJECTED with TREND_CONTINUATION_HTF_QUALITY_INSUFFICIENT
  // ---------------------------------------------------------------------------
  {
    const candNoRejection = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4349.0, // 4.0 SL
      tp1: 4339.0,     // 6.0 TP1 -> 1.50R
      slPoints: 40,
      tp1Points: 60,
      tp1Rr: 1.50,
      confidence: 80,
    };

    const ind1h = createBaseIndicators({ marketRegime: 'NORMAL_RANGE', structure: 'RANGING' });
    const ind15m = createBaseIndicators({ marketRegime: 'WEAK_DOWNTREND', structure: 'BEARISH' });
    // Candle closed BULLISH (close > open) with no top rejection wick
    const c5m = createCandleSeries(20, createClosedCandle(4343.0, 4345.2, 4342.8, 4345.0));

    const val = validateTradeSignalCandidate(candNoRejection, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid && (val.rejectionReason?.includes('TREND_CONTINUATION_HTF_QUALITY_INSUFFICIENT') ?? false),
      'TEST 7: H1 Ranging + Bullish closed M5 candle without top rejection wick - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 8: Legitimate Trend Continuation + H1 Strong Trend + Valid R:R + Aligned Context
  // Expected: ACCEPTED (isValid === true)
  // ---------------------------------------------------------------------------
  {
    const candLegit = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4349.0,
      tp1: 4337.0, // 2.0R
      slPoints: 40,
      tp1Points: 80,
      tp1Rr: 2.0,
      confidence: 85,
    };

    const ind1h = createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' });
    const ind15m = createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' });
    // Strong bearish engulfing candle (open 4348, high 4349, low 4344.5, close 4345)
    const c5m = createCandleSeries(20, createClosedCandle(4348.0, 4349.0, 4344.5, 4345.0));

    const val = validateTradeSignalCandidate(candLegit, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      val.isValid,
      'TEST 8: Legitimate Strong HTF Trend Continuation - MUST BE ALLOWED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 9: AI Candidate Immunity Check (99% confidence fails Rule 3)
  // Expected: REJECTED despite 99% confidence
  // ---------------------------------------------------------------------------
  {
    const candHighConfAi = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (AI Recommended)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4340.0,
      stopLoss: 4345.0,
      tp1: 4330.0,
      slPoints: 50,
      tp1Points: 100,
      tp1Rr: 2.0,
      confidence: 99, // Extremely high AI confidence
      factorSnapshot: {
        factors: {
          zone: 'DISCOUNT',
          orderBlock: 'BULLISH_OB',
          fvg: 'BULLISH_FVG',
        },
      },
    };

    const ind15m = createBaseIndicators({
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4342, low: 4338 },
      fvg: { type: 'BULLISH', top: 4344, bottom: 4340 },
    });
    const c5m = createCandleSeries(20, createClosedCandle(4341.0, 4342.0, 4339.0, 4340.0));

    const val = validateTradeSignalCandidate(candHighConfAi, {
      currentPrice: 4340.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: baseIndicators1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid,
      'TEST 9: AI Candidate 99% Confidence Immunity Check - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 10: Deterministic Candidate Quality Gate Enforcement
  // Expected: REJECTED when failing H1 Ranging R:R gate
  // ---------------------------------------------------------------------------
  {
    const candDet = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4349.5, // 4.5 SL
      tp1: 4340.5,     // 4.5 TP1 -> 1.0R
      slPoints: 45,
      tp1Points: 45,
      tp1Rr: 1.0,
      confidence: 70,
    };

    const ind1h = createBaseIndicators({ marketRegime: 'NORMAL_RANGE', structure: 'RANGING' });
    const ind15m = createBaseIndicators({ marketRegime: 'WEAK_DOWNTREND', structure: 'BEARISH' });
    const c5m = createCandleSeries(20, createClosedCandle(4346.0, 4347.0, 4344.0, 4345.0));

    const val = validateTradeSignalCandidate(candDet, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      !val.isValid,
      'TEST 10: Deterministic Candidate R:R=1.0R in H1 Ranging - MUST BE REJECTED',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 11: Single-Factor Partial Contradiction (DISCOUNT only, but OB/FVG are BEARISH)
  // Expected: NOT rejected by Rule 3 contradictory context gate (requires all 3)
  // ---------------------------------------------------------------------------
  {
    const candPartial = {
      ...basePoi,
      setupName: 'Bearish Trend Continuation',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      direction: 'SELL' as const,
      entry: 4345.0,
      stopLoss: 4349.0,
      tp1: 4337.0, // 2.0R
      slPoints: 40,
      tp1Points: 80,
      tp1Rr: 2.0,
      confidence: 80,
      factorSnapshot: {
        factors: {
          zone: 'DISCOUNT', // Single factor: DISCOUNT
          orderBlock: 'BEARISH_OB', // Aligned
          fvg: 'BEARISH_FVG',      // Aligned
        },
      },
    };

    const ind1h = createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' });
    const ind15m = createBaseIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BEARISH', high: 4350, low: 4346 },
      fvg: { type: 'BEARISH', top: 4348, bottom: 4346 },
    });
    // Strong bearish candle
    const c5m = createCandleSeries(20, createClosedCandle(4348.0, 4349.0, 4344.5, 4345.0));

    const val = validateTradeSignalCandidate(candPartial, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: default15m,
      candles1h: default1h,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: baseIndicators5m,
    });

    assert(
      val.isValid,
      'TEST 11: Single-Factor Partial Contradiction (DISCOUNT only) - MUST BE ALLOWED (does not trigger Rule 3)',
      `Got isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  console.log('================================================================');
  console.log(`SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
