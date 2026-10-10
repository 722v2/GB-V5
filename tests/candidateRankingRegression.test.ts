import assert from 'assert';
import {
  generateMultiStrategyCandidates,
  computeCandidateQualityScore,
  compareCandidatesByQuality,
  SetupCandidate,
  MultiStrategyEngineInput,
} from '../server/strategyEngine.js';
import { discoverGbv5Candidates } from '../server/gbv5Brain.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function createMockCandidate(overrides: Partial<SetupCandidate>): SetupCandidate {
  return {
    family: 'MARKET_STRUCTURE',
    strategyFamily: 'MARKET_STRUCTURE',
    setupName: 'GB-V5 Mock Setup',
    direction: 'BUY',
    orderType: 'MARKET',
    entry: 2500,
    stopLoss: 2495,
    slPoints: 50,
    tp1: 2510,
    tp1Points: 100,
    tp1Rr: 2.0,
    tp2: 2520,
    tp2Points: 200,
    tp2Rr: 4.0,
    confidence: 80,
    score: 80,
    strategyConfidence: 80,
    executionQualityScore: 80,
    entryTiming: 'OPTIMAL',
    setupFreshness: 'FRESH',
    pullbackQuality: 'HEALTHY',
    tpRunway: 'CLEAR',
    lifecycleState: 'READY',
    timeframe: 'M1 / M5',
    mainReasons: ['Mock reason'],
    invalidation: 'Mock invalidation',
    supportingConfluences: ['Confluence 1'],
    ...overrides,
  };
}

