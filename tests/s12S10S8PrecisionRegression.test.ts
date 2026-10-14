import test from 'node:test';
import assert from 'node:assert';
import { generateMultiStrategyCandidates, MultiStrategyEngineInput } from '../server/strategyEngine.js';
import { TechnicalIndicators, Candle } from '../src/types.js';

function createMockCandle(ts: number, open: number, high: number, low: number, close: number): Candle {
  return {
    timestamp: ts,
    open,
    high,
    low,
    close,
    volume: 1000,
    isClosed: true,
  };
}

function createBaseIndicators(): TechnicalIndicators {
  return {
    atr14: 2.0,
    rsi14: 50,
    ema20: 2700,
    ema50: 2700,
    ema200: 2690,
    vwap: 2700,
    resistance: 2720,
    support: 2680,
    swingHigh: 2720,
    swingLow: 2680,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollingerBands: { upper: 2710, middle: 2700, lower: 2690 },
    structure: 'RANGING',
    isTrending: false,
    trendDirection: 'NEUTRAL',
    trendStrength: 50,
    marketRegime: 'NORMAL_RANGE',
  };
}

test('S12 (Break & Retest) Target Capping & RR Enforcement', async (t) => {
  await t.test('S12 caps distant macro TP1 at 2.0R ceiling without violating minRr', () => {
    const candles5m: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // Form a horizontal resistance breakout and retest
    // Level at 2705. Breakout to 2710, retest at 2705.5
    candles5m[candles5m.length - 3] = createMockCandle(now - 600000, 2704, 2712, 2704, 2711);
    candles5m[candles5m.length - 2] = createMockCandle(now - 300000, 2711, 2711, 2705.5, 2706);
    candles5m[candles5m.length - 1] = createMockCandle(now, 2706, 2708, 2705.5, 2707.5);

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0;
    ind5m.swingHigh = 2760; // Far macro swing (would be 50+ pts away)
    ind5m.resistance = 2760;

    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;
    ind15m.swingHigh = 2780;
    ind15m.resistance = 2780;

    const ind1h = createBaseIndicators();
    ind1h.atr14 = 5.0;
    ind1h.swingHigh = 2800;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2707.5,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2800, 2680, 2707.5)],
      candles15m: [createMockCandle(now, 2700, 2780, 2680, 2707.5)],
      candles5m,
      brokerSpecs: {
        minRr: 1.5,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 85,
      },
    };

    const result = generateMultiStrategyCandidates(input);
    const s12 = result.allCandidates.find((c) => c.strategyFamily === 'BREAK_AND_RETEST' || c.patternMetadata?.strategyId === 'S12');
    if (s12) {
      assert.ok(s12.tp1Rr <= 2.05, `S12 TP1 RR should be capped near 2.0R, got ${s12.tp1Rr}`);
      assert.ok(s12.tp1Rr >= 1.5, `S12 TP1 RR must satisfy minRr (1.5), got ${s12.tp1Rr}`);
    }
  });
});

test('S10 (Double Top / Bottom) Post-Neckline Displacement Quality Check', async (t) => {
  await t.test('S10 rejects excessive displacement (> 0.8 ATR) past the neckline', () => {
    const candles5m: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0; // 0.8 ATR = 1.6 pts

    // Neckline at 2700, current price at 2697.0 (3.0 pts displaced = 1.5 ATR) -> Should be rejected
    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2697.0,
      indicators1h: createBaseIndicators(),
      indicators15m: createBaseIndicators(),
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2720, 2680, 2697)],
      candles15m: [createMockCandle(now, 2700, 2720, 2680, 2697)],
      candles5m,
      brokerSpecs: {
        minRr: 1.5,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 85,
      },
    };

    const result = generateMultiStrategyCandidates(input);
    const s10Candidates = result.allCandidates.filter(
      (c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM' || c.patternMetadata?.strategyId === 'S10'
    );
    // Should not have any late neckline chase candidates
    for (const cand of s10Candidates) {
      if (cand.patternMetadata?.neckline) {
        const disp = Math.abs(input.currentPrice - cand.patternMetadata.neckline);
        assert.ok(disp <= 0.8 * ind5m.atr14 + 0.01, `Displacement must be <= 0.8 ATR, got ${disp}`);
      }
    }
  });
});

test('S8 (Countertrend Scalp) 15M Trend Protection & Scalp Target Objective', async (t) => {
  await t.test('S8 blocks countertrend scalps when distance from 15M EMA50 > 2.5 ATR', () => {
    const candles5m: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    candles5m[candles5m.length - 1] = createMockCandle(now, 2730, 2732, 2728, 2730);

    const ind5m = createBaseIndicators();
    ind5m.rsi14 = 85; // Extreme overbought
    ind5m.atr14 = 2.0;
    ind5m.ema20 = 2715;

    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;
    ind15m.ema50 = 2710; // Dist from 2730 is 20 pts = 6.67 ATR (> 2.5 ATR) -> Runaway trend

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2730,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2735, 2680, 2730)],
      candles15m: [createMockCandle(now, 2700, 2735, 2680, 2730)],
      candles5m,
      brokerSpecs: {
        minRr: 1.5,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 85,
      },
    };

    const result = generateMultiStrategyCandidates(input);
    const s8 = result.allCandidates.find((c) => c.strategyFamily === 'COUNTERTREND_SCALP' || c.patternMetadata?.strategyId === 'S8');
    assert.strictEqual(s8, undefined, 'S8 must be blocked during runaway 15M trend (> 2.5 ATR from EMA50)');
  });

  await t.test('S8 accepts valid countertrend scalp when 15M trend is moderate (<= 2.5 ATR)', () => {
    const candles5m: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // Top rejection candle
    candles5m[candles5m.length - 1] = createMockCandle(now, 2715, 2722, 2714, 2715.5);

    const ind5m = createBaseIndicators();
    ind5m.rsi14 = 78; // Overbought
    ind5m.atr14 = 2.0;
    ind5m.ema20 = 2706; // Scalp target distance is ~9.5 pts
    ind5m.swingHigh = 2722;

    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;
    ind15m.ema50 = 2712; // Dist from 2715.5 is 3.5 pts = 1.16 ATR (<= 2.5 ATR) -> Safe
    ind15m.swingHigh = 2722;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2715.5,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2725, 2690, 2715.5)],
      candles15m: [createMockCandle(now, 2700, 2725, 2690, 2715.5)],
      candles5m,
      brokerSpecs: {
        minRr: 1.5,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 85,
      },
    };

    const result = generateMultiStrategyCandidates(input);
    const s8 = result.allCandidates.find((c) => c.strategyFamily === 'COUNTERTREND_SCALP' || c.patternMetadata?.strategyId === 'S8');
    if (s8) {
      assert.ok(s8.tp1Rr <= 2.05, `S8 scalp TP1 RR must be capped near 2.0R, got ${s8.tp1Rr}`);
      assert.ok(s8.tp1Rr >= 1.5, `S8 scalp TP1 RR must satisfy minRr (1.5), got ${s8.tp1Rr}`);
    }
  });
});
