import assert from 'assert';
import {
  extractMacdEvidence,
  extractRsiEvidence,
  extractPriceActionEvidence,
  extractStructureEvidence,
  extractLiquidityEvidence,
  extractSessionRegimeEvidence,
  buildCompleteEvidenceBundle,
} from '../server/evidenceEngine.js';
import { discoverGbv5Candidates } from '../server/gbv5Brain.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { calculateATR } from '../server/indicators.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function createCandles(count: number, basePrice: number, step: number = 0.1): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * 60000;
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: baseTime + i * 60000,
      open: basePrice + i * step,
      high: basePrice + i * step + 1.0,
      low: basePrice + i * step - 1.0,
      close: basePrice + i * step + 0.5,
      volume: 1000,
      isClosed: true,
    });
  }
  return candles;
}

async function runPhase7EvidenceIntegrityRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 7A EVIDENCE INTEGRITY REGRESSION TESTS');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // A. Zero MACD is neutral
  // -------------------------------------------------------------------------
  console.log('TEST A: Zero MACD classified as NEUTRAL with 0 evidence points');
  {
    const zeroMacdInd: TechnicalIndicators = {
      macd: { macd: 0, signal: 0, histogram: 0 },
      isDataSufficient: true,
    } as any;
    const res = extractMacdEvidence(zeroMacdInd);
    assert.strictEqual(res.momentumState, 'NEUTRAL', 'TEST A: Momentum state must be NEUTRAL for zero MACD');
    assert.strictEqual(res.evidenceScore, 0, 'TEST A: evidenceScore must be 0 for zero MACD');

    // Also verify nearly flat / micro-noise within 1e-4 precision
    const flatMacdInd: TechnicalIndicators = {
      macd: { macd: 0.00005, signal: 0.00005, histogram: 0 },
      isDataSufficient: true,
    } as any;
    const flatRes = extractMacdEvidence(flatMacdInd);
    assert.strictEqual(flatRes.momentumState, 'NEUTRAL', 'TEST A: Flat MACD within tolerance must be NEUTRAL');
    assert.strictEqual(flatRes.evidenceScore, 0, 'TEST A: evidenceScore must be 0 for flat MACD');
    console.log('✅ [PASS] TEST A: Zero/flat MACD is classified as NEUTRAL with score 0.\n');
  }

  // -------------------------------------------------------------------------
  // B. Missing MACD receives no positive score
  // -------------------------------------------------------------------------
  console.log('TEST B: Missing or invalid MACD receives no positive score');
  {
    const nullRes = extractMacdEvidence(null as any);
    assert.strictEqual(nullRes.evidenceScore, 0, 'TEST B: null indicator must yield score 0');
    assert.strictEqual(nullRes.momentumState, 'NEUTRAL', 'TEST B: null indicator must yield NEUTRAL momentum');

    const insufficientRes = extractMacdEvidence({ isDataSufficient: false, macd: { macd: 2, signal: 1, histogram: 1 } } as any);
    assert.strictEqual(insufficientRes.evidenceScore, 0, 'TEST B: isDataSufficient=false must yield score 0');
    assert.strictEqual(insufficientRes.momentumState, 'NEUTRAL', 'TEST B: isDataSufficient=false must yield NEUTRAL');

    const nanRes = extractMacdEvidence({ macd: { macd: NaN, signal: 0, histogram: NaN } } as any);
    assert.strictEqual(nanRes.evidenceScore, 0, 'TEST B: NaN MACD must yield score 0');
    assert.strictEqual(nanRes.momentumState, 'NEUTRAL', 'TEST B: NaN MACD must yield NEUTRAL');
    console.log('✅ [PASS] TEST B: Missing/invalid MACD produces score 0 and NEUTRAL momentum.\n');
  }

  // -------------------------------------------------------------------------
  // C. Real positive and negative MACD evidence remains directional
  // -------------------------------------------------------------------------
  console.log('TEST C: Real positive and negative MACD evidence remains directional');
  {
    const bullInd: TechnicalIndicators = {
      macd: { macd: 1.2, signal: 0.4, histogram: 0.8 },
      isDataSufficient: true,
    } as any;
    const bullRes = extractMacdEvidence(bullInd);
    assert.strictEqual(bullRes.momentumState, 'STRONG_BULLISH', 'TEST C: Bullish MACD must be STRONG_BULLISH');
    assert.strictEqual(bullRes.evidenceScore, 15, 'TEST C: STRONG_BULLISH MACD must earn 15 points');

    const bearInd: TechnicalIndicators = {
      macd: { macd: -1.2, signal: -0.4, histogram: -0.8 },
      isDataSufficient: true,
    } as any;
    const bearRes = extractMacdEvidence(bearInd);
    assert.strictEqual(bearRes.momentumState, 'STRONG_BEARISH', 'TEST C: Bearish MACD must be STRONG_BEARISH');
    assert.strictEqual(bearRes.evidenceScore, 15, 'TEST C: STRONG_BEARISH MACD must earn 15 points');

    // Directional symmetry
    assert.strictEqual(bullRes.evidenceScore, bearRes.evidenceScore, 'TEST C: Bull and Bear MACD scores must be symmetric');
    console.log('✅ [PASS] TEST C: Positive/negative MACD correctly directional and symmetric.\n');
  }

  // -------------------------------------------------------------------------
  // D. Neutral RSI does not receive unjustified directional evidence
  // -------------------------------------------------------------------------
  console.log('TEST D: Neutral RSI does not receive unjustified directional evidence');
  {
    const neutralRsi50 = extractRsiEvidence({ rsi14: 50, isDataSufficient: true } as any);
    assert.strictEqual(neutralRsi50.momentumState, 'NEUTRAL', 'TEST D: RSI 50 must be NEUTRAL');
    assert.strictEqual(neutralRsi50.evidenceScore, 0, 'TEST D: Neutral RSI 50 must earn 0 points');

    const neutralRsi52 = extractRsiEvidence({ rsi: 52, isDataSufficient: true } as any);
    assert.strictEqual(neutralRsi52.momentumState, 'NEUTRAL', 'TEST D: RSI 52 must be NEUTRAL');
    assert.strictEqual(neutralRsi52.evidenceScore, 0, 'TEST D: Neutral RSI 52 must earn 0 points');

    const neutralRsi48 = extractRsiEvidence({ rsi14: 48, isDataSufficient: true } as any);
    assert.strictEqual(neutralRsi48.momentumState, 'NEUTRAL', 'TEST D: RSI 48 must be NEUTRAL');
    assert.strictEqual(neutralRsi48.evidenceScore, 0, 'TEST D: Neutral RSI 48 must earn 0 points');

    // Genuine momentum still scores
    const bullRsi = extractRsiEvidence({ rsi14: 62, isDataSufficient: true } as any);
    assert.strictEqual(bullRsi.momentumState, 'BULLISH_MOMENTUM', 'TEST D: RSI 62 must be BULLISH_MOMENTUM');
    assert.strictEqual(bullRsi.evidenceScore, 8, 'TEST D: BULLISH_MOMENTUM must earn 8 points');

    const bearRsi = extractRsiEvidence({ rsi14: 38, isDataSufficient: true } as any);
    assert.strictEqual(bearRsi.momentumState, 'BEARISH_MOMENTUM', 'TEST D: RSI 38 must be BEARISH_MOMENTUM');
    assert.strictEqual(bearRsi.evidenceScore, 8, 'TEST D: BEARISH_MOMENTUM must earn 8 points');
    console.log('✅ [PASS] TEST D: Neutral RSI awards 0 points; genuine momentum awards measured points.\n');
  }

  // -------------------------------------------------------------------------
  // E. Missing evidence does not receive positive baseline points
  // -------------------------------------------------------------------------
  console.log('TEST E: Missing evidence categories receive 0 positive baseline points');
  {
    const paEmpty = extractPriceActionEvidence([], 2.0);
    assert.strictEqual(paEmpty.rejectionQualityScore, 0, 'TEST E: Empty candles must yield PA score 0');

    const rsiMissing = extractRsiEvidence(null as any);
    assert.strictEqual(rsiMissing.evidenceScore, 0, 'TEST E: Missing RSI must yield score 0');

    const structMissing = extractStructureEvidence(2500, null as any, null as any, 2.0);
    assert.strictEqual(structMissing.evidenceScore, 0, 'TEST E: Missing structure must yield score 0');

    const liqMissing = extractLiquidityEvidence(2500, [], null as any);
    assert.strictEqual(liqMissing.evidenceScore, 0, 'TEST E: Empty 5M candles must yield liquidity score 0');
    console.log('✅ [PASS] TEST E: All missing evidence categories strictly evaluate to 0 points.\n');
  }

  // -------------------------------------------------------------------------
  // F. Valid structure and liquidity evidence can still earn points
  // -------------------------------------------------------------------------
  console.log('TEST F: Valid structure and liquidity evidence earn appropriate points');
  {
    const ind15mStruct: TechnicalIndicators = {
      structure: 'BULLISH',
      swingHigh: 2515,
      swingLow: 2485,
      marketRegime: 'STRONG_UPTREND',
      isDataSufficient: true,
    } as any;
    const ind5mStruct: TechnicalIndicators = {
      structure: 'BULLISH',
      isDataSufficient: true,
    } as any;
    const structRes = extractStructureEvidence(2516, ind15mStruct, ind5mStruct, 2.0);
    assert(structRes.evidenceScore >= 20, `TEST F: Directional structure + breakout + MTF alignment must score >= 20, got ${structRes.evidenceScore}`);

    // Liquidity SFP Sweep
    const candles5m = createCandles(30, 2500, 0.2);
    // Prior low is around 2499. Last candle sweeps low to 2495 and closes at 2502
    candles5m[candles5m.length - 1] = {
      timestamp: Date.now(),
      open: 2500,
      high: 2503,
      low: 2495, // below prior lowest
      close: 2502, // closed back inside range
      volume: 3000,
      isClosed: true,
    };
    const liqRes = extractLiquidityEvidence(2502, candles5m, ind15mStruct);
    assert.strictEqual(liqRes.isSfp, true, 'TEST F: SFP liquidity sweep must be detected');
    assert.strictEqual(liqRes.evidenceScore, 24, 'TEST F: Swept liquidity must earn 24 points');
    console.log('✅ [PASS] TEST F: Valid structure and liquidity earn full measured points.\n');
  }

  // -------------------------------------------------------------------------
  // G. Missing M1 ATR is not replaced by scaled M5 ATR
  // -------------------------------------------------------------------------
  console.log('TEST G: Missing M1 ATR is not replaced by scaled M5 ATR');
  {
    const bundleNo1m = buildCompleteEvidenceBundle({
      currentPrice: 2500,
      candles1m: [], // NO M1 candles
      candles5m: createCandles(30, 2500),
      candles15m: createCandles(30, 2500),
      candles1h: createCandles(30, 2500),
      indicators5m: { atr14: 3.0, isDataSufficient: true } as any,
      indicators15m: { atr14: 4.0, isDataSufficient: true } as any,
      indicators1h: { atr14: 6.0, isDataSufficient: true } as any,
    });
    assert.strictEqual(bundleNo1m.priceActionM1.rejectionQualityScore, 0, 'TEST G: priceActionM1 score must be 0 when candles1m is empty');
    assert.strictEqual(bundleNo1m.priceActionM1.displacementAtr, 0, 'TEST G: displacementAtr must be 0 (no synthetic 5M ATR substitution)');
    console.log('✅ [PASS] TEST G: Missing M1 ATR is cleanly marked unavailable without M5 substitution.\n');
  }

  // -------------------------------------------------------------------------
  // H. Valid M1 ATR is computed from closed M1 candles
  // -------------------------------------------------------------------------
  console.log('TEST H: Valid M1 ATR is computed from closed M1 candles');
  {
    const m1Candles = createCandles(30, 2500, 0.1);
    const expectedAtr = calculateATR(m1Candles, 14);
    assert(expectedAtr > 0, 'TEST H: Expected M1 ATR must be positive');

    const bundleWith1m = buildCompleteEvidenceBundle({
      currentPrice: 2500,
      candles1m: m1Candles,
      candles5m: createCandles(30, 2500),
      candles15m: createCandles(30, 2500),
      candles1h: createCandles(30, 2500),
      indicators5m: { atr14: 5.0, isDataSufficient: true } as any,
      indicators15m: { atr14: 6.0, isDataSufficient: true } as any,
      indicators1h: { atr14: 8.0, isDataSufficient: true } as any,
    });
    assert(bundleWith1m.priceActionM1.bodySizeRelativeAtr > 0, 'TEST H: bodySizeRelativeAtr must be computed using real M1 ATR');
    console.log(`✅ [PASS] TEST H: Valid M1 ATR (${expectedAtr}) calculated from closed M1 candles.\n`);
  }

  // -------------------------------------------------------------------------
  // I. Confidence can fall below 70 when evidence is weak, without introducing a new hard gate
  // -------------------------------------------------------------------------
  console.log('TEST I: Confidence can fall below 70 without arbitrary floor or candidate rejection');
  {
    const weakCandles1m = createCandles(30, 2500, 0.05);
    // Red pullback candle followed by moderate continuation trigger
    weakCandles1m[weakCandles1m.length - 2] = {
      timestamp: Date.now() - 60000,
      open: 2501.5,
      high: 2501.6,
      low: 2500.5,
      close: 2500.8, // countertrend red pullback
      volume: 800,
      isClosed: true,
    };
    weakCandles1m[weakCandles1m.length - 1] = {
      timestamp: Date.now(),
      open: 2500.8,
      high: 2501.8,
      low: 2500.7,
      close: 2501.6,
      volume: 800,
      isClosed: true,
    };
    const weakInd: TechnicalIndicators = {
      structure: 'BULLISH',
      swingHigh: 2510,
      swingLow: 2490,
      macd: { macd: 0, signal: 0, histogram: 0 }, // FLAT MACD = 0 pts
      rsi14: 50, // NEUTRAL RSI = 0 pts
      atr14: 1.5,
      isDataSufficient: true,
    } as any;

    const res = discoverGbv5Candidates({
      asset: 'XAU/USD',
      currentPrice: 2501.6,
      candles1m: weakCandles1m,
      candles5m: createCandles(30, 2500, 0.1),
      candles15m: createCandles(30, 2500, 0.1),
      candles1h: createCandles(30, 2500, 0.1),
      indicators5m: weakInd,
      indicators15m: weakInd,
      indicators1h: weakInd,
      currentSpread: 0.15,
    });

    assert(res.candidates.length > 0, 'TEST I: Valid candidate formation must be discovered even with weak supporting evidence');
    const cand = res.candidates[0];
    assert(cand.confidence < 70, `TEST I: Confidence must fall below 70 when MACD and RSI are neutral, got ${cand.confidence}`);
    assert(cand.confidence > 0, `TEST I: Confidence must remain positive deterministic score, got ${cand.confidence}`);

    // Strategy engine selection preserves candidate without dropping it
    const stratRes = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2501.6,
      candles1m: weakCandles1m,
      candles5m: createCandles(30, 2500, 0.1),
      candles15m: createCandles(30, 2500, 0.1),
      candles1h: createCandles(30, 2500, 0.1),
      indicators5m: weakInd,
      indicators15m: weakInd,
      indicators1h: weakInd,
    });
    assert(stratRes.selectedCandidate !== null, 'TEST I: selectedCandidate must not be null when candidate exists below 70 confidence');
    assert.strictEqual(stratRes.selectedCandidate!.confidence, cand.confidence, 'TEST I: Candidate confidence preserved in strategy engine');
    console.log(`✅ [PASS] TEST I: Candidate confidence fell naturally to ${cand.confidence}% (<70%) without being blocked.\n`);
  }

  // -------------------------------------------------------------------------
  // J. All four canonical families remain available when their genuine M1 formations exist
  // -------------------------------------------------------------------------
  console.log('TEST J: All four canonical families discoverable via genuine M1 formations');
  {
    const familiesFound = new Set<string>();

    // 1. LIQUIDITY_SWEEP_REJECTION
    {
      const c1m = createCandles(30, 2500, 0.1);
      c1m[c1m.length - 1] = {
        timestamp: Date.now(),
        open: 2492,
        high: 2494,
        low: 2488, // below swing low 2490
        close: 2493, // closed back up with lower wick
        volume: 2000,
        isClosed: true,
      };
      const ind: TechnicalIndicators = {
        structure: 'BULLISH',
        swingHigh: 2515,
        swingLow: 2490,
        atr14: 1.5,
        isDataSufficient: true,
      } as any;
      const res = discoverGbv5Candidates({
        asset: 'XAU/USD',
        currentPrice: 2493,
        candles1m: c1m,
        candles5m: createCandles(30, 2500),
        candles15m: createCandles(30, 2500),
        candles1h: createCandles(30, 2500),
        indicators5m: ind,
        indicators15m: ind,
        indicators1h: ind,
      });
      for (const c of res.candidates) familiesFound.add(c.family);
    }

    // 2. STRUCTURE_BREAK_RETEST
    {
      const c1m = createCandles(30, 2500, 0.1);
      c1m[c1m.length - 2] = {
        timestamp: Date.now() - 60000,
        open: 2512,
        high: 2518,
        low: 2511,
        close: 2517, // prior break above 2515 swing high
        volume: 2000,
        isClosed: true,
      };
      c1m[c1m.length - 1] = {
        timestamp: Date.now(),
        open: 2517,
        high: 2520,
        low: 2515.2, // retested 2515 and held above
        close: 2518,
        volume: 2500,
        isClosed: true,
      };
      const ind: TechnicalIndicators = {
        structure: 'BULLISH',
        swingHigh: 2515,
        swingLow: 2490,
        atr14: 1.5,
        isDataSufficient: true,
      } as any;
      const res = discoverGbv5Candidates({
        asset: 'XAU/USD',
        currentPrice: 2518,
        candles1m: c1m,
        candles5m: createCandles(30, 2500),
        candles15m: createCandles(30, 2500),
        candles1h: createCandles(30, 2500),
        indicators5m: ind,
        indicators15m: ind,
        indicators1h: ind,
      });
      for (const c of res.candidates) familiesFound.add(c.family);
    }

    // 3. TREND_CONTINUATION_PULLBACK
    {
      const c1m = createCandles(30, 2500, 0.1);
      c1m[c1m.length - 2] = {
        timestamp: Date.now() - 60000,
        open: 2503,
        high: 2503.2,
        low: 2501.5,
        close: 2502.0, // red pullback candle
        volume: 1200,
        isClosed: true,
      };
      c1m[c1m.length - 1] = {
        timestamp: Date.now(),
        open: 2502.0,
        high: 2505,
        low: 2501.8,
        close: 2504.5, // continuation trigger
        volume: 1500,
        isClosed: true,
      };
      const ind: TechnicalIndicators = {
        structure: 'BULLISH',
        swingHigh: 2515,
        swingLow: 2490,
        ema20: 2500,
        ema50: 2495,
        atr14: 1.5,
        isDataSufficient: true,
      } as any;
      const res = discoverGbv5Candidates({
        asset: 'XAU/USD',
        currentPrice: 2504.5,
        candles1m: c1m,
        candles5m: createCandles(30, 2500),
        candles15m: createCandles(30, 2500),
        candles1h: createCandles(30, 2500),
        indicators5m: ind,
        indicators15m: ind,
        indicators1h: ind,
      });
      for (const c of res.candidates) familiesFound.add(c.family);
    }

    // 4. RANGE_SWEEP_SFP
    {
      const c1m = createCandles(30, 2500, 0.1);
      c1m[c1m.length - 1] = {
        timestamp: Date.now(),
        open: 2491,
        high: 2493,
        low: 2489, // sweep of range low 2490
        close: 2492, // close back above
        volume: 2000,
        isClosed: true,
      };
      const ind: TechnicalIndicators = {
        structure: 'RANGING',
        swingHigh: 2510,
        swingLow: 2490,
        atr14: 1.5,
        isDataSufficient: true,
      } as any;
      const res = discoverGbv5Candidates({
        asset: 'XAU/USD',
        currentPrice: 2492,
        candles1m: c1m,
        candles5m: createCandles(30, 2500),
        candles15m: createCandles(30, 2500),
        candles1h: createCandles(30, 2500),
        indicators5m: ind,
        indicators15m: ind,
        indicators1h: ind,
      });
      for (const c of res.candidates) familiesFound.add(c.family);
    }

    assert(familiesFound.has('LIQUIDITY_SWEEP_REJECTION'), 'TEST J: LIQUIDITY_SWEEP_REJECTION must be discovered');
    assert(familiesFound.has('STRUCTURE_BREAK_RETEST'), 'TEST J: STRUCTURE_BREAK_RETEST must be discovered');
    assert(familiesFound.has('TREND_CONTINUATION_PULLBACK'), 'TEST J: TREND_CONTINUATION_PULLBACK must be discovered');
    assert(familiesFound.has('RANGE_SWEEP_SFP'), 'TEST J: RANGE_SWEEP_SFP must be discovered');
    console.log(`✅ [PASS] TEST J: All 4 canonical families successfully verified: ${Array.from(familiesFound).join(', ')}.\n`);
  }

  // -------------------------------------------------------------------------
  // K. Directional symmetry remains intact
  // -------------------------------------------------------------------------
  console.log('TEST K: Directional symmetry remains intact across Buy and Sell evidence');
  {
    const bullPA = extractPriceActionEvidence([
      { timestamp: 1, open: 2500, high: 2504, low: 2498, close: 2503, volume: 1000, isClosed: true },
    ], 2.0);
    const bearPA = extractPriceActionEvidence([
      { timestamp: 1, open: 2500, high: 2502, low: 2496, close: 2497, volume: 1000, isClosed: true },
    ], 2.0);
    assert.strictEqual(bullPA.rejectionQualityScore, bearPA.rejectionQualityScore, 'TEST K: Symmetric PA rejection scores');

    const bullMacd = extractMacdEvidence({ macd: { macd: 1.0, signal: 0.5, histogram: 0.5 }, isDataSufficient: true } as any);
    const bearMacd = extractMacdEvidence({ macd: { macd: -1.0, signal: -0.5, histogram: -0.5 }, isDataSufficient: true } as any);
    assert.strictEqual(bullMacd.evidenceScore, bearMacd.evidenceScore, 'TEST K: Symmetric MACD scores');

    const bullRsi = extractRsiEvidence({ rsi14: 65, isDataSufficient: true } as any);
    const bearRsi = extractRsiEvidence({ rsi14: 35, isDataSufficient: true } as any);
    assert.strictEqual(bullRsi.evidenceScore, bearRsi.evidenceScore, 'TEST K: Symmetric RSI scores');
    console.log('✅ [PASS] TEST K: 100% directional symmetry verified across evidence extractors.\n');
  }

  console.log('========================================================================');
  console.log('🎉 ALL PHASE 7A EVIDENCE INTEGRITY REGRESSION TESTS PASSED (11/11)!');
  console.log('========================================================================\n');
}

runPhase7EvidenceIntegrityRegressionTests().catch((err) => {
  console.error('❌ Phase 7A Regression Tests Failed:', err);
  process.exit(1);
});
