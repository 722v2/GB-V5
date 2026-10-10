import assert from 'assert';
import { discoverGbv5Candidates } from '../server/gbv5Brain.js';
import { extractPriceActionEvidence } from '../server/evidenceEngine.js';
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

async function runPhase7BCandidateFormationQualityRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 7B CANDIDATE FORMATION QUALITY REGRESSION TESTS');
  console.log('========================================================================\n');

  const base5mCandles = createClosedCandles(30, 2500, 0.2);
  const base15mCandles = createClosedCandles(30, 2500, 0.3);
  const base1hCandles = createClosedCandles(30, 2500, 0.5);

  const baseInd5m: TechnicalIndicators = {
    structure: 'BULLISH',
    swingHigh: 2520,
    swingLow: 2480,
    atr14: 1.5,
    rsi14: 55,
    macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
    isDataSufficient: true,
  } as any;

  const baseInd15m: TechnicalIndicators = {
    structure: 'BULLISH',
    swingHigh: 2520,
    swingLow: 2480,
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

  // -------------------------------------------------------------------------
  // TEST 1: Single ordinary bullish M1 candle in bullish HTF context cannot create TREND_CONTINUATION_PULLBACK
  // -------------------------------------------------------------------------
  console.log('TEST 1: Single ordinary bullish M1 candle without pullback cannot create TREND_CONTINUATION_PULLBACK');
  {
    const singleCandle: Candle[] = [{
      timestamp: Date.now() - 60000,
      open: 2500.0,
      high: 2500.2,
      low: 2499.9,
      close: 2500.1, // 10 cent green tick
      volume: 100,
      isClosed: true,
    }];

    const res = discoverGbv5Candidates({
      currentPrice: 2500.1,
      candles1m: singleCandle,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });

    const trendCand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK');
    assert.strictEqual(
      trendCand,
      undefined,
      'TEST 1 Failed: Single ordinary M1 candle must NOT create TREND_CONTINUATION_PULLBACK'
    );
    console.log('✅ [PASS] TEST 1: Single ordinary M1 candle correctly rejected (0 candidates).');
  }

  // -------------------------------------------------------------------------
  // TEST 2: Valid bullish pullback followed by continuation creates TREND_CONTINUATION_PULLBACK
  // -------------------------------------------------------------------------
  console.log('TEST 2: Valid bullish pullback + continuation trigger creates TREND_CONTINUATION_PULLBACK');
  {
    // Candle 1: push up
    // Candle 2: pullback red candle
    // Candle 3: continuation green candle
    const now = Date.now();
    const pullbackCandles: Candle[] = [
      { timestamp: now - 180000, open: 2500.0, high: 2502.0, low: 2499.8, close: 2501.8, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2501.8, high: 2502.0, low: 2500.2, close: 2500.5, volume: 1000, isClosed: true }, // Red pullback
      { timestamp: now - 60000, open: 2500.5, high: 2503.0, low: 2500.4, close: 2502.5, volume: 1500, isClosed: true },  // Green continuation
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2502.5,
      candles1m: pullbackCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });

    const trendCand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK' && c.direction === 'BUY');
    assert(trendCand !== undefined, 'TEST 2 Failed: Valid M1 pullback + continuation must discover BUY candidate');
    assert.strictEqual(trendCand!.direction, 'BUY');
    console.log(`✅ [PASS] TEST 2: Valid bullish pullback formed candidate: ${trendCand!.setupName} (Conf: ${trendCand!.confidence}%).`);
  }

  // -------------------------------------------------------------------------
  // TEST 3: Mirrored bearish continuation behavior
  // -------------------------------------------------------------------------
  console.log('TEST 3: Mirrored bearish pullback + continuation trigger creates TREND_CONTINUATION_PULLBACK');
  {
    const now = Date.now();
    const bearCandles: Candle[] = [
      { timestamp: now - 180000, open: 2510.0, high: 2510.5, low: 2508.0, close: 2508.2, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2508.2, high: 2509.8, low: 2508.0, close: 2509.5, volume: 1000, isClosed: true }, // Green rally pullback
      { timestamp: now - 60000, open: 2509.5, high: 2509.6, low: 2507.0, close: 2507.2, volume: 1500, isClosed: true },  // Red continuation
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2507.2,
      candles1m: bearCandles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, structure: 'BEARISH' },
      indicators15m: { ...baseInd15m, structure: 'BEARISH' },
      indicators1h: { ...baseInd1h, structure: 'BEARISH', ema20: 2495, ema50: 2505 },
    });

    const trendCand = res.candidates.find((c) => c.family === 'TREND_CONTINUATION_PULLBACK' && c.direction === 'SELL');
    assert(trendCand !== undefined, 'TEST 3 Failed: Mirrored bearish pullback must discover SELL candidate');
    assert.strictEqual(trendCand!.direction, 'SELL');
    console.log(`✅ [PASS] TEST 3: Mirrored bearish continuation formed candidate: ${trendCand!.setupName} (Conf: ${trendCand!.confidence}%).`);
  }

  // -------------------------------------------------------------------------
  // TEST 4: M1 displacement candle far below structural swing high cannot create STRUCTURE_BREAK_RETEST
  // -------------------------------------------------------------------------
  console.log('TEST 4: M1 displacement candle $20 below swing high cannot create STRUCTURE_BREAK_RETEST');
  {
    // 15 low volatility candles, then displacement candle with range 2.5, body 2.0 at price 2500.
    // Swing high is at 2520 ($20 above price).
    const c1m: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      c1m.push({
        timestamp: now - (16 - i) * 60000,
        open: 2497.0,
        high: 2497.5,
        low: 2497.0,
        close: 2497.3,
        volume: 100,
        isClosed: true,
      });
    }
    // 16th candle: strong displacement candle, but far below 2520
    c1m.push({
      timestamp: now - 60000,
      open: 2497.5,
      high: 2500.0,
      low: 2497.5,
      close: 2499.8,
      volume: 800,
      isClosed: true,
    });

    const res = discoverGbv5Candidates({
      currentPrice: 2499.8,
      candles1m: c1m,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: { ...baseInd15m, swingHigh: 2520, swingLow: 2480 },
      indicators1h: baseInd1h,
    });

    const bosCand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST');
    assert.strictEqual(
      bosCand,
      undefined,
      'TEST 4 Failed: Displacement far below swing high must NOT create STRUCTURE_BREAK_RETEST'
    );
    console.log('✅ [PASS] TEST 4: Displacement candle inside range correctly rejected from STRUCTURE_BREAK_RETEST.');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Genuine bullish break-and-retest can create STRUCTURE_BREAK_RETEST
  // -------------------------------------------------------------------------
  console.log('TEST 5: Genuine bullish break + retest of swingHigh creates STRUCTURE_BREAK_RETEST');
  {
    // swingHigh is at 2515.
    // Candle 1: breaks through 2515 (open 2513, close 2517)
    // Candle 2: retests 2515 and holds (open 2517, low 2515.1, close 2518)
    const now = Date.now();
    const bosCandles: Candle[] = [
      { timestamp: now - 180000, open: 2510, high: 2512, low: 2509, close: 2511, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2512, high: 2517, low: 2511, close: 2516.5, volume: 2000, isClosed: true }, // Broke 2515
      { timestamp: now - 60000, open: 2516.5, high: 2519, low: 2515.2, close: 2518.0, volume: 2500, isClosed: true }, // Retested 2515 and held
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2518.0,
      candles1m: bosCandles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, swingHigh: 2515, swingLow: 2480 },
      indicators15m: { ...baseInd15m, swingHigh: 2515, swingLow: 2480 },
      indicators1h: baseInd1h,
    });

    const bosCand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST' && c.direction === 'BUY');
    assert(bosCand !== undefined, 'TEST 5 Failed: Genuine break + retest must form STRUCTURE_BREAK_RETEST candidate');
    assert.strictEqual(bosCand!.direction, 'BUY');
    console.log(`✅ [PASS] TEST 5: Genuine bullish break + retest formed candidate: ${bosCand!.setupName}.`);
  }

  // -------------------------------------------------------------------------
  // TEST 6: Mirrored bearish structure break-and-retest
  // -------------------------------------------------------------------------
  console.log('TEST 6: Mirrored bearish break + retest of swingLow creates STRUCTURE_BREAK_RETEST');
  {
    // swingLow is at 2490.
    // Candle 1: breaks below 2490 (close 2488)
    // Candle 2: retests 2490 from below and rejects (high 2489.8, close 2487.5)
    const now = Date.now();
    const bearBosCandles: Candle[] = [
      { timestamp: now - 180000, open: 2493, high: 2494, low: 2491, close: 2492, volume: 1000, isClosed: true },
      { timestamp: now - 120000, open: 2492, high: 2492.5, low: 2487, close: 2488.0, volume: 2000, isClosed: true }, // Broke 2490
      { timestamp: now - 60000, open: 2488.0, high: 2489.8, low: 2486.5, close: 2487.2, volume: 2500, isClosed: true }, // Retested from below
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2487.2,
      candles1m: bearBosCandles,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, structure: 'BEARISH', swingHigh: 2520, swingLow: 2490 },
      indicators15m: { ...baseInd15m, structure: 'BEARISH', swingHigh: 2520, swingLow: 2490 },
      indicators1h: { ...baseInd1h, structure: 'BEARISH', ema20: 2480, ema50: 2500 },
    });

    const bosCand = res.candidates.find((c) => c.family === 'STRUCTURE_BREAK_RETEST' && c.direction === 'SELL');
    assert(bosCand !== undefined, 'TEST 6 Failed: Mirrored bearish break + retest must form SELL candidate');
    assert.strictEqual(bosCand!.direction, 'SELL');
    console.log(`✅ [PASS] TEST 6: Mirrored bearish break + retest formed candidate: ${bosCand!.setupName}.`);
  }

  // -------------------------------------------------------------------------
  // TEST 7: Range breakdown closing below range low cannot be labeled a bullish SFP
  // -------------------------------------------------------------------------
  console.log('TEST 7: Range breakdown closing below rangeLow cannot form bullish RANGE_SWEEP_SFP');
  {
    // rangeLow is at 2500. Price dropped to 2495 and closed at 2498 (< 2500).
    const breakdownCandles: Candle[] = [
      { timestamp: Date.now() - 120000, open: 2503, high: 2504, low: 2500, close: 2501, volume: 100, isClosed: true },
      { timestamp: Date.now() - 60000, open: 2498, high: 2499, low: 2495, close: 2498.5, volume: 200, isClosed: true }, // Closed BELOW 2500!
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2498.5,
      candles1m: breakdownCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: { ...baseInd15m, structure: 'RANGING', swingHigh: 2520, swingLow: 2500 },
      indicators1h: { ...baseInd1h, structure: 'RANGING' },
    });

    const sfpCand = res.candidates.find((c) => c.family === 'RANGE_SWEEP_SFP');
    assert.strictEqual(
      sfpCand,
      undefined,
      'TEST 7 Failed: Un-reclaimed breakdown closing below rangeLow must NOT form RANGE_SWEEP_SFP'
    );
    console.log('✅ [PASS] TEST 7: Breakdown closing below rangeLow correctly rejected from RANGE_SWEEP_SFP.');
  }

  // -------------------------------------------------------------------------
  // TEST 8: Genuine bullish sweep-and-reclaim creates RANGE_SWEEP_SFP
  // -------------------------------------------------------------------------
  console.log('TEST 8: Genuine sweep below rangeLow and close back inside range creates RANGE_SWEEP_SFP');
  {
    // rangeLow is 2500. Candle swept to 2498 (< 2500) and reclaimed/closed at 2501.5 (> 2500).
    const sfpCandles: Candle[] = [
      { timestamp: Date.now() - 120000, open: 2504, high: 2505, low: 2500, close: 2501, volume: 100, isClosed: true },
      { timestamp: Date.now() - 60000, open: 2501, high: 2502, low: 2497.5, close: 2501.8, volume: 500, isClosed: true }, // Low 2497.5 < 2500, Close 2501.8 > 2500
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2501.8,
      candles1m: sfpCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: { ...baseInd15m, structure: 'RANGING', swingHigh: 2520, swingLow: 2500 },
      indicators1h: { ...baseInd1h, structure: 'RANGING' },
    });

    const sfpCand = res.candidates.find((c) => c.family === 'RANGE_SWEEP_SFP' && c.direction === 'BUY');
    assert(sfpCand !== undefined, 'TEST 8 Failed: Genuine sweep and reclaim must create RANGE_SWEEP_SFP candidate');
    assert.strictEqual(sfpCand!.direction, 'BUY');
    console.log(`✅ [PASS] TEST 8: Genuine sweep and reclaim formed candidate: ${sfpCand!.setupName}.`);
  }

  // -------------------------------------------------------------------------
  // TEST 9: Mirrored bearish SFP behavior
  // -------------------------------------------------------------------------
  console.log('TEST 9: Mirrored bearish sweep above rangeHigh and close back inside range creates RANGE_SWEEP_SFP');
  {
    // rangeHigh is 2520. Candle swept to 2522.5 (> 2520) and closed at 2518.5 (< 2520).
    const sfpBearCandles: Candle[] = [
      { timestamp: Date.now() - 120000, open: 2516, high: 2519, low: 2515, close: 2518, volume: 100, isClosed: true },
      { timestamp: Date.now() - 60000, open: 2518, high: 2522.5, low: 2518, close: 2518.5, volume: 500, isClosed: true }, // High 2522.5 > 2520, Close 2518.5 < 2520
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2518.5,
      candles1m: sfpBearCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: { ...baseInd15m, structure: 'RANGING', swingHigh: 2520, swingLow: 2500 },
      indicators1h: { ...baseInd1h, structure: 'RANGING' },
    });

    const sfpCand = res.candidates.find((c) => c.family === 'RANGE_SWEEP_SFP' && c.direction === 'SELL');
    assert(sfpCand !== undefined, 'TEST 9 Failed: Mirrored bearish sweep and reclaim must create SELL RANGE_SWEEP_SFP');
    assert.strictEqual(sfpCand!.direction, 'SELL');
    console.log(`✅ [PASS] TEST 9: Mirrored bearish SFP formed candidate: ${sfpCand!.setupName}.`);
  }

  // -------------------------------------------------------------------------
  // TEST 10: Missing indicators15m does not throw
  // -------------------------------------------------------------------------
  console.log('TEST 10: Missing indicators15m handles gracefully without throwing');
  {
    let didThrow = false;
    let candidatesCount = 0;
    try {
      const res = discoverGbv5Candidates({
        currentPrice: 2500.0,
        candles1m: createClosedCandles(5, 2500, 0.1),
        candles5m: base5mCandles,
        indicators5m: baseInd5m,
        indicators15m: undefined, // Omitted
        indicators1h: undefined,  // Omitted
      });
      candidatesCount = res.candidates.length;
    } catch (err) {
      didThrow = true;
    }

    assert.strictEqual(didThrow, false, 'TEST 10 Failed: discoverGbv5Candidates must NOT throw when indicators15m is missing');
    console.log(`✅ [PASS] TEST 10: Missing indicators15m handled safely without crash (returned ${candidatesCount} candidates).`);
  }

  // -------------------------------------------------------------------------
  // TEST 11: Missing range levels and invalid ATR cannot create fabricated range-SFP candidates
  // -------------------------------------------------------------------------
  console.log('TEST 11: Missing range levels and invalid ATR cannot fabricate range-SFP candidate');
  {
    const res = discoverGbv5Candidates({
      currentPrice: 2500.0,
      candles1m: createClosedCandles(5, 2500, 0.1),
      candles5m: base5mCandles,
      indicators5m: { isDataSufficient: false } as any, // No swingHigh/Low, no ATR
      indicators15m: { isDataSufficient: false } as any,
    });

    const sfpCand = res.candidates.find((c) => c.family === 'RANGE_SWEEP_SFP');
    assert.strictEqual(
      sfpCand,
      undefined,
      'TEST 11 Failed: Missing grounded range extremes must NOT synthesize fake SFP candidate'
    );
    console.log('✅ [PASS] TEST 11: Missing range extremes safely rejected (0 fabricated SFP candidates).');
  }

  // -------------------------------------------------------------------------
  // TEST 12: Equal or nearly equal upper/lower rejection wicks remain neutral
  // -------------------------------------------------------------------------
  console.log('TEST 12: Ambiguous dual-wick candle classifies as NEUTRAL without directional bias');
  {
    // Symmetric spinning top / doji: range 10.0, upper wick 4.0 (40%), lower wick 4.0 (40%), body 2.0 (20%)
    const dojiCandle: Candle[] = [{
      timestamp: Date.now(),
      open: 2504.0,
      high: 2510.0, // upper wick = 2510 - 2506 = 4.0 (40%)
      low: 2500.0,  // lower wick = 2504 - 2500 = 4.0 (40%)
      close: 2506.0,
      volume: 1000,
      isClosed: true,
    }];

    const pa = extractPriceActionEvidence(dojiCandle, 2.0);
    assert.strictEqual(
      pa.rejectionDirection,
      'NEUTRAL',
      `TEST 12 Failed: Equal dual-wick candle must be NEUTRAL, got ${pa.rejectionDirection}`
    );
    assert.strictEqual(
      pa.hasRejectionWick,
      false,
      'TEST 12 Failed: Equal dual-wick candle must NOT be marked as directional rejection wick'
    );
    console.log('✅ [PASS] TEST 12: Dual-wick candle classified strictly as NEUTRAL (no directional bias).');
  }

  // -------------------------------------------------------------------------
  // TEST 13: Existing valid LIQUIDITY_SWEEP_REJECTION remains possible
  // -------------------------------------------------------------------------
  console.log('TEST 13: Existing valid LIQUIDITY_SWEEP_REJECTION remains discoverable');
  {
    // swingLow is 2500. Candle sweeps to 2498 (< 2500) and closes at 2500.5 with lower rejection wick
    const sweepCandles: Candle[] = [
      { timestamp: Date.now() - 120000, open: 2502, high: 2503, low: 2500, close: 2501, volume: 100, isClosed: true },
      { timestamp: Date.now() - 60000, open: 2500.2, high: 2501.0, low: 2497.0, close: 2500.5, volume: 1500, isClosed: true }, // Swept 2500 with lower wick
    ];

    const res = discoverGbv5Candidates({
      currentPrice: 2500.5,
      candles1m: sweepCandles,
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: { ...baseInd15m, swingLow: 2500, swingHigh: 2520 },
      indicators1h: baseInd1h,
    });

    const sweepCand = res.candidates.find((c) => c.family === 'LIQUIDITY_SWEEP_REJECTION');
    assert(sweepCand !== undefined, 'TEST 13 Failed: Valid liquidity sweep must produce LIQUIDITY_SWEEP_REJECTION');
    console.log(`✅ [PASS] TEST 13: LIQUIDITY_SWEEP_REJECTION candidate verified: ${sweepCand!.setupName}.`);
  }

  // -------------------------------------------------------------------------
  // TEST 14: No candidate created solely from HTF context without valid M1 formation
  // -------------------------------------------------------------------------
  console.log('TEST 14: No candidate created solely from M5/M15/H1 context without valid M1 formation');
  {
    // M1 has no valid formation (e.g. flat micro-ticks with no sweep, no break, no pullback)
    const deadCandles1m: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      deadCandles1m.push({
        timestamp: now - (10 - i) * 60000,
        open: 2505.0,
        high: 2505.05,
        low: 2504.95,
        close: 2505.0,
        volume: 10,
        isClosed: true,
      });
    }

    const res = discoverGbv5Candidates({
      currentPrice: 2505.0,
      candles1m: deadCandles1m,
      candles5m: base5mCandles,
      indicators5m: { ...baseInd5m, structure: 'BULLISH', chochDetected: true, liquiditySweepDetected: true },
      indicators15m: { ...baseInd15m, structure: 'BULLISH', chochDetected: true, liquiditySweepDetected: true },
      indicators1h: { ...baseInd1h, structure: 'BULLISH' },
    });

    assert.strictEqual(
      res.candidates.length,
      0,
      'TEST 14 Failed: HTF context alone must NOT create any candidates without valid M1 formation'
    );
    console.log('✅ [PASS] TEST 14: HTF context without valid M1 formation produces 0 candidates.');
  }

  // -------------------------------------------------------------------------
  // TEST 15: Only the four canonical families are returned
  // -------------------------------------------------------------------------
  console.log('TEST 15: Discovered candidates belong strictly to the four canonical GB-V5 families');
  {
    const canonicalSet = new Set([
      'LIQUIDITY_SWEEP_REJECTION',
      'STRUCTURE_BREAK_RETEST',
      'TREND_CONTINUATION_PULLBACK',
      'RANGE_SWEEP_SFP',
    ]);

    const res = discoverGbv5Candidates({
      currentPrice: 2502.5,
      candles1m: [
        { timestamp: Date.now() - 180000, open: 2500.0, high: 2502.0, low: 2499.8, close: 2501.8, volume: 1000, isClosed: true },
        { timestamp: Date.now() - 120000, open: 2501.8, high: 2502.0, low: 2500.2, close: 2500.5, volume: 1000, isClosed: true },
        { timestamp: Date.now() - 60000, open: 2500.5, high: 2503.0, low: 2500.4, close: 2502.5, volume: 1500, isClosed: true },
      ],
      candles5m: base5mCandles,
      indicators5m: baseInd5m,
      indicators15m: baseInd15m,
      indicators1h: baseInd1h,
    });

    for (const cand of res.candidates) {
      assert(
        canonicalSet.has(cand.family),
        `TEST 15 Failed: Candidate family ${cand.family} is not one of the four canonical families`
      );
    }
    console.log(`✅ [PASS] TEST 15: All ${res.candidates.length} returned candidates belong strictly to canonical families.`);
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL 15 PHASE 7B REGRESSION TESTS PASSED SUCCESSFULLY (15/15)!');
  console.log('========================================================================\n');
}

runPhase7BCandidateFormationQualityRegressionTests().catch((err) => {
  console.error('\n❌ Phase 7B Regression Tests Failed:', err);
  process.exit(1);
});
