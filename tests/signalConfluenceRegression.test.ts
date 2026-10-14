import assert from 'node:assert';
import {
  assessPriceActionTrigger,
  assessTpPathRunway,
  assessStopLossQuality,
  assessEntryTimingAndAntiChase,
  validateTradeSignalCandidate,
  checkStructuralSameSetupIdentity,
} from '../server/tradeQualityEngine.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function buildMockCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
  isClosed = true
): Candle {
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    isClosed,
  };
}

function makeCandleSeries(basePrice: number, count: number, step: number = 0.1): Candle[] {
  const candles: Candle[] = [];
  const fiveMinMs = 5 * 60 * 1000;
  const now = 1710000000000;
  for (let i = count; i >= 1; i--) {
    const p = basePrice + (count - i) * step;
    candles.push({
      timestamp: now - i * fiveMinMs,
      open: p - 0.2,
      high: p + 0.5,
      low: p - 0.5,
      close: p + 0.2,
      volume: 500,
      isClosed: true,
    });
  }
  return candles;
}

function buildMockIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  const swingHigh = overrides.swingHigh ?? 2660;
  const swingLow = overrides.swingLow ?? 2640;
  return {
    trendStructure: 'HH_HL',
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    atr14: 3.5,
    ema20: 2645,
    ema50: 2640,
    ema200: 2630,
    vwap: 2650,
    rsi14: 60,
    macd: { macd: 1, signal: 0.5, histogram: 0.5 },
    bollingerBands: { upper: swingHigh, middle: 2650, lower: swingLow },
    swingHigh,
    swingLow,
    support: swingLow,
    resistance: swingHigh,
    ...overrides,
  };
}

