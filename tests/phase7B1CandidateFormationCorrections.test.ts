import assert from 'assert';
import { discoverGbv5Candidates } from '../server/gbv5Brain.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function createClosedCandles(count: number, basePrice: number, step: number = 0.1): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * 60000;
  for (let i = 0; i < count; i++) {
    const o = basePrice + i * step;
    const c = o + step;
    candles.push({
      timestamp: baseTime + i * 60000,
      open: Number(o.toFixed(2)),
      high: Number((Math.max(o, c) + 0.05).toFixed(2)),
      low: Number((Math.min(o, c) - 0.05).toFixed(2)),
      close: Number(c.toFixed(2)),
      volume: 1000,
      isClosed: true,
    });
  }
  return candles;
}

async function runPhase7B1RegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 7B.1 CANDIDATE FORMATION CORRECTIONS REGRESSION');
  console.log('========================================================================\n');

  const base5mCandles = createClosedCandles(30, 2500, 0.2);
  const baseInd5m: TechnicalIndicators = {
    structure: 'BULLISH',
    swingHigh: 2515,
    swingLow: 2485,
    atr14: 1.5,
    rsi14: 55,
    macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
    isDataSufficient: true,
  } as any;

  const baseInd15m: TechnicalIndicators = {
    structure: 'BULLISH',
    swingHigh: 2515,
    swingLow: 2485,
    atr14: 1.8,
    rsi14: 56,
    isDataSufficient: true,
  } as any;

  const baseInd1h: TechnicalIndicators = {
    structure: 'BULLISH',
    ema20: 2505,
    ema50: 2495,
    isDataSufficient: true,
  } as any;

  // =========================================================================
  // DEFECT A: STRUCTURE_BREAK_RETEST REGRESSION CASES
  // =========================================================================

  // Case A1: Initial breakout candle alone -> REJECTED
  console.log('TEST A1: Initial breakout candle alone cannot form STRUCTURE_BREAK_RETEST');
  {
    const now = Date.now();
    // Prior candle is at 2510 (below swingHigh 2515). Current candle breaks through 2515 to 2518.
    const candles: Candle[] = [
      { timestamp: now - 120000, open: 2508, high: 2511, low: 2507, close: 2510, volume: 1000, isClosed: true },
      { timestamp: now - 60000, open: 2510, high: 2519, low: 2509.5, close: 2518, volume: 2000, isClosed: true },
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2518,
      candles1m: candles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST');
    assert.strictEqual(cand, undefined, 'TEST A1 Failed: Breakout candle alone must NOT be accepted as retest');
    console.log('✅ [PASS] TEST A1: Initial breakout candle alone correctly rejected.\n');
  }

  // Case A2: Previous candle has not broken the level; current candle breaks and touches it -> REJECTED
  console.log('TEST A2: Previous candle has not broken level; current breaks and touches it -> REJECTED');
  {
    const now = Date.now();
    // Candle 1: 2511. Candle 2: 2513 (both below 2515). Candle 3: opens 2513, dips to 2514, breaks and closes at 2518
    const candles: Candle[] = [
      { timestamp: now - 180000, open: 2509, high: 2512, low: 2508, close: 2511, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2511, high: 2514, low: 2510, close: 2513, volume: 1200, isClosed: true },
      { timestamp: now - 60000, open: 2513, high: 2519, low: 2514.8, close: 2518, volume: 2500, isClosed: true },
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2518,
      candles1m: candles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST');
    assert.strictEqual(cand, undefined, 'TEST A2 Failed: Current candle cannot count as both break and retest simultaneously');
    console.log('✅ [PASS] TEST A2: Current candle breaking and touching simultaneously correctly rejected.\n');
  }

  // Case A3: Previous closed candle broke above swing high; current closed candle retests and holds -> ACCEPTED
  console.log('TEST A3: Previous closed candle broke swingHigh; current candle retests and holds above -> ACCEPTED');
  {
    const now = Date.now();
    // Candle 1: at 2511.
    // Candle 2 (prior closed): breaks through 2515 (close 2517).
    // Candle 3 (current closed): retests 2515 (low 2515.2 <= 2515.5) and holds above (close 2518 > 2515).
    const candles: Candle[] = [
      { timestamp: now - 180000, open: 2509, high: 2512, low: 2508, close: 2511, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2511, high: 2518, low: 2510, close: 2517, volume: 2000, isClosed: true },
      { timestamp: now - 60000, open: 2517, high: 2519, low: 2515.2, close: 2518, volume: 2500, isClosed: true },
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2518,
      candles1m: candles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST' && c.direction === 'BUY');
    assert(cand !== undefined, 'TEST A3 Failed: Prior break followed by valid retest hold must form BUY candidate');
    assert.strictEqual(cand!.direction, 'BUY');
    console.log(`✅ [PASS] TEST A3: Valid break and retest formed BUY candidate: ${cand!.setupName}.\n`);
  }

  // Case A4: Mirrored bearish breakdown followed by a valid retest -> ACCEPTED
  console.log('TEST A4: Mirrored bearish breakdown of swingLow followed by retest from below -> ACCEPTED');
  {
    const now = Date.now();
    // swingLow is 2485
    // Candle 1: at 2490
    // Candle 2 (prior closed): broke below 2485 (close 2483)
    // Candle 3 (current closed): retests 2485 from below (high 2484.8 >= 2484.5) and holds below (close 2482 < 2485)
    const candles: Candle[] = [
      { timestamp: now - 180000, open: 2492, high: 2493, low: 2489, close: 2490, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2490, high: 2490.5, low: 2482, close: 2483, volume: 2000, isClosed: true },
      { timestamp: now - 60000, open: 2483, high: 2484.8, low: 2481, close: 2482, volume: 2500, isClosed: true },
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2482,
      candles1m: candles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, structure: 'BEARISH' },
      indicators15m: { ...baseInd15m, structure: 'BEARISH' },
      indicators1h: { ...baseInd1h, structure: 'BEARISH', ema20: 2480, ema50: 2500 },
    });
    const cand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST' && c.direction === 'SELL');
    assert(cand !== undefined, 'TEST A4 Failed: Bearish breakdown followed by valid retest hold must form SELL candidate');
    assert.strictEqual(cand!.direction, 'SELL');
    console.log(`✅ [PASS] TEST A4: Mirrored bearish break and retest formed SELL candidate: ${cand!.setupName}.\n`);
  }

  // Case A5: Retest that closes on the wrong side of the level -> REJECTED
  console.log('TEST A5: Retest that fails and closes on the wrong side of the level -> REJECTED');
  {
    const now = Date.now();
    // Prior candle broke 2515 to 2517. Current candle retested but collapsed and closed at 2514 (below 2515).
    const candles: Candle[] = [
      { timestamp: now - 180000, open: 2509, high: 2512, low: 2508, close: 2511, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2511, high: 2518, low: 2510, close: 2517, volume: 2000, isClosed: true },
      { timestamp: now - 60000, open: 2517, high: 2517.5, low: 2513, close: 2514, volume: 2500, isClosed: true }, // Closed below 2515!
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2514,
      candles1m: candles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST');
    assert.strictEqual(cand, undefined, 'TEST A5 Failed: Failed retest closing on wrong side must NOT form candidate');
    console.log('✅ [PASS] TEST A5: Retest closing on wrong side correctly rejected.\n');
  }

  // Case A6: Missing or invalid structural level -> REJECTED
  console.log('TEST A6: Missing or invalid structural level -> REJECTED');
  {
    const now = Date.now();
    const candles: Candle[] = [
      { timestamp: now - 120000, open: 2511, high: 2518, low: 2510, close: 2517, volume: 2000, isClosed: true },
      { timestamp: now - 60000, open: 2517, high: 2519, low: 2515.2, close: 2518, volume: 2500, isClosed: true },
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2518,
      candles1m: candles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, swingHigh: undefined, swingLow: undefined } as any,
      indicators15m: { ...baseInd15m, swingHigh: 0, swingLow: -10 } as any,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST');
    assert.strictEqual(cand, undefined, 'TEST A6 Failed: Missing/zero/negative structural level must NOT form candidate');
    console.log('✅ [PASS] TEST A6: Missing/invalid structural levels correctly rejected.\n');
  }

  // =========================================================================
  // DEFECT B: TREND_CONTINUATION_PULLBACK REGRESSION CASES
  // =========================================================================

  // Case B1: Monotonically advancing M1 series with tiny open < prev.close difference -> REJECTED
  console.log('TEST B1: Monotonically advancing series with tiny open < prev.close difference -> REJECTED');
  {
    const now = Date.now();
    // 5 consecutive green candles advancing monotonically.
    // Last candle has open 2504.99 < prev.close 2505.00 by 1 cent, but no pullback in prior candles.
    const advancingCandles: Candle[] = [
      { timestamp: now - 240000, open: 2500.0, high: 2501.5, low: 2500.0, close: 2501.2, volume: 1000, isClosed: true },
      { timestamp: now - 180000, open: 2501.2, high: 2502.8, low: 2501.2, close: 2502.5, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2502.5, high: 2504.0, low: 2502.5, close: 2503.8, volume: 1000, isClosed: true },
      { timestamp: now - 60000, open: 2503.8, high: 2505.2, low: 2503.8, close: 2505.0, volume: 1000, isClosed: true },
      { timestamp: now, open: 2504.98, high: 2506.5, low: 2504.98, close: 2506.2, volume: 1200, isClosed: true }, // open < prev.close by 2 cents!
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2506.2,
      candles1m: advancingCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK');
    assert.strictEqual(
      cand,
      undefined,
      'TEST B1 Failed: Monotonically advancing series must NOT qualify via tiny open < prev.close'
    );
    console.log('✅ [PASS] TEST B1: Monotonically advancing series with tiny open < prev.close correctly rejected.\n');
  }

  // Case B2: Monotonically falling M1 series with tiny open > prev.close difference -> REJECTED (Symmetric SELL)
  console.log('TEST B2: Monotonically falling series with tiny open > prev.close difference -> REJECTED');
  {
    const now = Date.now();
    // 5 consecutive red candles falling monotonically.
    // Last candle has open 2495.02 > prev.close 2495.00 by 2 cents, but no rally/pullback in prior candles.
    const fallingCandles: Candle[] = [
      { timestamp: now - 240000, open: 2500.0, high: 2500.0, low: 2498.5, close: 2498.8, volume: 1000, isClosed: true },
      { timestamp: now - 180000, open: 2498.8, high: 2498.8, low: 2497.2, close: 2497.5, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2497.5, high: 2497.5, low: 2496.0, close: 2496.2, volume: 1000, isClosed: true },
      { timestamp: now - 60000, open: 2496.2, high: 2496.2, low: 2494.8, close: 2495.0, volume: 1000, isClosed: true },
      { timestamp: now, open: 2495.02, high: 2495.02, low: 2493.5, close: 2493.8, volume: 1200, isClosed: true }, // open > prev.close by 2 cents!
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2493.8,
      candles1m: fallingCandles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, structure: 'BEARISH' },
      indicators15m: { ...baseInd15m, structure: 'BEARISH' },
      indicators1h: { ...baseInd1h, structure: 'BEARISH', ema20: 2490, ema50: 2510 },
    });
    const cand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK');
    assert.strictEqual(
      cand,
      undefined,
      'TEST B2 Failed: Monotonically falling series must NOT qualify via tiny open > prev.close'
    );
    console.log('✅ [PASS] TEST B2: Monotonically falling series with tiny open > prev.close correctly rejected.\n');
  }

  // Case B3: Genuine bullish pullback retracement + continuation trigger -> ACCEPTED
  console.log('TEST B3: Genuine bullish countertrend pullback followed by continuation trigger -> ACCEPTED');
  {
    const now = Date.now();
    // Candle 1: push up to 2502.
    // Candle 2: authentic red pullback candle (open 2502.0, close 2500.5, low 2500.2).
    // Candle 3: green continuation trigger (open 2500.5, close 2503.0).
    const pullbackCandles: Candle[] = [
      { timestamp: now - 180000, open: 2500.0, high: 2502.5, low: 2499.8, close: 2502.0, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2502.0, high: 2502.2, low: 2500.2, close: 2500.5, volume: 1200, isClosed: true }, // Red pullback
      { timestamp: now - 60000, open: 2500.5, high: 2503.5, low: 2500.4, close: 2503.0, volume: 1500, isClosed: true },  // Green continuation
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2503.0,
      candles1m: pullbackCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK' && c.direction === 'BUY');
    assert(cand !== undefined, 'TEST B3 Failed: Authentic pullback + continuation trigger must form BUY candidate');
    assert.strictEqual(cand!.direction, 'BUY');
    console.log(`✅ [PASS] TEST B3: Genuine bullish pullback formed BUY candidate: ${cand!.setupName}.\n`);
  }

  // Case B4: Mirrored bearish rally pullback + continuation trigger -> ACCEPTED
  console.log('TEST B4: Mirrored bearish rally pullback followed by continuation trigger -> ACCEPTED');
  {
    const now = Date.now();
    // Candle 1: push down to 2508.
    // Candle 2: authentic green rally pullback (open 2508.0, close 2509.8, high 2510.0).
    // Candle 3: red continuation trigger (open 2509.8, close 2507.0).
    const bearPullbackCandles: Candle[] = [
      { timestamp: now - 180000, open: 2510.0, high: 2510.5, low: 2507.5, close: 2508.0, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2508.0, high: 2510.0, low: 2507.8, close: 2509.8, volume: 1200, isClosed: true }, // Green rally pullback
      { timestamp: now - 60000, open: 2509.8, high: 2510.0, low: 2506.8, close: 2507.0, volume: 1500, isClosed: true },  // Red continuation trigger
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2507.0,
      candles1m: bearPullbackCandles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, structure: 'BEARISH' },
      indicators15m: { ...baseInd15m, structure: 'BEARISH' },
      indicators1h: { ...baseInd1h, structure: 'BEARISH', ema20: 2495, ema50: 2505 },
    });
    const cand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK' && c.direction === 'SELL');
    assert(cand !== undefined, 'TEST B4 Failed: Authentic bearish rally + continuation trigger must form SELL candidate');
    assert.strictEqual(cand!.direction, 'SELL');
    console.log(`✅ [PASS] TEST B4: Mirrored bearish pullback formed SELL candidate: ${cand!.setupName}.\n`);
  }

  // Case B5: Insufficient M1 history (< 3 closed candles) -> REJECTED
  console.log('TEST B5: Insufficient M1 history (< 3 closed candles) -> REJECTED');
  {
    const now = Date.now();
    const shortCandles: Candle[] = [
      { timestamp: now - 60000, open: 2500.0, high: 2502.5, low: 2499.8, close: 2502.0, volume: 1000, isClosed: true },
    ];
    const res = discoverGbv5Candidates({
      currentPrice: 2502.0,
      candles1m: shortCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });
    const cand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK');
    assert.strictEqual(cand, undefined, 'TEST B5 Failed: < 3 candles must not form trend continuation candidate');
    console.log('✅ [PASS] TEST B5: Short M1 history (<3 candles) correctly rejected.\n');
  }

  console.log('========================================================================');
  console.log('🎉 ALL 11 PHASE 7B.1 REGRESSION TESTS PASSED (11/11)!');
  console.log('========================================================================\n');
}

runPhase7B1RegressionTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Phase 7B.1 Regression Tests Failed:', err);
    process.exit(1);
  });