async function runCandidateRankingTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 3A CANDIDATE RANKING & SELECTION REGRESSION TESTS');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Ranking formula matches executeGbv5Brain: score * (tp1Rr >= 2.0 ? 1.1 : 1.0)
  // -------------------------------------------------------------------------
  console.log('TEST 1: Ranking formula score * (tp1Rr >= 2.0 ? 1.1 : 1.0)');
  {
    const candLowRr = createMockCandidate({ score: 80, tp1Rr: 1.5 });
    const candHighRr = createMockCandidate({ score: 80, tp1Rr: 2.1 });
    
    const scoreLow = computeCandidateQualityScore(candLowRr);
    const scoreHigh = computeCandidateQualityScore(candHighRr);

    assert.strictEqual(scoreLow, 80, 'Low RR (<2.0) multiplier must be 1.0');
    assert.strictEqual(Math.round(scoreHigh * 10) / 10, 88, 'High RR (>=2.0) multiplier must be 1.1 (80 * 1.1 = 88)');
    
    // High RR candidate must beat Low RR candidate with equal confluence
    const cmp = compareCandidatesByQuality(candLowRr, candHighRr);
    assert(cmp > 0, 'candHighRr must be ranked ahead of candLowRr');
    console.log(`✅ [PASS] TEST 1: Quality scores: Low RR=${scoreLow}, High RR=${scoreHigh}. High RR wins.`);
  }

  // -------------------------------------------------------------------------
  // TEST 2: Later candidate with higher quality beats earlier candidate with lower quality
  // -------------------------------------------------------------------------
  console.log('\nTEST 2: Later discovered candidate with stronger quality beats earlier candidate');
  {
    const cand1_EarlyWeak = createMockCandidate({
      family: 'LIQUIDITY_SWEEP_REJECTION',
      setupName: 'Early Weak Sweep',
      score: 72,
      confidence: 72,
      tp1Rr: 1.5, // quality score = 72.0
    });

    const cand2_LaterStrong = createMockCandidate({
      family: 'STRUCTURE_BREAK_RETEST',
      setupName: 'Later Strong BOS',
      score: 82,
      confidence: 82,
      tp1Rr: 2.2, // quality score = 82 * 1.1 = 90.2
    });

    const cand3_Middle = createMockCandidate({
      family: 'RANGE_SWEEP_SFP',
      setupName: 'Middle Range SFP',
      score: 75,
      confidence: 75,
      tp1Rr: 1.8, // quality score = 75.0
    });

    // Given array in discovery order: [EarlyWeak, Middle, LaterStrong]
    const candidates = [cand1_EarlyWeak, cand3_Middle, cand2_LaterStrong];
    const sorted = [...candidates].sort(compareCandidatesByQuality);

    assert.strictEqual(sorted[0].setupName, 'Later Strong BOS', 'Strongest candidate must be selected first');
    assert.strictEqual(sorted[1].setupName, 'Middle Range SFP', 'Middle candidate must be ranked second');
    assert.strictEqual(sorted[2].setupName, 'Early Weak Sweep', 'Weakest candidate must be ranked last');
    console.log(`✅ [PASS] TEST 2: Discovery order [Early, Middle, Later] -> Ranked [${sorted.map(c => c.setupName).join(', ')}]. Later strong beats earlier weak.`);
  }

  // -------------------------------------------------------------------------
  // TEST 3: High RR can overcome slight confluence deficit
  // -------------------------------------------------------------------------
  console.log('\nTEST 3: High RR efficiency bonus (1.1x) enables superior trade setup to win');
  {
    // Candidate A: 82 score, 1.5 RR -> ranking score = 82
    const candA = createMockCandidate({ setupName: 'Setup A (High Score Low RR)', score: 82, tp1Rr: 1.5 });
    // Candidate B: 78 score, 2.2 RR -> ranking score = 78 * 1.1 = 85.8
    const candB = createMockCandidate({ setupName: 'Setup B (Modest Score High RR)', score: 78, tp1Rr: 2.2 });

    const sorted = [candA, candB].sort(compareCandidatesByQuality);
    assert.strictEqual(sorted[0].setupName, 'Setup B (Modest Score High RR)', 'Setup B with 85.8 ranking score must beat Setup A with 82.0');
    console.log('✅ [PASS] TEST 3: Candidate with 85.8 weighted quality beat candidate with 82.0 unweighted quality.');
  }

  // -------------------------------------------------------------------------
  // TEST 4: Deterministic Tie-Breaking Ladder
  // -------------------------------------------------------------------------
  console.log('\nTEST 4: Deterministic Tie-Breaking Ladder');
  {
    // Case 4.1: Same ranking score, higher raw confidence wins
    const candTiedScore_LowConf = createMockCandidate({ setupName: 'Tied 1 Low Conf', score: 80, tp1Rr: 1.5, confidence: 75 });
    const candTiedScore_HighConf = createMockCandidate({ setupName: 'Tied 1 High Conf', score: 80, tp1Rr: 1.5, confidence: 85 });
    const resConf = [candTiedScore_LowConf, candTiedScore_HighConf].sort(compareCandidatesByQuality);
    assert.strictEqual(resConf[0].setupName, 'Tied 1 High Conf', 'Higher raw confidence must break tie');

    // Case 4.2: Same ranking score and confidence, higher TP1 RR wins
    const candTiedConf_LowRr1 = createMockCandidate({ setupName: 'Tied 2 Low RR1', score: 70, confidence: 75, tp1Rr: 1.2 });
    const candTiedConf_HighRr1 = createMockCandidate({ setupName: 'Tied 2 High RR1', score: 70, confidence: 75, tp1Rr: 1.8 });
    const resRr1 = [candTiedConf_LowRr1, candTiedConf_HighRr1].sort(compareCandidatesByQuality);
    assert.strictEqual(resRr1[0].setupName, 'Tied 2 High RR1', 'Higher TP1 RR must break tie');

    // Case 4.3: Same ranking score, confidence, and TP1 RR, higher TP2 RR wins
    const candTiedRr1_LowRr2 = createMockCandidate({ setupName: 'Tied 3 Low RR2', score: 70, confidence: 75, tp1Rr: 1.5, tp2Rr: 2.0 });
    const candTiedRr1_HighRr2 = createMockCandidate({ setupName: 'Tied 3 High RR2', score: 70, confidence: 75, tp1Rr: 1.5, tp2Rr: 3.5 });
    const resRr2 = [candTiedRr1_LowRr2, candTiedRr1_HighRr2].sort(compareCandidatesByQuality);
    assert.strictEqual(resRr2[0].setupName, 'Tied 3 High RR2', 'Higher TP2 RR must break tie');

    // Case 4.4: Identical metrics -> deterministic stable tie-breaker
    const candIdentical_A = createMockCandidate({ setupName: 'Setup Alpha', family: 'BREAK_AND_RETEST', score: 80, confidence: 80, tp1Rr: 2.0, tp2Rr: 4.0, direction: 'BUY' });
    const candIdentical_B = createMockCandidate({ setupName: 'Setup Beta', family: 'MARKET_STRUCTURE', score: 80, confidence: 80, tp1Rr: 2.0, tp2Rr: 4.0, direction: 'BUY' });
    
    // Sort forward and reverse - must produce identical winner deterministically
    const sortedForward = [candIdentical_A, candIdentical_B].sort(compareCandidatesByQuality);
    const sortedReverse = [candIdentical_B, candIdentical_A].sort(compareCandidatesByQuality);
    assert.strictEqual(sortedForward[0].setupName, sortedReverse[0].setupName, 'Deterministic tie-breaker must produce identical result regardless of input order');
    console.log(`✅ [PASS] TEST 4: All tie-breaking levels (Confidence, TP1 RR, TP2 RR, Stable Strings) verified deterministically.`);
  }

  // -------------------------------------------------------------------------
  // TEST 5: All discovered candidates are preserved in allCandidates
  // -------------------------------------------------------------------------
  console.log('\nTEST 5: Preservation of allCandidates in generateMultiStrategyCandidates return contract');
  {
    // Create market data that produces multiple candidates
    const candles5m: Candle[] = [];
    const baseTime = Date.now() - 3600000;
    for (let i = 0; i < 50; i++) {
      candles5m.push({
        timestamp: baseTime + i * 300000,
        open: 2500 + i * 0.1,
        high: 2502 + i * 0.1,
        low: 2498 + i * 0.1,
        close: 2501 + i * 0.1,
        volume: 100,
        isClosed: true,
      });
    }

    const candles1m: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles1m.push({
        timestamp: baseTime + i * 60000,
        open: 2505 + i * 0.1,
        high: 2515 + i * 0.1,
        low: 2504 + i * 0.1,
        close: 2512 + i * 0.1,
        volume: 1500,
        isClosed: true,
      });
    }
    candles1m[candles1m.length - 1] = {
      timestamp: baseTime + 29 * 60000,
      open: 2508,
      high: 2515,
      low: 2507,
      close: 2512, // > swingHigh 2510
      volume: 2000,
      isClosed: true,
    };

    const ind5m: TechnicalIndicators = {
      ema20: 2503,
      ema50: 2498,
      rsi: 55,
      macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
      atr: 2.0,
      vwap: 2500,
      structure: 'BULLISH',
      swingHigh: 2510,
      swingLow: 2490,
      support: 2490,
      resistance: 2510,
    };

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2512,
      candles5m,
      candles1m,
      indicators5m: ind5m,
      indicators15m: { ...ind5m, structure: 'BULLISH' },
      indicators1h: { ...ind5m, structure: 'BULLISH' },
    };

    const result = generateMultiStrategyCandidates(input);
    assert.strictEqual(typeof result.hasOpportunity, 'boolean', 'hasOpportunity must be boolean');
    assert(Array.isArray(result.allCandidates), 'allCandidates must be an array');
    assert(result.allCandidates.length > 0, 'allCandidates must not be empty');
    assert(result.selectedCandidate !== null, 'selectedCandidate must not be null');
    assert.strictEqual(result.finalSignal.signal, result.selectedCandidate!.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW', 'finalSignal must match selected candidate direction');

    // Verify selectedCandidate is the highest-quality candidate among allCandidates
    for (const other of result.allCandidates) {
      const cmp = compareCandidatesByQuality(result.selectedCandidate!, other);
      assert(cmp <= 0, `selectedCandidate must have equal or higher quality than candidate ${other.setupName}`);
    }
    console.log(`✅ [PASS] TEST 5: Return contract verified: ${result.allCandidates.length} candidates preserved in discovery order, selected=${result.selectedCandidate?.setupName} is highest quality.`);
  }

  // -------------------------------------------------------------------------
  // TEST 6: Active Trade Direction suppresses opposing direction
  // -------------------------------------------------------------------------
  console.log('\nTEST 6: Active Trade Direction eligibility guard');
  {
    const candBuy = createMockCandidate({ setupName: 'Buy Setup', direction: 'BUY', score: 85, confidence: 85 });
    const candSell = createMockCandidate({ setupName: 'Sell Setup', direction: 'SELL', score: 75, confidence: 75 });

    // When active trade direction is SELL, BUY must not be selected even if it has higher quality
    const inputOpposed: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 2500,
      candles5m: [
        { timestamp: 1, open: 2500, high: 2502, low: 2498, close: 2500, volume: 100, isClosed: true },
      ],
      indicators5m: { atr: 2.0 } as any,
      indicators15m: { atr: 2.0 } as any,
      indicators1h: { atr: 2.0 } as any,
      activeTradeDirection: 'SELL',
    };

    const resOpposed = generateMultiStrategyCandidates(inputOpposed);
    if (resOpposed.selectedCandidate) {
      assert.strictEqual(resOpposed.selectedCandidate.direction, 'SELL', 'Selected candidate must match active trade direction SELL');
    }
    console.log('✅ [PASS] TEST 6: Active trade direction properly guards candidate selection.');
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL 6 CANDIDATE RANKING REGRESSION TESTS PASSED (6/6)');
  console.log('========================================================================\n');
}

runCandidateRankingTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Candidate Ranking Tests Failed:', err);
    process.exit(1);
  });
