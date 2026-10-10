import assert from 'assert';
import { generateMultiStrategyCandidates, MultiStrategyEngineInput } from '../server/strategyEngine.js';
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

async function runM1PrimaryRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PHASE 5 M1 PRIMARY ENFORCEMENT REGRESSION TESTS');
  console.log('========================================================================\n');

  const indicators5m: TechnicalIndicators = {
    ema20: 2505,
    ema50: 2495,
    rsi: 55,
    macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
    atr: 2.0,
    vwap: 2500,
    structure: 'BULLISH',
    swingHigh: 2515,
    swingLow: 2485,
    support: 2485,
    resistance: 2515,
  } as any;

  const candles5m = createCandles(30, 2500, 0.2);
  const currentPrice = 2505;

  // -------------------------------------------------------------------------
  // A. NO M1 -> NO CANDIDATE
  // -------------------------------------------------------------------------
  console.log('Test A: No M1 candles -> No candidate');
  {
    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles5m,
      candles1m: [], // Empty M1
      indicators5m,
      indicators15m: indicators5m,
      indicators1h: indicators5m,
    };
    const res = generateMultiStrategyCandidates(input);
    assert.strictEqual(res.allCandidates.length, 0, 'Test A Failed: HTF context alone without M1 must produce 0 candidates');
    assert.strictEqual(res.selectedCandidate, null, 'Test A Failed: selectedCandidate must be null');
    console.log('✅ [PASS] Test A: No M1 candles correctly produced 0 candidates.');
  }

  // -------------------------------------------------------------------------
  // B. VALID M1 -> CANDIDATE POSSIBLE
  // -------------------------------------------------------------------------
  console.log('\nTest B: Valid M1 candles -> Candidate possible');
  {
    const candles1m = createCandles(30, 2500, 0.1);
    candles1m[candles1m.length - 2] = {
      timestamp: Date.now() - 60000,
      open: 2512,
      high: 2518,
      low: 2511,
      close: 2517, // broke above swingHigh 2515
      volume: 2000,
      isClosed: true,
    };
    candles1m[candles1m.length - 1] = {
      timestamp: Date.now(),
      open: 2517,
      high: 2520,
      low: 2515.2, // retested 2515 and held above
      close: 2518,
      volume: 2000,
      isClosed: true,
    };

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2518,
      candles5m,
      candles1m,
      indicators5m,
      indicators15m: indicators5m,
      indicators1h: indicators5m,
    };
    const res = generateMultiStrategyCandidates(input);
    assert(res.allCandidates.length > 0, 'Test B Failed: Valid M1 formation must produce candidates');
    assert(res.selectedCandidate !== null, 'Test B Failed: selectedCandidate must not be null');
    console.log(`✅ [PASS] Test B: Valid M1 formation successfully produced ${res.allCandidates.length} candidate(s).`);
  }

  // -------------------------------------------------------------------------
  // C. HTF CANNOT CREATE CANDIDATE
  // -------------------------------------------------------------------------
  console.log('\nTest C: Strong HTF setup evidence while M1 has no valid formation -> No candidate');
  {
    const candles1mNoFormation: Candle[] = [];
    const baseTime = Date.now() - 30 * 60000;
    for (let i = 0; i < 30; i++) {
      candles1mNoFormation.push({
        timestamp: baseTime + i * 60000,
        open: 2505,
        high: 2505,
        low: 2504.5,
        close: 2504.5, // Small bearish marubozu (no wicks, close < open, no displacement, no sweep, no break)
        volume: 500,
        isClosed: true,
      });
    }

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2504.5,
      candles5m,
      candles1m: candles1mNoFormation,
      indicators5m: { ...indicators5m, structure: 'BULLISH' },
      indicators15m: { ...indicators5m, structure: 'BULLISH' },
      indicators1h: { ...indicators5m, structure: 'BULLISH' },
    };
    const res = generateMultiStrategyCandidates(input);
    assert.strictEqual(res.allCandidates.length, 0, 'Test C Failed: HTF setup evidence alone must not create candidate without M1 formation');
    console.log('✅ [PASS] Test C: HTF setup without M1 formation produced 0 candidates.');
  }

  // -------------------------------------------------------------------------
  // D. M1 + HTF CONTEXT
  // -------------------------------------------------------------------------
  console.log('\nTest D: Valid M1 formation plus supporting HTF context');
  {
    const candles1m = createCandles(30, 2500, 0.1);
    candles1m[candles1m.length - 2] = {
      timestamp: Date.now() - 60000,
      open: 2512,
      high: 2518,
      low: 2511,
      close: 2517, // broke above swingHigh 2515
      volume: 2000,
      isClosed: true,
    };
    candles1m[candles1m.length - 1] = {
      timestamp: Date.now(),
      open: 2517,
      high: 2520,
      low: 2515.2, // retested 2515 and held
      close: 2518,
      volume: 2000,
      isClosed: true,
    };

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2518,
      candles5m,
      candles1m,
      indicators5m,
      indicators15m: indicators5m,
      indicators1h: indicators5m,
    };
    const res = generateMultiStrategyCandidates(input);
    assert(res.allCandidates.length > 0, 'Test D Failed: M1 + HTF context must produce candidate');
    console.log('✅ [PASS] Test D: Valid M1 formation + HTF context successfully generated candidate.');
  }

  // -------------------------------------------------------------------------
  // E. M1 DIRECTION
  // -------------------------------------------------------------------------
  console.log('\nTest E: Candidate direction derived from M1 formation');
  {
    const candles1mBear = createCandles(30, 2500, -0.1);
    candles1mBear[candles1mBear.length - 2] = {
      timestamp: Date.now() - 60000,
      open: 2488,
      high: 2489,
      low: 2482,
      close: 2483, // broke below swingLow 2485
      volume: 2500,
      isClosed: true,
    };
    candles1mBear[candles1mBear.length - 1] = {
      timestamp: Date.now(),
      open: 2483,
      high: 2484.8, // retested 2485 from below and held
      low: 2480,
      close: 2482,
      volume: 2500,
      isClosed: true,
    };

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2482,
      candles5m,
      candles1m: candles1mBear,
      indicators5m,
      indicators15m: indicators5m,
      indicators1h: indicators5m,
    };
    const res = generateMultiStrategyCandidates(input);
    assert(res.allCandidates.length > 0, 'Test E Failed: Bearish M1 formation must produce candidate');
    assert.strictEqual(res.selectedCandidate?.direction, 'SELL', 'Test E Failed: Candidate direction must be SELL derived from M1 bearish break');
    console.log('✅ [PASS] Test E: Candidate direction correctly derived as SELL from M1 bearish formation.');
  }

  // -------------------------------------------------------------------------
  // F. NO SYNTHETIC M1
  // -------------------------------------------------------------------------
  console.log('\nTest F: Missing/undefined M1 data does not create synthetic M1 candle');
  {
    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles5m,
      candles1m: undefined, // Missing M1
      indicators5m,
      indicators15m: indicators5m,
      indicators1h: indicators5m,
    };
    const res = generateMultiStrategyCandidates(input);
    assert.strictEqual(res.allCandidates.length, 0, 'Test F Failed: Missing M1 must not generate candidates or synthetic candles');
    console.log('✅ [PASS] Test F: Missing M1 resulted in 0 candidates (no synthetic M1 fallback).');
  }

  // -------------------------------------------------------------------------
  // G. EXACT FOUR FAMILIES
  // -------------------------------------------------------------------------
  console.log('\nTest G: Verify all generated candidate families belong only to the four canonical GB-V5 families');
  {
    const validFamilies = [
      'LIQUIDITY_SWEEP_REJECTION',
      'STRUCTURE_BREAK_RETEST',
      'TREND_CONTINUATION_PULLBACK',
      'RANGE_SWEEP_SFP',
    ];

    const candles1m = createCandles(30, 2500, 0.1);
    candles1m[candles1m.length - 2] = {
      timestamp: Date.now() - 60000,
      open: 2512,
      high: 2518,
      low: 2511,
      close: 2517, // broke above swingHigh 2515
      volume: 2000,
      isClosed: true,
    };
    candles1m[candles1m.length - 1] = {
      timestamp: Date.now(),
      open: 2517,
      high: 2520,
      low: 2515.2, // retested 2515 and held
      close: 2518,
      volume: 2000,
      isClosed: true,
    };

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2518,
      candles5m,
      candles1m,
      indicators5m,
      indicators15m: indicators5m,
      indicators1h: indicators5m,
    };
    const res = generateMultiStrategyCandidates(input);
    assert(res.allCandidates.length > 0, 'Test G: Must produce candidates to verify families');
    for (const c of res.allCandidates) {
      assert(validFamilies.includes(c.family), `Test G Failed: Invalid legacy family "${c.family}" detected. Must be one of the 4 canonical families.`);
    }
    console.log(`✅ [PASS] Test G: All ${res.allCandidates.length} generated candidates strictly belong to canonical GB-V5 families.`);
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL M1 PRIMARY REGRESSION TESTS PASSED (7/7)');
  console.log('========================================================================\n');
}

runM1PrimaryRegressionTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ M1 Primary Regression Tests Failed:', err);
    process.exit(1);
  });
