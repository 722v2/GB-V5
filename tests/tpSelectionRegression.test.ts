import assert from 'node:assert';
import { calculateDynamicTakeProfits } from '../server/tpEngine.js';
import {
  assessStopLossQuality,
  assessEntryTimingAndAntiChase,
  validateTradeSignalCandidate,
} from '../server/tradeQualityEngine.js';
import { calculatePositionSizing } from '../server/riskManager.js';
import { TechnicalIndicators, Candle } from '../src/types.js';

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

function buildMockCandles(count = 50, basePrice = 2650): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: now - (count - i) * 300000,
      open: basePrice,
      high: basePrice,
      low: basePrice,
      close: basePrice,
      volume: 1000,
    });
  }
  return candles;
}

export async function runTpSelectionRegressionSuite() {
  console.log('========================================================================');
  console.log('🎯 RUNNING DEDICATED XAU/USD STRUCTURE & TP REGRESSION SUITE (TESTS A - N)');
  console.log('========================================================================');

  // -------------------------------------------------------------------------
  // TEST A: BUY nearest 1.0R structure beats distant 5R ATR target
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST A] BUY nearest 1.0R structure beats distant 5R ATR target...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00 (50 pts)
    const indicators5m = buildMockIndicators({
      swingHigh: 2655.00, // Distance = 5.00 -> exactly 1.00R
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2655.00,
      atr14: 4.0,
    });
    const indicators1h = buildMockIndicators({
      atr14: 16.67, // ATR fallback would project > 25.00 points (5.0R+)
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: [],
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 2.0, // Should NOT filter out 1.00R genuine structural target
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2655.00, 'TP1 must be nearest 1.0R structural target (2655.00)');
    assert.ok(Math.abs(result.tp1Rr - 1.00) < 0.05, `Expected TP1 R:R ~ 1.00, got ${result.tp1Rr}`);
    assert.strictEqual(result.tp1IsStructural, true, 'TP1 must be flagged as structural');
    assert.ok(result.tp1 < 2670.00, 'Distant 5R ATR target must NOT beat 1.0R structure');
    console.log(`✅ [PASS] TEST A: BUY nearest 1.0R structure selected (TP1: ${result.tp1}, R:R: ${result.tp1Rr}R) over distant ATR`);
  }

  // -------------------------------------------------------------------------
  // TEST B: SELL nearest 1.1R structure beats distant 5R ATR target
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST B] SELL nearest 1.1R structure beats distant 5R ATR target...');
    const entry = 2650.00;
    const stopLoss = 2655.00; // SL distance = 5.00 (50 pts)
    const indicators5m = buildMockIndicators({
      swingLow: 2644.50, // Distance = 5.50 -> exactly 1.10R
      structure: 'BEARISH',
    });
    const indicators15m = buildMockIndicators({
      swingLow: 2644.50,
      atr14: 4.0,
      structure: 'BEARISH',
    });
    const indicators1h = buildMockIndicators({
      atr14: 16.67, // ATR fallback would project > 25.00 points (5.0R+) below entry
      structure: 'BEARISH',
    });

    const result = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 2.5, // Should NOT push target to ATR
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2644.50, 'TP1 must be nearest 1.1R structural target (2644.50)');
    assert.ok(Math.abs(result.tp1Rr - 1.10) < 0.05, `Expected TP1 R:R ~ 1.10, got ${result.tp1Rr}`);
    assert.strictEqual(result.tp1IsStructural, true, 'TP1 must be flagged as structural');
    assert.ok(result.tp1 > 2630.00, 'Distant 5R ATR target must NOT beat 1.1R structure');
    console.log(`✅ [PASS] TEST B: SELL nearest 1.1R structure selected (TP1: ${result.tp1}, R:R: ${result.tp1Rr}R) over distant ATR`);
  }

  // -------------------------------------------------------------------------
  // TEST C: BUY nearest 1.2R bearish OB becomes TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST C] BUY nearest 1.2R bearish OB becomes TP1...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00 (50 pts)
    const indicators15m = buildMockIndicators({
      orderBlock: {
        type: 'BEARISH',
        high: 2658.00,
        low: 2656.00, // Distance = 6.00 -> 1.20R
      },
      swingHigh: 2675.00, // Distant swing high (5.0R)
      resistance: 2675.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
    });
    const indicators5m = buildMockIndicators({
      swingHigh: 2675.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
    });
    const indicators1h = buildMockIndicators({
      swingHigh: 2675.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2656.00, 'TP1 must be the opposing 15M Bearish Order Block edge (2656.00)');
    assert.ok(Math.abs(result.tp1Rr - 1.20) < 0.05, `Expected TP1 R:R ~ 1.20, got ${result.tp1Rr}`);
    assert.ok(result.tp1TargetName.includes('Order Block'), 'Target name must identify Order Block');
    assert.strictEqual(result.tp2, 2675.00, 'TP2 must be the next structural objective beyond the OB');
    console.log(`✅ [PASS] TEST C: BUY nearest 1.2R Bearish OB became TP1 (${result.tp1}, R:R: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST D: SELL nearest 1.2R bullish OB becomes TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST D] SELL nearest 1.2R bullish OB becomes TP1...');
    const entry = 2650.00;
    const stopLoss = 2655.00; // SL distance = 5.00 (50 pts)
    const indicators15m = buildMockIndicators({
      orderBlock: {
        type: 'BULLISH',
        high: 2644.00, // Distance = 6.00 -> 1.20R
        low: 2641.00,
      },
      swingLow: 2625.00, // Distant swing low (5.0R)
      support: 2625.00,
      structure: 'BEARISH',
      bollingerBands: { lower: 2625.00, middle: 2650, upper: 2660 },
    });
    const indicators5m = buildMockIndicators({
      swingLow: 2625.00,
      structure: 'BEARISH',
      bollingerBands: { lower: 2625.00, middle: 2650, upper: 2660 },
    });
    const indicators1h = buildMockIndicators({
      swingLow: 2625.00,
      structure: 'BEARISH',
      bollingerBands: { lower: 2625.00, middle: 2650, upper: 2660 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2644.00, 'TP1 must be the opposing 15M Bullish Order Block edge (2644.00)');
    assert.ok(Math.abs(result.tp1Rr - 1.20) < 0.05, `Expected TP1 R:R ~ 1.20, got ${result.tp1Rr}`);
    assert.ok(result.tp1TargetName.includes('Order Block'), 'Target name must identify Order Block');
    assert.strictEqual(result.tp2, 2625.00, 'TP2 must be the next structural objective beyond the OB');
    console.log(`✅ [PASS] TEST D: SELL nearest 1.2R Bullish OB became TP1 (${result.tp1}, R:R: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST E: BUY nearest FVG barrier becomes TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST E] BUY nearest FVG barrier becomes TP1...');
    const entry = 2650.00;
    const stopLoss = 2646.00; // SL distance = 4.00 (40 pts)
    const indicators15m = buildMockIndicators({
      fvg: {
        type: 'BEARISH',
        top: 2657.00,
        bottom: 2654.80, // Distance = 4.80 -> 1.20R
      },
      swingHigh: 2670.00, // Distant swing high
      bollingerBands: { upper: 2670.00, middle: 2650, lower: 2640 },
    });
    const indicators5m = buildMockIndicators({
      swingHigh: 2670.00,
      bollingerBands: { upper: 2670.00, middle: 2650, lower: 2640 },
    });
    const indicators1h = buildMockIndicators({
      swingHigh: 2670.00,
      bollingerBands: { upper: 2670.00, middle: 2650, lower: 2640 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2654.80, 'TP1 must be the nearest Bearish FVG entry (2654.80)');
    assert.ok(result.tp1TargetName.includes('FVG'), 'Target name must identify FVG');
    assert.strictEqual(result.tp2, 2670.00, 'TP2 must be the next structural objective beyond the FVG');
    console.log(`✅ [PASS] TEST E: BUY nearest FVG barrier became TP1 (${result.tp1}, R:R: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST F: SELL nearest FVG barrier becomes TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST F] SELL nearest FVG barrier becomes TP1...');
    const entry = 2650.00;
    const stopLoss = 2654.00; // SL distance = 4.00 (40 pts)
    const indicators15m = buildMockIndicators({
      fvg: {
        type: 'BULLISH',
        top: 2645.20, // Distance = 4.80 -> 1.20R
        bottom: 2642.00,
      },
      swingLow: 2630.00, // Distant swing low
      structure: 'BEARISH',
      bollingerBands: { lower: 2630.00, middle: 2650, upper: 2660 },
    });
    const indicators5m = buildMockIndicators({
      swingLow: 2630.00,
      structure: 'BEARISH',
      bollingerBands: { lower: 2630.00, middle: 2650, upper: 2660 },
    });
    const indicators1h = buildMockIndicators({
      swingLow: 2630.00,
      structure: 'BEARISH',
      bollingerBands: { lower: 2630.00, middle: 2650, upper: 2660 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2645.20, 'TP1 must be the nearest Bullish FVG entry (2645.20)');
    assert.ok(result.tp1TargetName.includes('FVG'), 'Target name must identify FVG');
    assert.strictEqual(result.tp2, 2630.00, 'TP2 must be the next structural objective beyond the FVG');
    console.log(`✅ [PASS] TEST F: SELL nearest FVG barrier became TP1 (${result.tp1}, R:R: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST G: TP1 below 1.5R remains valid
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST G] TP1 below 1.5R remains valid...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2655.50, // 5.50 distance -> 1.10R (< 1.5R)
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true, 'TP1 below 1.5R must remain valid');
    assert.strictEqual(result.tp1, 2655.50);
    assert.ok(result.tp1Rr < 1.5, 'Natural RR must be below 1.5R');
    assert.strictEqual(result.tp1Rr, 1.1, 'Natural RR must equal exactly 1.10R');
    console.log(`✅ [PASS] TEST G: 1.10R TP1 remains valid (valid=${result.valid}, natural RR: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST H: TP2 selects the next genuine structural objective
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST H] TP2 selects the next genuine structural objective...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2655.50, // TP1: 1.10R (5.50 distance)
      bollingerBands: { upper: 2664.00, middle: 2650, lower: 2640 },
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2664.00, // TP2: 2.80R (14.00 distance)
      bollingerBands: { upper: 2664.00, middle: 2650, lower: 2640 },
    });
    const indicators1h = buildMockIndicators({
      swingHigh: 2675.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2655.50, 'TP1 is 5M swing');
    assert.strictEqual(result.tp2, 2664.00, 'TP2 must be the next structural level (15M swing)');
    assert.notStrictEqual(result.tp2, entry + 2 * (result.tp1 - entry), 'TP2 must NOT be arbitrary 2x distance');
    console.log(`✅ [PASS] TEST H: TP2 selected next structural level ${result.tp2} (TP1: ${result.tp1})`);
  }

  // -------------------------------------------------------------------------
  // TEST I: No structural target -> fallback projection works
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST I] No structural target -> fallback projection works...');
    const entry = 2700.00; // All-time high breakout, no swings above entry
    const stopLoss = 2695.00; // SL distance = 5.00
    const emptyStructureIndicators: TechnicalIndicators = {
      ...buildMockIndicators({ atr14: 4.0 }),
      swingHigh: 2690.00, // below entry
      orderBlock: undefined,
      fvg: undefined,
      bollingerBands: { upper: 2698.00, middle: 2690.00, lower: 2680.00 },
    };

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: { ...emptyStructureIndicators, atr14: 6.0 },
      indicators15m: emptyStructureIndicators,
      indicators5m: emptyStructureIndicators,
      candles1h: [], // No session candles
      candles15m: [],
      candles5m: [],
    });

    assert.strictEqual(result.valid, true, 'Fallback projection must be valid when no structure exists');
    assert.strictEqual(result.tp1IsStructural, false, 'Fallback target must be flagged as non-structural');
    assert.ok(result.tp1 > entry, 'TP1 must project above entry');
    assert.ok(result.tp1TargetName.includes('Extension') || result.tp1TargetName.includes('Projection'), 'Target name must indicate synthetic fallback');
    console.log(`✅ [PASS] TEST I: Fallback projection selected cleanly at ${result.tp1} (isStructural: ${result.tp1IsStructural}, target: ${result.tp1TargetName})`);
  }

  // -------------------------------------------------------------------------
  // TEST J: BUY and SELL remain mathematically symmetric
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST J] BUY and SELL remain mathematically symmetric...');
    const buyEntry = 2650.00;
    const buySl = 2646.00; // 4.00 distance
    const buyIndicators = buildMockIndicators({ swingHigh: 2654.80 }); // 4.80 distance -> 1.20R

    const sellEntry = 2650.00;
    const sellSl = 2654.00; // 4.00 distance
    const sellIndicators = buildMockIndicators({ swingLow: 2645.20, structure: 'BEARISH' }); // 4.80 distance -> 1.20R

    const buyResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: buyEntry,
      stopLoss: buySl,
      asset: 'XAU/USD',
      indicators1h: buyIndicators,
      indicators15m: buyIndicators,
      indicators5m: buyIndicators,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });

    const sellResult = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry: sellEntry,
      stopLoss: sellSl,
      asset: 'XAU/USD',
      indicators1h: sellIndicators,
      indicators15m: sellIndicators,
      indicators5m: sellIndicators,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });

    assert.strictEqual(buyResult.valid, true);
    assert.strictEqual(sellResult.valid, true);
    assert.strictEqual(buyResult.tp1Rr, sellResult.tp1Rr, 'BUY and SELL R:R must be mathematically identical');
    assert.strictEqual(buyResult.tp1Points, sellResult.tp1Points, 'BUY and SELL TP1 points must be mathematically identical');
    assert.strictEqual(buyResult.slPoints, sellResult.slPoints, 'BUY and SELL SL points must be mathematically identical');
    console.log(`✅ [PASS] TEST J: Perfect BUY/SELL symmetry: RR=${buyResult.tp1Rr}R, TP Points=${buyResult.tp1Points} pts, SL Points=${buyResult.slPoints} pts`);
  }

  // -------------------------------------------------------------------------
  // TEST K: Invalid geometry still rejects safely
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST K] Invalid geometry still rejects safely...');
    // BUY with SL >= Entry
    const invertedBuy = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: 2650.00,
      stopLoss: 2655.00, // Inverted SL
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(invertedBuy.valid, false, 'Inverted BUY geometry must return valid=false');

    // SELL with SL <= Entry
    const invertedSell = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry: 2650.00,
      stopLoss: 2645.00, // Inverted SL
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(invertedSell.valid, false, 'Inverted SELL geometry must return valid=false');

    // Micro SL < 0.05
    const microSl = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: 2650.00,
      stopLoss: 2649.98, // 0.02 SL
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(microSl.valid, false, 'Micro SL (<0.05) must return valid=false');
    console.log('✅ [PASS] TEST K: Inverted and micro-geometry rejected safely with valid=false');
  }

  // -------------------------------------------------------------------------
  // TEST L: NaN/undefined target data fails safely
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST L] NaN/undefined target data fails safely without throwing...');
    const nanResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: NaN,
      stopLoss: 2645.00,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(nanResult.valid, false, 'NaN entry must fail safely');

    const undefinedSlResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: 2650.00,
      stopLoss: undefined as unknown as number,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(undefinedSlResult.valid, false, 'undefined stopLoss must fail safely');
    console.log('✅ [PASS] TEST L: NaN and undefined values handled safely');
  }

  // -------------------------------------------------------------------------
  // TEST M: No artificial minRR value can force TP farther away
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST M] No artificial minRR value can force TP farther away...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2655.50, // 1.10R structural target
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2670.00, // 4.00R distant target
    });

    const standardResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.0,
    });

    const highMinRrResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 3.5, // Aggressive minRr requested
    });

    assert.strictEqual(standardResult.tp1, 2655.50, 'Standard minRr must select 2655.50');
    assert.strictEqual(highMinRrResult.tp1, 2655.50, 'High minRr (3.5) must NOT push TP1 away from genuine 2655.50 target');
    assert.strictEqual(highMinRrResult.tp1, standardResult.tp1, 'TP1 must remain identical regardless of minRr input');
    console.log(`✅ [PASS] TEST M: minRr=3.5 did NOT distort TP1 (remained ${highMinRrResult.tp1} at ${highMinRrResult.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST N: Exact previous regression: 1.2R structural target MUST beat 5.9R ATR projection
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST N] Exact previous regression: 1.2R structural target MUST beat 5.9R ATR projection...');
    const entry = 4378.93;
    const stopLoss = 4383.43; // SL distance = 4.50 (45 pts)
    const indicators5m = buildMockIndicators({
      swingLow: 4373.53, // Distance = 5.40 -> exactly 1.20R
      structure: 'BEARISH',
    });
    const indicators15m = buildMockIndicators({
      swingLow: 4373.53,
      structure: 'BEARISH',
      atr14: 6.0,
    });
    const indicators1h = buildMockIndicators({
      structure: 'BEARISH',
      atr14: 17.7, // 1.5 * 17.7 = 26.55 distance -> 4352.38 (5.90R)
    });

    const result = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 2.0,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 4373.53, 'TP1 MUST be 4373.53 (1.20R structural target), NOT 4352.38 (5.9R ATR)');
    assert.ok(Math.abs(result.tp1Rr - 1.20) < 0.05, `Expected 1.20R, got ${result.tp1Rr}`);
    assert.strictEqual(result.tp1IsStructural, true, 'TP1 must be flagged as structural');
    assert.notStrictEqual(result.tp1, 4352.38, 'TP1 must NOT be the 5.9R ATR projection');
    console.log(`✅ [PASS] TEST N: 1.20R structural target (4373.53) successfully beat 5.90R ATR projection (4352.38)`);
  }

  // -------------------------------------------------------------------------
  // SUPPLEMENTARY SAFETY CONTROLS
  // -------------------------------------------------------------------------
  {
    console.log('\n[SUPPLEMENTARY] Verifying SL quality, anti-chase, and risk sizing safety controls...');
    // 55-point SL within 35-65 boundaries
    const sl55 = assessStopLossQuality('BUY', 2650.00, 2644.50, buildMockIndicators({ swingLow: 2644.80 }).atr14, 35, 65);
    assert.strictEqual(sl55.isValid, true);
    assert.strictEqual(sl55.slPoints, 55.0);

    // 70-point SL rejected (>65 ceiling)
    const sl70 = assessStopLossQuality('BUY', 2650.00, 2643.00, buildMockIndicators({ swingLow: 2643.30 }).atr14, 35, 65);
    assert.strictEqual(sl70.isValid, false);

    // Chased entry detected
    const chasedTiming = assessEntryTimingAndAntiChase('BUY', 'ORDER_BLOCK', 2655.00, 2645.00, buildMockCandles(), buildMockIndicators({ atr14: 3.5 }), 'STRONG_UPTREND');
    assert.strictEqual(chasedTiming.isChasing, true);

    // Position sizing risk check
    const sizing = calculatePositionSizing(100, 15.0, 2650.00, 2644.50, {
      contractSizeOz: 100,
      minimumLot: 0.01,
      minGoldSlPoints: 35,
      maxGoldSlPoints: 65,
      maxLoss: 6.0,
    });
    assert.strictEqual(sizing.isExecutable, true);
    console.log('✅ [PASS] SUPPLEMENTARY: SL bounds (35-65 pts), anti-chase, and position sizing validated.');
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL 14 REGRESSION TESTS (A - N) + SUPPLEMENTARY PASSED WITH 100% SUCCESS');
  console.log('========================================================================\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTpSelectionRegressionSuite()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Test suite failed:', err);
      process.exit(1);
    });
}
