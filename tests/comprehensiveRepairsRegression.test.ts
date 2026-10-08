import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiProviderConfig, parseAndValidateAiResponse, resolveAiSignalWithDeterministicFallback } from '../server/geminiTrader.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { evaluateTradeRisk } from '../server/riskManager.js';
import { calculateDynamicTakeProfits } from '../server/tpEngine.js';
import { PoiFreshnessTracker, resolveFinalSignalConflict } from '../server/tradeQualityEngine.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function createMockCandle(time: number, open: number, high: number, low: number, close: number, volume: number = 100): Candle {
  return { timestamp: time, open, high, low, close, volume };
}

function createDummyIndicators(basePrice: number): TechnicalIndicators {
  return {
    ema20: basePrice - 0.5,
    ema50: basePrice - 1.5,
    ema200: basePrice - 5.0,
    vwap: basePrice - 0.2,
    rsi14: 52,
    atr14: 2.5,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    bollingerBands: { upper: basePrice + 3.0, middle: basePrice, lower: basePrice - 3.0 },
    swingHigh: basePrice + 4.0,
    swingLow: basePrice - 4.0,
    support: basePrice - 3.5,
    resistance: basePrice + 3.5,
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
  };
}

console.log('=== RUNNING COMPREHENSIVE REPAIRS REGRESSION SUITE ===');

// ============================================================================
// TEST 1: AI Provider Routing
// ============================================================================
console.log('\n--- 1. AI Provider Routing ---');
{
  const origEnv = { ...process.env };

  // Case A: Specific OpenRouter configuration
  process.env.AI_PROVIDER = 'openrouter';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-testkey1234567890';
  delete process.env.NVIDIA_API_KEY;
  const configOR = resolveAiProviderConfig();
  assert.equal(configOR.provider, 'openrouter', 'Should resolve openrouter when requested');
  assert.equal(configOR.apiKey, 'sk-or-v1-testkey1234567890');
  assert.ok(configOR.baseURL.includes('openrouter'), 'BaseURL should be openrouter');

  // Case B: Specific NVIDIA configuration
  process.env.AI_PROVIDER = 'nvidia';
  process.env.NVIDIA_API_KEY = 'nvapi-testkey1234567890';
  delete process.env.OPENROUTER_API_KEY;
  const configNV = resolveAiProviderConfig();
  assert.equal(configNV.provider, 'nvidia', 'Should resolve nvidia when requested');
  assert.equal(configNV.apiKey, 'nvapi-testkey1234567890');
  assert.ok(configNV.baseURL.includes('nvidia'), 'BaseURL should be nvidia');

  // Case C: Mismatch prevention - requested NVIDIA but only OpenRouter key is available
  process.env.AI_PROVIDER = 'nvidia';
  delete process.env.NVIDIA_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-testkey1234567890';
  const configMismatch = resolveAiProviderConfig();
  assert.equal(configMismatch.provider, 'none', 'Must NOT send OpenRouter key to NVIDIA');

  // Restore env
  process.env = origEnv;
  console.log('✔ AI Provider Routing passed');
}