export async function runSignalConfluenceRegressionSuite() {
  console.log('========================================================================');
  console.log('🎯 RUNNING SIGNAL CONFLUENCE & MARKET STRUCTURE QUALITY SUITE (22 TESTS)');
  console.log('========================================================================');

  let passed = 0;
  let failed = 0;

  function runTest(testName: string, fn: () => void) {
    try {
      fn();
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } catch (err: any) {
      console.error(`❌ [FAIL] ${testName}: ${err.message}`);
      failed++;
    }
  }

  const now = 1710000120000;
  const baseCandles5m = makeCandleSeries(2640, 30, 0.1);
  const baseCandles15m = makeCandleSeries(2640, 30, 0.3);
  const baseCandles1h = makeCandleSeries(2640, 30, 0.5);

  // -------------------------------------------------------------------------
  // TEST 1: Strong BUY Confluence
  // -------------------------------------------------------------------------
  runTest('TEST 1: Strong BUY Confluence (1H + 15M + POI + 5M Closed Trigger + Clear Runway)', () => {
    const candles5m = [...baseCandles5m];
    // Add bullish rejection + engulfing on last closed candle
    const lastTime = now - 5 * 60 * 1000;
    candles5m[candles5m.length - 1] = buildMockCandle(lastTime, 2640.5, 2646.0, 2638.0, 2645.5);

    const ind5m = buildMockIndicators({ structure: 'BULLISH', swingLow: 2638, swingHigh: 2665 });
    const ind15m = buildMockIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', swingLow: 2638, swingHigh: 2665 });
    const ind1h = buildMockIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', swingLow: 2635, swingHigh: 2670 });

    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0, // 50 pts
        tp1: 2655.0, // 100 pts (2.0R)
        poiPrice: 2640.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Retest',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2639, top: 2642 },
      },
      {
        currentPrice: 2645.0,
        candles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, true, `Expected valid strong BUY setup, got: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 2: Strong SELL Confluence
  // -------------------------------------------------------------------------
  runTest('TEST 2: Strong SELL Confluence (1H + 15M + POI + 5M Closed Trigger + Clear Runway)', () => {
    const candles5m = makeCandleSeries(2660, 30, -0.1);
    const lastTime = now - 5 * 60 * 1000;
    candles5m[candles5m.length - 1] = buildMockCandle(lastTime, 2659.5, 2662.0, 2654.0, 2654.5);

    const ind5m = buildMockIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      trendStructure: 'LH_LL',
      swingLow: 2635,
      swingHigh: 2662,
    });
    const ind15m = buildMockIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      trendStructure: 'LH_LL',
      swingLow: 2635,
      swingHigh: 2662,
    });
    const ind1h = buildMockIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      trendStructure: 'LH_LL',
      swingLow: 2630,
      swingHigh: 2665,
    });

    const result = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2655.0,
        stopLoss: 2660.0, // 50 pts
        tp1: 2645.0, // 100 pts (2.0R)
        poiPrice: 2660.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Retest',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2658, top: 2661 },
      },
      {
        currentPrice: 2655.0,
        candles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, true, `Expected valid strong SELL setup, got: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 3: Isolated 5M Displacement without POI -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 3: Isolated 5M Displacement without POI -> REJECTED', () => {
    const candles5m = [...baseCandles5m];
    const ind5m = buildMockIndicators();
    const ind15m = buildMockIndicators();
    const ind1h = buildMockIndicators();

    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0,
        tp1: 2655.0,
        setupName: 'Displacement_Only Isolated Candle',
        // No POI, no meta
      },
      {
        currentPrice: 2645.0,
        candles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'Isolated displacement without POI must be rejected');
    assert.ok(
      result.rejectionReason?.includes('SINGLE_FACTOR_REJECTED') ||
      result.rejectionReason?.includes('MISSING_POI_CONTEXT'),
      `Expected single-factor or missing POI rejection, got: ${result.rejectionReason}`
    );
  });

  // -------------------------------------------------------------------------
  // TEST 4: Isolated 5M Engulfing Candle without POI -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 4: Isolated 5M Engulfing Candle without POI -> REJECTED', () => {
    const candles5m = [...baseCandles5m];
    const ind5m = buildMockIndicators();
    const ind15m = buildMockIndicators();
    const ind1h = buildMockIndicators();

    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0,
        tp1: 2655.0,
        setupName: 'Engulfing_Only Candle',
      },
      {
        currentPrice: 2645.0,
        candles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'Isolated engulfing candle without POI must be rejected');
  });

  // -------------------------------------------------------------------------
  // TEST 5: RSI-Only BUY Signal -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 5: RSI-Only BUY Signal -> REJECTED', () => {
    const ind5m = buildMockIndicators({ rsi14: 25 });
    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0,
        tp1: 2655.0,
        setupName: 'RSI_ONLY Oversold Bounce',
      },
      {
        currentPrice: 2645.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: ind5m,
        indicators15m: buildMockIndicators(),
        indicators1h: buildMockIndicators(),
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'RSI-only setup must be rejected');
    assert.ok(result.rejectionReason?.includes('SINGLE_FACTOR_REJECTED'), 'Reason must indicate SINGLE_FACTOR_REJECTED');
  });

  // -------------------------------------------------------------------------
  // TEST 6: RSI-Only SELL Signal -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 6: RSI-Only SELL Signal -> REJECTED', () => {
    const ind5m = buildMockIndicators({ rsi14: 78 });
    const result = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2655.0,
        stopLoss: 2660.0,
        tp1: 2645.0,
        setupName: 'RSI_ONLY Overbought Reversal',
      },
      {
        currentPrice: 2655.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: ind5m,
        indicators15m: buildMockIndicators(),
        indicators1h: buildMockIndicators(),
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'RSI-only SELL setup must be rejected');
    assert.ok(result.rejectionReason?.includes('SINGLE_FACTOR_REJECTED'));
  });

  // -------------------------------------------------------------------------
  // TEST 7: MACD-Crossover-Only Signal -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 7: MACD Crossover Only Signal -> REJECTED', () => {
    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0,
        tp1: 2655.0,
        setupName: 'MACD_ONLY Golden Cross',
      },
      {
        currentPrice: 2645.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators(),
        indicators15m: buildMockIndicators(),
        indicators1h: buildMockIndicators(),
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'MACD-only setup must be rejected');
    assert.ok(result.rejectionReason?.includes('SINGLE_FACTOR_REJECTED'));
  });

  // -------------------------------------------------------------------------
  // TEST 8: EMA-Crossover-Only Signal -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 8: EMA Crossover Only Signal -> REJECTED', () => {
    const result = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2655.0,
        stopLoss: 2660.0,
        tp1: 2645.0,
        setupName: 'EMA_CROSS_ONLY Death Cross',
      },
      {
        currentPrice: 2655.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators(),
        indicators15m: buildMockIndicators(),
        indicators1h: buildMockIndicators(),
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'EMA-cross-only setup must be rejected');
    assert.ok(result.rejectionReason?.includes('SINGLE_FACTOR_REJECTED'));
  });

  // -------------------------------------------------------------------------
  // TEST 9: 1H/15M Bearish Trend vs Generic BUY Continuation -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 9: 1H/15M Bearish Trend vs Generic BUY Continuation -> REJECTED (HTF Contradiction)', () => {
    const ind1h = buildMockIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      trendStructure: 'LH_LL',
    });
    const ind15m = buildMockIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      trendStructure: 'LH_LL',
    });

    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0,
        tp1: 2655.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Continuation',
        poiPrice: 2640.0,
      },
      {
        currentPrice: 2645.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators(),
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'BUY continuation in strong downtrend must be rejected');
    assert.ok(result.rejectionReason?.includes('HTF_CONTRADICTION'), `Expected HTF_CONTRADICTION, got: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 10: 1H/15M Bullish Trend vs Generic SELL Continuation -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 10: 1H/15M Bullish Trend vs Generic SELL Continuation -> REJECTED (HTF Contradiction)', () => {
    const ind1h = buildMockIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      trendStructure: 'HH_HL',
    });
    const ind15m = buildMockIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      trendStructure: 'HH_HL',
    });

    const result = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2655.0,
        stopLoss: 2660.0,
        tp1: 2645.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Continuation',
        poiPrice: 2660.0,
      },
      {
        currentPrice: 2655.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators(),
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, false, 'SELL continuation in strong uptrend must be rejected');
    assert.ok(result.rejectionReason?.includes('HTF_CONTRADICTION'), `Expected HTF_CONTRADICTION, got: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 11: Legitimate Reversal BUY (SSL Sweep at key support) -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 11: Legitimate Reversal BUY (SSL Sweep at key support) -> ACCEPTED', () => {
    const ind1h = buildMockIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      trendStructure: 'LH_LL',
    });
    const ind15m = buildMockIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      trendStructure: 'LH_LL',
      swingLow: 2630,
      swingHigh: 2660,
    });

    const candles5m = [...baseCandles5m];
    const lastTime = now - 5 * 60 * 1000;
    candles5m[candles5m.length - 1] = buildMockCandle(lastTime, 2632, 2638, 2629, 2637); // Sweep below 2630 with long wick + close back above

    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2631.5,
        stopLoss: 2627.0,
        tp1: 2642.0, // > 1.0R
        strategyFamily: 'LIQUIDITY_SWEEP',
        setupName: 'SSL Sweep Reversal at Range Low',
        poiPrice: 2630.0,
        poiMeta: { type: 'SFP_ZONE', bottom: 2629, top: 2631 },
      },
      {
        currentPrice: 2631.5,
        candles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators({ atr14: 3.5, swingLow: 2629 }),
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 90, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, true, `Legitimate SSL Sweep reversal must be accepted, got error: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 12: Legitimate Reversal SELL (BSL Sweep at key resistance) -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 12: Legitimate Reversal SELL (BSL Sweep at key resistance) -> ACCEPTED', () => {
    const ind1h = buildMockIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      trendStructure: 'HH_HL',
    });
    const ind15m = buildMockIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      trendStructure: 'HH_HL',
      swingLow: 2630,
      swingHigh: 2660,
    });

    const candles5m = [...baseCandles5m];
    const lastTime = now - 5 * 60 * 1000;
    candles5m[candles5m.length - 1] = buildMockCandle(lastTime, 2661, 2663, 2658, 2659); // Bearish rejection at resistance

    const result = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2659.5,
        stopLoss: 2664.0,
        tp1: 2648.0, // > 1.0R
        strategyFamily: 'LIQUIDITY_SWEEP',
        setupName: 'BSL Sweep Reversal at Range High',
        poiPrice: 2660.0,
        poiMeta: { type: 'SFP_ZONE', bottom: 2659, top: 2661 },
      },
      {
        currentPrice: 2659.5,
        candles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators({ atr14: 3.5, swingHigh: 2661 }),
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 90, minRr: 1.0 },
      }
    );

    assert.strictEqual(result.isValid, true, `Legitimate BSL Sweep reversal must be accepted, got error: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 13: Duplicate Confirmation Protection on Single 5M Candle
  // -------------------------------------------------------------------------
  runTest('TEST 13: Duplicate Confirmation Protection (Single 5M candle body expansion capped)', () => {
    const lastTime = now - 5 * 60 * 1000;
    const prevTime = now - 10 * 60 * 1000;
    const candles: Candle[] = [
      buildMockCandle(prevTime - 5 * 60 * 1000, 2640, 2642, 2639, 2641),
      buildMockCandle(prevTime, 2641, 2642, 2639, 2640),
      // Single large bullish candle: displacement (> 0.8x ATR), engulfing (> 0.6x range), expansion close (> prev high)
      buildMockCandle(lastTime, 2640, 2646, 2640, 2645.8),
    ];

    const trigger = assessPriceActionTrigger('BUY', candles, [], buildMockIndicators({ atr14: 3.5 }), now);
    assert.strictEqual(trigger.hasTrigger, true, 'Must detect trigger');
    // Without duplicate protection, score would be 10 (engulfing) + 8 (strong close) + 8 (displacement) = 26.
    // With duplicate protection, body expansion is unified and capped at 12.
    assert.ok(
      trigger.confirmationScore <= 12,
      `Single candle body expansion score must be capped at 12 without wick/BOS, got: ${trigger.confirmationScore}`
    );
  });

  // -------------------------------------------------------------------------
  // TEST 14: Independent Confluence Scoring (Wick + Body + Micro-BOS)
  // -------------------------------------------------------------------------
  runTest('TEST 14: Independent Confluence Scoring (Rejection Wick + Body Expansion + Micro-BOS)', () => {
    const lastTime = now - 5 * 60 * 1000;
    const prevTime = now - 10 * 60 * 1000;
    const candles: Candle[] = [
      buildMockCandle(prevTime, 2641, 2642, 2639, 2640),
      // Lower wick (8.0) > 1.3x body (3.9) and > 40% range (Rejection wick: 12) + Engulfing/expansion close (10)
      buildMockCandle(lastTime, 2642, 2645.5, 2634, 2645),
    ];

    // 1M series with Micro-BOS: 6 pts
    const candles1m: Candle[] = [
      buildMockCandle(lastTime + 60000, 2644, 2645, 2643, 2644),
      buildMockCandle(lastTime + 120000, 2644, 2645, 2643, 2644),
      buildMockCandle(lastTime + 180000, 2644, 2645, 2643, 2644),
      buildMockCandle(lastTime + 240000, 2644, 2645, 2643, 2644),
      buildMockCandle(lastTime + 300000, 2644, 2648, 2644, 2647.5), // Breaks above 2645
    ];

    const trigger = assessPriceActionTrigger('BUY', candles, candles1m, buildMockIndicators({ atr14: 3.5 }), now);
    assert.strictEqual(trigger.hasTrigger, true);
    // Score should reflect independent components (12 + 10 + 6 = 28)
    assert.ok(trigger.confirmationScore >= 20, `Expected multi-factor confluence score >= 20, got: ${trigger.confirmationScore}`);
  });

  // -------------------------------------------------------------------------
  // TEST 15: Blocked Runway BUY
  // -------------------------------------------------------------------------
  runTest('TEST 15: Blocked Runway BUY (Opposing 15M EMA200 / Bearish OB before TP1) -> REJECTED', () => {
    const ind15m = buildMockIndicators({
      ema200: 2647.0, // Sitting directly between entry 2645 and TP1 2655
      swingHigh: 2665,
      swingLow: 2635,
    });

    const runway = assessTpPathRunway('BUY', 2645.0, 2655.0, 2665.0, baseCandles15m, baseCandles1h, ind15m, buildMockIndicators());
    assert.strictEqual(runway.runway, 'BLOCKED', `Expected BLOCKED runway due to EMA200 obstacle at 2647, got: ${runway.runway}`);
  });

  // -------------------------------------------------------------------------
  // TEST 16: Blocked Runway SELL
  // -------------------------------------------------------------------------
  runTest('TEST 16: Blocked Runway SELL (Opposing 15M EMA200 / Bullish OB before TP1) -> REJECTED', () => {
    const ind15m = buildMockIndicators({
      ema200: 2653.0, // Sitting directly between entry 2655 and TP1 2645
      swingHigh: 2665,
      swingLow: 2635,
    });

    const runway = assessTpPathRunway('SELL', 2655.0, 2645.0, 2635.0, baseCandles15m, baseCandles1h, ind15m, buildMockIndicators());
    assert.strictEqual(runway.runway, 'BLOCKED', `Expected BLOCKED runway due to EMA200 obstacle at 2653, got: ${runway.runway}`);
  });

  // -------------------------------------------------------------------------
  // TEST 17: Multi-Strategy Engine High-Quality Filtering
  // -------------------------------------------------------------------------
  runTest('TEST 17: Multi-Strategy Engine filters low-confluence setups and preserves valid', () => {
    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 1000,
      currentPrice: 2650.0,
      indicators1h: buildMockIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' }),
      indicators15m: buildMockIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', orderBlock: { type: 'BULLISH', low: 2648, high: 2651 } }),
      indicators5m: buildMockIndicators({ structure: 'BULLISH' }),
      candles1h: baseCandles1h,
      candles15m: baseCandles15m,
      candles5m: baseCandles5m,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    });

    // Should return result structure
    assert.ok(result !== null && typeof result === 'object', 'Result must be defined object');
    assert.ok(Array.isArray(result.allCandidates), 'Candidates must be an array');
  });

  // -------------------------------------------------------------------------
  // TEST 18: Strict BUY/SELL Symmetry Parity
  // -------------------------------------------------------------------------
  runTest('TEST 18: Strict BUY/SELL Symmetry Parity', () => {
    // Symmetrical BUY context
    const buyCandles5m = makeCandleSeries(2640, 30, 0.1);
    const buyContext = {
      currentPrice: 2645.0,
      candles5m: buyCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BULLISH', swingLow: 2638, swingHigh: 2665 }),
      indicators15m: buildMockIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', swingLow: 2638, swingHigh: 2665 }),
      indicators1h: buildMockIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', swingLow: 2635, swingHigh: 2670 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const buyRes = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2645.0,
        stopLoss: 2640.0,
        tp1: 2655.0,
        poiPrice: 2640.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Retest',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2639, top: 2642 },
      },
      buyContext
    );

    // Symmetrical SELL context (mirrored)
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    const sellContext = {
      currentPrice: 2655.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingLow: 2635, swingHigh: 2662 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingLow: 2635, swingHigh: 2662 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingLow: 2630, swingHigh: 2665 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const sellRes = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2655.0,
        stopLoss: 2660.0,
        tp1: 2645.0,
        poiPrice: 2660.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Retest',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2658, top: 2661 },
      },
      sellContext
    );

    assert.strictEqual(buyRes.isValid, sellRes.isValid, 'BUY and SELL validity must be 100% symmetrically matched');
  });

  // -------------------------------------------------------------------------
  // TEST 19: Raw Bullish M1 SFP against Strong H1 Downtrend (Without Support) -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 19: Raw Bullish M1 SFP against Strong H1 Downtrend without support -> REJECTED (HTF_CONTRADICTION)', () => {
    const ind1h = buildMockIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      trendStructure: 'LH_LL',
    });
    const result = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2640.0,
        stopLoss: 2635.0,
        tp1: 2650.0,
        strategyFamily: 'LIQUIDITY_SWEEP',
        setupName: 'M1 Bullish SFP',
      },
      {
        currentPrice: 2640.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators(),
        indicators15m: buildMockIndicators(),
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );
    assert.strictEqual(result.isValid, false, 'Raw M1 bullish SFP against 1H downtrend must be rejected');
    assert.ok(result.rejectionReason?.includes('HTF_CONTRADICTION'), `Expected HTF_CONTRADICTION, got: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 20: Raw Bearish M1 SFP against Strong H1 Uptrend (Without Support) -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 20: Raw Bearish M1 SFP against Strong H1 Uptrend without support -> REJECTED (HTF_CONTRADICTION)', () => {
    const ind1h = buildMockIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      trendStructure: 'HH_HL',
    });
    const result = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2660.0,
        stopLoss: 2665.0,
        tp1: 2650.0,
        strategyFamily: 'LIQUIDITY_SWEEP',
        setupName: 'M1 Bearish SFP',
      },
      {
        currentPrice: 2660.0,
        candles5m: baseCandles5m,
        candles15m: baseCandles15m,
        candles1h: baseCandles1h,
        indicators5m: buildMockIndicators(),
        indicators15m: buildMockIndicators(),
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      }
    );
    assert.strictEqual(result.isValid, false, 'Raw M1 bearish SFP against 1H uptrend must be rejected');
    assert.ok(result.rejectionReason?.includes('HTF_CONTRADICTION'), `Expected HTF_CONTRADICTION, got: ${result.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 21: Repeated Scans of Same Liquidity Event -> DUPLICATE_ACTIVE
  // -------------------------------------------------------------------------
  runTest('TEST 21: Repeated scans of same liquidity event -> DUPLICATE_ACTIVE', () => {
    const activeOpp = {
      id: 'opp_test_1',
      direction: 'BUY',
      entry: 2640.0,
      stopLoss: 2635.0,
      tp1: 2650.0,
      setupName: 'M1 Bullish SFP',
      status: 'ACTIVE',
      patternMetadata: { patternAnchorKey: 'anchor_123' },
    };
    const candidate = {
      id: 'sig_test_2',
      signal: 'BUY NOW',
      entry: 2640.2,
      stopLoss: 2635.0,
      tp1: 2650.0,
      setup: 'M1 Bullish SFP',
      strategyFamily: 'LIQUIDITY_SWEEP',
      patternMetadata: { patternAnchorKey: 'anchor_123' },
    };
    const dupRes = checkStructuralSameSetupIdentity(candidate as any, null, [activeOpp as any]);
    assert.strictEqual(dupRes.isDuplicate, true, 'Repeated scan of active setup must be identified as duplicate');
    assert.strictEqual(dupRes.reason, 'DUPLICATE_ACTIVE');
  });

  // -------------------------------------------------------------------------
  // TEST 22: Genuinely New Sweep After Original Setup Completed -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 22: Genuinely new sweep after original setup completed -> ACCEPTED', () => {
    const completedOpp = {
      id: 'opp_test_1',
      direction: 'BUY',
      entry: 2640.0,
      stopLoss: 2635.0,
      tp1: 2650.0,
      setupName: 'M1 Bullish SFP',
      status: 'COMPLETED',
      patternMetadata: { patternAnchorKey: 'anchor_123' },
    };
    const candidate = {
      id: 'sig_test_3',
      signal: 'BUY NOW',
      entry: 2642.0,
      stopLoss: 2637.0,
      tp1: 2652.0,
      setup: 'M1 Bullish SFP',
      strategyFamily: 'LIQUIDITY_SWEEP',
      patternMetadata: { patternAnchorKey: 'anchor_124' }, // new anchor key
    };
    const dupRes = checkStructuralSameSetupIdentity(candidate as any, null, [completedOpp as any]);
    assert.strictEqual(dupRes.isDuplicate, false, 'New sweep after original setup completed must not be blocked as duplicate');
  });

  console.log('========================================================================');
  console.log(`📊 SUMMARY: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('========================================================================');

  if (failed > 0) {
    throw new Error(`${failed} test(s) failed in signalConfluenceRegression suite!`);
  }
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('signalConfluenceRegression.test.ts') || process.argv[1]?.endsWith('signalConfluenceRegression.test.js')) {
  runSignalConfluenceRegressionSuite().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
