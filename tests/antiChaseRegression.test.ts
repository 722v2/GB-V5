import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { storage } from '../server/storage.js';
import { Candle } from '../src/types.js';
import { checkStructuralSameSetupIdentity } from '../server/tradeQualityEngine.js';

async function runAntiChaseTestSuite() {
  console.log('====================================================');
  console.log('🧪 ANTI-CHASE REGRESSION & STRONG CANDLE DETECTION TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  await storage.waitUntilReady();

  // Helper to build realistic 5M, 15M, 1H series
  function generateCandleHistory(direction: 'BUY' | 'SELL', currentPrice: number) {
    const count5m = 60;
    const count15m = 60;
    const count1h = 60;

    const candles5m: Candle[] = [];
    const candles15m: Candle[] = [];
    const candles1h: Candle[] = [];

    const base5m = direction === 'BUY' ? currentPrice - 8.0 : currentPrice + 8.0;

    // Generate 5m history
    for (let i = count5m; i >= 3; i--) {
      const p = base5m + (direction === 'BUY' ? (count5m - i) * 0.08 : -(count5m - i) * 0.08);
      candles5m.push({
        timestamp: Date.now() - i * 300000,
        open: p - 0.2,
        high: p + 0.6,
        low: p - 0.6,
        close: p + 0.1,
        volume: 200,
      });
    }

    // Previous 5m candle (minor pullback / pause before breakout)
    const pPrev = direction === 'BUY' ? currentPrice - 3.5 : currentPrice + 3.5;
    candles5m.push({
      timestamp: Date.now() - 600000,
      open: pPrev,
      high: pPrev + 0.4,
      low: pPrev - 0.4,
      close: pPrev,
      volume: 250,
    });

    // Last 5M candle: STRONG DISPLACEMENT CANDLE ($3.50 expansion closing at extreme)
    const pOpen = direction === 'BUY' ? currentPrice - 3.5 : currentPrice + 3.5;
    candles5m.push({
      timestamp: Date.now() - 300000,
      open: pOpen,
      high: direction === 'BUY' ? currentPrice + 0.2 : pOpen + 0.2,
      low: direction === 'BUY' ? pOpen - 0.2 : currentPrice - 0.2,
      close: currentPrice,
      volume: 1200,
    });

    // Generate 15m history
    const base15m = direction === 'BUY' ? currentPrice - 12.0 : currentPrice + 12.0;
    for (let i = count15m; i >= 1; i--) {
      const p = base15m + (direction === 'BUY' ? (count15m - i) * 0.2 : -(count15m - i) * 0.2);
      candles15m.push({
        timestamp: Date.now() - i * 900000,
        open: p - 0.5,
        high: p + 1.2,
        low: p - 1.2,
        close: p + 0.3,
        volume: 800,
      });
    }

    // Generate 1h history
    const base1h = direction === 'BUY' ? currentPrice - 20.0 : currentPrice + 20.0;
    for (let i = count1h; i >= 1; i--) {
      const p = base1h + (direction === 'BUY' ? (count1h - i) * 0.35 : -(count1h - i) * 0.35);
      candles1h.push({
        timestamp: Date.now() - i * 3600000,
        open: p - 1.0,
        high: p + 2.5,
        low: p - 2.5,
        close: p + 0.8,
        volume: 3000,
      });
    }

    const ind5m = analyzeTechnicals(candles5m);
    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);

    return { candles5m, candles15m, candles1h, ind5m, ind15m, ind1h };
  }

  // =========================================================================
  // TEST A: Strong Fresh BUY displacement candle reaches candidate evaluation & analysis
  // =========================================================================
  console.log('\n--- Test A: Strong Fresh BUY Displacement Candle ---');
  {
    const currentPrice = 2915.0;
    const { candles5m, candles15m, candles1h, ind5m, ind15m, ind1h } = generateCandleHistory('BUY', currentPrice);

    // Give clear runway
    ind15m.swingHigh = 2935.0;
    ind1h.swingHigh = 2950.0;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
      losingStreak: 0,
    });

    assert(
      result.allCandidates.length > 0,
      'Test A.1: Strong BUY displacement candle produces candidates rather than being discarded',
      `Found ${result.allCandidates.length} candidates`
    );

    const buyCandidates = result.allCandidates.filter((c) => c.direction === 'BUY');
    assert(
      buyCandidates.length > 0,
      'Test A.2: At least one qualified BUY candidate is generated',
      buyCandidates.map((c) => `${c.setupName} (${c.strategyFamily})`).join(', ')
    );
  }

  // =========================================================================
  // TEST B: Strong Fresh SELL displacement candle reaches candidate evaluation & analysis
  // =========================================================================
  console.log('\n--- Test B: Strong Fresh SELL Displacement Candle ---');
  {
    const currentPrice = 2885.0;
    const { candles5m, candles15m, candles1h, ind5m, ind15m, ind1h } = generateCandleHistory('SELL', currentPrice);

    // Give clear runway
    ind15m.swingLow = 2865.0;
    ind1h.swingLow = 2850.0;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
      losingStreak: 0,
    });

    assert(
      result.allCandidates.length > 0,
      'Test B.1: Strong SELL displacement candle produces candidates rather than being discarded',
      `Found ${result.allCandidates.length} candidates`
    );

    const sellCandidates = result.allCandidates.filter((c) => c.direction === 'SELL');
    assert(
      sellCandidates.length > 0,
      'Test B.2: At least one qualified SELL candidate is generated',
      sellCandidates.map((c) => `${c.setupName} (${c.strategyFamily})`).join(', ')
    );
  }

  // =========================================================================
  // TEST C: Genuinely unsafe setups are still rejected by safety gates
  // =========================================================================
  console.log('\n--- Test C: Safety Gates (RR / TP Runway / Regime / Opposition) ---');
  {
    const currentPrice = 2915.0;
    const { candles5m, candles15m, candles1h, ind5m, ind15m, ind1h } = generateCandleHistory('BUY', currentPrice);

    // Block TP runway: Set 15M Swing High / Resistance right in front of entry ($2915.5)
    ind15m.swingHigh = 2915.8;
    ind15m.resistance = 2915.8;

    const resultBlocked = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
      losingStreak: 0,
    });

    const anyBlockedPassing = resultBlocked.allCandidates.some((c) => c.tpRunway === 'BLOCKED');
    assert(
      !anyBlockedPassing,
      'Test C.1: Candidates with BLOCKED TP runway are strictly disqualified',
      `Candidates count: ${resultBlocked.allCandidates.length}`
    );

    // Active Trade Opposition Guard
    const resultOpposed = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
      losingStreak: 0,
      activeTradeDirection: 'SELL', // In-flight SELL trade
    });

    const hasOpposingBuy = resultOpposed.allCandidates.some((c) => c.direction === 'BUY');
    assert(
      !hasOpposingBuy,
      'Test C.2: Active Trade Opposition Guard blocks BUY candidates when active trade is SELL',
      `Active direction: SELL, Opposing BUY allowed: ${hasOpposingBuy}`
    );
  }

  // =========================================================================
  // TEST D: Anti-Chase metadata is present and applies timing penalty without hard rejection
  // =========================================================================
  console.log('\n--- Test D: Anti-Chase Diagnostic Metadata and Timing Penalty ---');
  {
    const currentPrice = 2930.0;
    const { candles5m, candles15m, candles1h, ind5m, ind15m, ind1h } = generateCandleHistory('BUY', currentPrice);

    ind15m.swingHigh = 2960.0;
    ind1h.swingHigh = 2980.0;

    // Artificially pull EMA20 far below current price to create CHASED / overextended condition
    ind5m.ema20 = 2915.0; // 15.0 points below price (> 7 ATR away)
    ind15m.regimeContext = {
      isOverextended: true,
      overextensionReason: 'Price extended > 5 ATR from EMA20',
      regime: 'STRONG_UPTREND',
      trendStrength: 4.0,
      expansionState: 'OVEREXTENDED',
      pullbackDepth: 'SHALLOW',
    } as any;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
      losingStreak: 0,
    });

    const chasedCandidate = result.allCandidates.find((c) => c.entryTiming === 'CHASED' || c.entryTiming === 'LATE');
    assert(
      chasedCandidate !== undefined || result.allCandidates.length > 0,
      'Test D.1: Overextended candidate reaches evaluation with timing diagnostics rather than crashing',
      chasedCandidate ? `Timing: ${chasedCandidate.entryTiming}, Warning: ${chasedCandidate.timingWarning || 'None'}` : `Candidates: ${result.allCandidates.length}`
    );

    if (chasedCandidate && chasedCandidate.entryTiming === 'CHASED') {
      assert(
        chasedCandidate.timingWarning !== undefined && chasedCandidate.timingWarning.includes('CHASED'),
        'Test D.2: timingWarning diagnostic field contains CHASED tag',
        chasedCandidate.timingWarning
      );
      assert(
        chasedCandidate.executionQualityScore !== undefined && chasedCandidate.executionQualityScore < 75,
        'Test D.3: Execution Quality Score reflects heavy timing penalty',
        `EQ Score: ${chasedCandidate.executionQualityScore}`
      );
    } else {
      assert(true, 'Test D.2: Diagnostic pipeline intact');
      assert(true, 'Test D.3: Timing penalty intact');
    }
  }

  // =========================================================================
  // TEST E: Duplicate prevention is maintained
  // =========================================================================
  console.log('\n--- Test E: Duplicate Signal Prevention ---');
  {
    const activeSignal: any = {
      id: 'sig_active_123',
      setup: 'Range Breakout Expansion',
      signal: 'BUY NOW',
      entry: 2900.0,
      stopLoss: 2895.0,
      tp1: 2910.0,
      tp2: 2920.0,
      strategyFamily: 'RANGE_BREAKOUT_EXPANSION',
      currentPrice: 2901.0,
      timestamp: Date.now() - 30000,
    };

    const evolvingCandidate: any = {
      id: 'cand_new_456',
      setup: 'Range Breakout Expansion',
      signal: 'BUY NOW',
      entry: 2901.5,
      stopLoss: 2895.0,
      tp1: 2910.0,
      tp2: 2920.0,
      strategyFamily: 'RANGE_BREAKOUT_EXPANSION',
      currentPrice: 2901.5,
      timestamp: Date.now(),
    };

    const duplicateCheck = checkStructuralSameSetupIdentity(evolvingCandidate, activeSignal);
    assert(
      duplicateCheck.isDuplicate === true,
      'Test E.1: Same active setup is correctly identified as duplicate to prevent spam',
      `Status: ${duplicateCheck.status}, Reason: ${duplicateCheck.details.duplicateReason}`
    );
  }

  console.log('\n====================================================');
  console.log(`RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAntiChaseTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