// ============================================================================
// TEST 2: MSS After Liquidity Sweep in S4
// ============================================================================
console.log('\n--- 2. MSS After Liquidity Sweep in S4 ---');
{
  // Generate candles showing a prior swing low, a high sweep, followed by close below EMA20
  const candles: Candle[] = [];
  const baseTime = Date.now() - 50 * 5 * 60 * 1000;
  for (let i = 0; i < 40; i++) {
    // Dip down to 2638 around candle 15-20 and smoothly return to 2650
    if (i === 15) {
      candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2648, 2649, 2640, 2642));
    } else if (i === 16) {
      candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2642, 2644, 2638, 2642));
    } else if (i === 17) {
      candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2642, 2647, 2641, 2646));
    } else if (i === 18) {
      candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2646, 2650, 2645, 2650));
    } else {
      candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2650, 2651, 2649, 2650));
    }
  }
  // Candle 41: Sweeps high (2653.0 > 2651) then drops and closes back inside (2650.5 < 2651)
  candles.push(createMockCandle(baseTime + 41 * 5 * 60 * 1000, 2650, 2653.0, 2649.5, 2650.5));
  // Candle 42: Closes below EMA20 with strong bearish displacement closing at lows
  candles.push(createMockCandle(baseTime + 42 * 5 * 60 * 1000, 2650.5, 2651, 2648.4, 2648.5));

  const indicators = analyzeTechnicals(candles);
  assert.ok(indicators.mssDetected, 'MSS should be detected on sweep + EMA20 cross');
  assert.equal(indicators.mssDirection, 'BEARISH', 'MSS direction should be BEARISH');

  // Test S4 candidate generation with MSS
  const result = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 100,
    currentPrice: 2648.5,
    indicators1h: indicators,
    indicators15m: indicators,
    indicators5m: indicators,
    candles1h: candles,
    candles15m: candles,
    candles5m: candles,
    losingStreak: 0,
    brokerSpecs: { minRr: 1.0, minConfidence: 70 } as any,
  });

  console.log('Candidates generated in Test 2:', result.allCandidates.map(c => ({ name: c.setupName, family: c.strategyFamily, dir: c.direction })));

  const s4Cand = result.allCandidates.find(c => c.strategyFamily === 'MARKET_STRUCTURE' || c.setupName.includes('Market Structure') || c.setupName.includes('BOS / CHOCH'));
  assert.ok(s4Cand !== undefined, 'S4 candidate must be generated from MSS after sweep');
  assert.equal(s4Cand.direction, 'SELL', 'S4 candidate should be SELL on bearish MSS');
  console.log('✔ MSS after liquidity sweep in S4 passed');
}

// ============================================================================
// TEST 3: AI Confidence Calibration & Floor
// ============================================================================
console.log('\n--- 3. AI Confidence Calibration & Floor ---');
{
  // Valid JSON with 85 confidence
  const validParsed = parseAndValidateAiResponse(JSON.stringify({
    signal: 'BUY NOW',
    entry: 2650,
    stopLoss: 2645,
    tp1: 2658,
    confidence: 85,
    setup: 'Bullish Order Block'
  }));
  assert.equal(validParsed.confidence, 85);

  // Confidence out of bounds should throw
  assert.throws(() => {
    parseAndValidateAiResponse(JSON.stringify({
      signal: 'BUY NOW',
      confidence: 150,
      setup: 'Test'
    }));
  }, /Invalid "confidence"/);

  // Sub-floor confidence (< 70) should trigger fallback substitution or NO TRADE
  const subFloorParsed = parseAndValidateAiResponse(JSON.stringify({
    signal: 'BUY NOW',
    entry: 2650,
    stopLoss: 2645,
    tp1: 2658,
    confidence: 55,
    setup: 'Low Confidence Setup'
  }));

  const mockInput: any = {
    asset: 'XAU/USD',
    balance: 100,
    currentPrice: 2650,
    indicators1h: createDummyIndicators(2650),
    indicators15m: createDummyIndicators(2650),
    indicators5m: createDummyIndicators(2650),
    recent5mCandles: [],
    recent1mCandles: [],
    losingStreak: 0,
    brokerSpecs: { minConfidence: 70, minRr: 1.0 }
  };

  const resolved = resolveAiSignalWithDeterministicFallback(subFloorParsed, { allCandidates: [] }, mockInput);
  assert.equal(resolved.signal, 'NO TRADE', 'Sub-floor AI candidate must be rejected when no deterministic fallback');
  assert.ok(resolved.noTradeReason?.includes('الحد الأدنى'), 'Reason should cite sub-floor confidence');
  console.log('✔ AI confidence calibration and floor passed');
}

// ============================================================================
// TEST 4: S9 Range Breakout Volatility Squeeze Gate
// ============================================================================
console.log('\n--- 4. S9 Range Breakout Squeeze Gate ---');
{
  const indWide = createDummyIndicators(2650);
  indWide.bollingerBands = { upper: 2665, middle: 2650, lower: 2635 }; // 30-point wide BB (not a squeeze)
  indWide.compressionState = { isCompressed: false, squeezeRatio: 1.5, expansionTriggered: false };
  indWide.regimeContext = { volatilityRatio: 1.8, isOverextended: false } as any;

  // Uncompressed state should NOT generate S9 breakout
  const candles: Candle[] = [];
  const baseTime = Date.now() - 30 * 5 * 60 * 1000;
  for (let i = 0; i < 30; i++) {
    candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2650, 2655, 2645, 2650));
  }
  candles.push(createMockCandle(baseTime + 31 * 5 * 60 * 1000, 2650, 2660, 2649, 2659));

  const result = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 100,
    currentPrice: 2659,
    indicators1h: indWide,
    indicators15m: indWide,
    indicators5m: indWide,
    candles1h: candles,
    candles15m: candles,
    candles5m: candles,
    losingStreak: 0,
    brokerSpecs: { minRr: 1.0, minConfidence: 70 } as any,
  });

  const s9Cand = result.allCandidates.find(c => c.strategyFamily === 'RANGE_BREAKOUT_EXPANSION');
  assert.equal(s9Cand, undefined, 'S9 candidate must NOT trigger without preceding volatility squeeze');
  console.log('✔ S9 range breakout volatility squeeze gate passed');
}

// ============================================================================
// TEST 5: S7 Countertrend Scalp Strict Gating
// ============================================================================
console.log('\n--- 5. S7 Countertrend Scalp Strict Gating ---');
{
  const indNormal = createDummyIndicators(2650);
  indNormal.rsi14 = 55; // Normal RSI (not extreme)
  const candles: Candle[] = [];
  const baseTime = Date.now() - 20 * 5 * 60 * 1000;
  for (let i = 0; i < 20; i++) {
    candles.push(createMockCandle(baseTime + i * 5 * 60 * 1000, 2650, 2652, 2648, 2650));
  }

  const result = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 100,
    currentPrice: 2650,
    indicators1h: indNormal,
    indicators15m: indNormal,
    indicators5m: indNormal,
    candles1h: candles,
    candles15m: candles,
    candles5m: candles,
    losingStreak: 0,
    brokerSpecs: { minRr: 1.0, minConfidence: 70 } as any,
  });

  const s7Cand = result.allCandidates.find(c => c.strategyFamily === 'COUNTERTREND_SCALP');
  assert.equal(s7Cand, undefined, 'S7 countertrend must NOT trigger without extreme extension');
  console.log('✔ S7 countertrend scalp strict gating passed');
}

// ============================================================================
// TEST 6: Persistent POI Tracker & Mitigation Engine
// ============================================================================
console.log('\n--- 6. Persistent POI Tracker & Mitigation Engine ---');
{
  const tracker = new PoiFreshnessTracker();
  const createdTime = Date.now() - 60 * 5 * 60 * 1000;
  const poi = tracker.registerPoi('ORDER_BLOCK', '5M', 'BULLISH', 2655, 2650, createdTime);
  assert.equal(poi.state, 'FRESH');
  assert.equal(poi.tapCount, 0);

  // First touch
  tracker.recordTouch(poi.id, createdTime + 5 * 60 * 1000);
  const eval1 = tracker.evaluatePoiFreshness(poi.id);
  const poi1 = tracker.getPoi(poi.id)!;
  assert.equal(poi1.tapCount, 1);
  assert.equal(eval1.state, 'TESTED_ONCE');
  assert.equal(eval1.isFresh, true);

  // Second touch
  tracker.recordTouch(poi.id, createdTime + 10 * 60 * 1000);
  const eval2 = tracker.evaluatePoiFreshness(poi.id);
  const poi2 = tracker.getPoi(poi.id)!;
  assert.equal(poi2.tapCount, 2);
  assert.equal(eval2.state, 'TESTED_TWICE');
  assert.equal(eval2.isFresh, false);

  // Third touch -> Exhausted
  tracker.recordTouch(poi.id, createdTime + 15 * 60 * 1000);
  const eval3 = tracker.evaluatePoiFreshness(poi.id);
  const poi3 = tracker.getPoi(poi.id)!;
  assert.equal(poi3.tapCount, 3);
  assert.equal(eval3.state, 'EXHAUSTED');
  assert.equal(eval3.isFresh, false);
  console.log('✔ Persistent POI tracker passed');
}

// ============================================================================
// TEST 7: Stop Loss and Risk Engine Clamping & Mathematics
// ============================================================================
console.log('\n--- 7. Stop Loss and Risk Engine Safety ---');
{
  const risk = evaluateTradeRisk({
    balance: 100,
    entry: 2650,
    stopLoss: 2645.5, // 45 points (within [35, 65] pts)
    tp1: 2658,        // 80 points (1.78R >= 1.0R)
    confidence: 85,
    asset: 'XAU/USD',
    direction: 'BUY',
    orderType: 'MARKET',
    brokerSpecs: {
      accountBalance: 100,
      riskPercent: 15,
      contractSizeOz: 100,
      minimumLot: 0.01,
      minGoldSlPoints: 35,
      maxGoldSlPoints: 65,
      minRr: 1.0,
      maxLoss: 5.0,
    },
    allowExecutabilityOptimization: false,
  });

  assert.equal(risk.valid, true, 'Valid 45-point SL trade must pass risk validation');
  assert.equal(risk.slPoints, 45, 'Stop loss points must be 45');
  assert.ok(risk.tp1Rr >= 1.0, 'TP1 R:R must be >= 1.0');
  assert.equal(risk.positionSizing.isExecutable, true, 'Trade must be executable');

  // Out of bounds SL (< 35 points)
  const riskTooTight = evaluateTradeRisk({
    balance: 100,
    entry: 2650,
    stopLoss: 2648.5, // 15 points (< 35 min)
    tp1: 2655,
    confidence: 85,
    asset: 'XAU/USD',
    direction: 'BUY',
    brokerSpecs: { minGoldSlPoints: 35, maxGoldSlPoints: 65 },
    allowExecutabilityOptimization: false,
  });
  assert.equal(riskTooTight.valid, false, 'SL < 35 points must be rejected');

  // Out of bounds SL (> 65 points)
  const riskTooWide = evaluateTradeRisk({
    balance: 100,
    entry: 2650,
    stopLoss: 2642, // 80 points (> 65 max)
    tp1: 2670,
    confidence: 85,
    asset: 'XAU/USD',
    direction: 'BUY',
    brokerSpecs: { minGoldSlPoints: 35, maxGoldSlPoints: 65 },
    allowExecutabilityOptimization: false,
  });
  assert.equal(riskTooWide.valid, false, 'SL > 65 points must be rejected');
  console.log('✔ Stop loss and risk engine safety passed');
}

// ============================================================================
// TEST 8: Active Trade Arbitration Against Opposing Candidates
// ============================================================================
console.log('\n--- 8. Active Trade Arbitration ---');
{
  const activeTrade: any = {
    id: 'trade_1',
    signal: 'BUY NOW',
    direction: 'BUY',
    entry: 2650,
    stopLoss: 2645,
    tp1: 2658,
    setup: 'Active Bullish Continuation',
    score: 80,
  };

  const opposingCandidate: any = {
    id: 'cand_sell',
    signal: 'SELL NOW',
    direction: 'SELL',
    entry: 2655,
    stopLoss: 2660,
    tp1: 2648,
    setupName: 'Countertrend Bearish Rejection',
    score: 95, // Even with higher score, active trade must strictly block opposing signal
  };

  const arbitration = resolveFinalSignalConflict([opposingCandidate], activeTrade, 'TRENDING_UP');
  assert.equal(arbitration.winningCandidate, null, 'Opposing candidate must be strictly suppressed when active trade exists');
  assert.ok(arbitration.suppressedCandidates.some(s => s.reason.includes('OPPOSING_ACTIVE_BLOCKED')), 'Must log OPPOSING_ACTIVE_BLOCKED');
  console.log('✔ Active trade arbitration passed');
}

console.log('\n=================================================================');
console.log('ALL COMPREHENSIVE REPAIR REGRESSION TESTS COMPLETED SUCCESSFULLY!');
console.log('=================================================================');
