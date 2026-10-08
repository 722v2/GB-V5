import assert from 'assert';
import { runAIAnalysis, algorithmicScreening, MarketAnalysisInput } from '../server/geminiTrader.js';
import { evaluateTradeRisk } from '../server/riskManager.js';
import { generate100Scenarios } from './benchmark100Regression.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

async function runPipelineContractTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PRODUCTION PIPELINE CONTRACT REGRESSION TESTS (5 TESTS)');
  console.log('========================================================================\n');

  // Load benchmark scenario 0 which generates a live GB-V5 candidate
  const sc0 = generate100Scenarios()[0];
  const sc0Data = sc0.generateData();
  const sc0Price = sc0Data.candles5m[sc0Data.candles5m.length - 1].close;

  const inputWithCandidate: MarketAnalysisInput = {
    asset: 'XAU/USD',
    balance: 100,
    currentPrice: sc0Price,
    indicators1h: sc0Data.indicators1h,
    indicators15m: sc0Data.indicators15m,
    indicators5m: sc0Data.indicators5m,
    recent5mCandles: sc0Data.candles5m,
    recent1mCandles: sc0Data.candles1m,
    candles1h: sc0Data.candles1h,
    candles15m: sc0Data.candles15m,
    losingStreak: 0,
    brokerSpecs: {
      minSlPoints: 35,
      maxSlPoints: 85,
      minRr: 1.0,
      contractSizeOz: 100,
      minimumLot: 0.01,
      maximumLot: 100,
      lotStep: 0.01,
      accountBalance: 100,
      riskPercent: 1.5,
    },
  };

  // -------------------------------------------------------------------------
  // TEST 1: Candidate exists in algorithmicScreening -> Confidence is NOT 0
  // -------------------------------------------------------------------------
  console.log('TEST 1: Candidate exists in algorithmicScreening -> Confidence preserved (>0) and setup is not fallback');
  const algoRes = algorithmicScreening(inputWithCandidate);
  assert.notStrictEqual(algoRes.decision, 'NO TRADE', 'TEST 1 Failed: algorithmicScreening must detect the candidate');
  assert(algoRes.confidence >= 70, `TEST 1 Failed: expected confidence >= 70, got ${algoRes.confidence}`);
  assert.notStrictEqual(algoRes.setup, 'NO TRADE (Waiting for GB-V5 setup)', 'TEST 1 Failed: setup must be the discovered candidate setup');
  assert(algoRes.setup.startsWith('GB-V5'), `TEST 1 Failed: setup name should start with GB-V5, got ${algoRes.setup}`);
  console.log(`✅ [PASS] TEST 1: algorithmicScreening detected candidate with confidence=${algoRes.confidence}% (${algoRes.setup}).\n`);

  // -------------------------------------------------------------------------
  // TEST 2: Verify evaluateTradeRisk input contract
  // -------------------------------------------------------------------------
  console.log('TEST 2: Verify evaluateTradeRisk receives canonical parameters (balance, entry, stopLoss, tp1, tp2, direction)');
  const riskDirection: 'BUY' | 'SELL' = algoRes.decision.toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
  
  // Call evaluateTradeRisk using the exact parameter contract passed by geminiTrader.ts
  const riskEval = evaluateTradeRisk({
    balance: inputWithCandidate.balance,
    entry: algoRes.entry,
    stopLoss: algoRes.stopLoss,
    tp1: algoRes.tp1,
    tp2: algoRes.tp2,
    direction: riskDirection,
    confidence: algoRes.confidence,
    brokerSpecs: inputWithCandidate.brokerSpecs,
    riskPercent: 1.5,
    asset: 'XAU/USD',
  });

  // Verify that passing these exact properties does not throw or fail due to undefined balance/entry/stopLoss
  assert.strictEqual(typeof riskEval.slPoints, 'number', 'TEST 2 Failed: slPoints must be calculated as a number');
  assert.strictEqual(typeof riskEval.riskPercent, 'number', 'TEST 2 Failed: riskPercent must be a number');
  assert.strictEqual(typeof riskEval.tp1Points, 'number', 'TEST 2 Failed: tp1Points must be calculated as a number');
  console.log(`✅ [PASS] TEST 2: evaluateTradeRisk accepted canonical input params (slPoints=${riskEval.slPoints}, tp1Points=${riskEval.tp1Points}).\n`);

  // -------------------------------------------------------------------------
  // TEST 3: Verify Risk result fields are mapped correctly from actual fields
  // -------------------------------------------------------------------------
  console.log('TEST 3: Verify Risk result contract has positionSizing, riskAmount, and recommendedLotSize');
  assert.strictEqual(typeof riskEval.riskAmount, 'number', 'TEST 3 Failed: riskAmount must be a number');
  assert.strictEqual(typeof riskEval.recommendedLotSize, 'number', 'TEST 3 Failed: recommendedLotSize must be a number');
  assert(riskEval.positionSizing !== undefined, 'TEST 3 Failed: positionSizing must be defined');
  assert.strictEqual(typeof riskEval.positionSizing.riskDollars, 'number', 'TEST 3 Failed: positionSizing.riskDollars must be a number');
  assert.strictEqual(typeof riskEval.positionSizing.isExecutable, 'boolean', 'TEST 3 Failed: positionSizing.isExecutable must be boolean');
  console.log(`✅ [PASS] TEST 3: Risk result fields and positionSizing are valid (riskAmount=${riskEval.riskAmount}, isExecutable=${riskEval.positionSizing.isExecutable}).\n`);

  // -------------------------------------------------------------------------
  // TEST 4: No Candidate (shaved candles with no sweep/break) -> NO TRADE, confidence = 0
  // -------------------------------------------------------------------------
  console.log('TEST 4: Genuinely empty candidate scenario -> NO TRADE, confidence = 0, setup = fallback');
  const base = 2500;
  const noSetupCandles: Candle[] = [{ timestamp: 1, open: 2500.0, high: 2500.2, low: 2500.0, close: 2500.2, volume: 100, isClosed: true }];
  const noSetupInd: TechnicalIndicators = {
    swingHigh: 2520,
    swingLow: 2480,
    support: 2470,
    resistance: 2530,
    structure: 'RANGING',
    atr14: 1.5,
    rsi14: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    ema9: 2500,
    ema20: 2500,
    ema50: 2500,
    ema200: 2500,
    bollingerBands: { upper: 2510, middle: 2500, lower: 2490, bandwidth: 20 },
    pivotPoints: { pivot: 2500, r1: 2510, s1: 2490, r2: 2520, s2: 2480 },
  };

  const noSetupInput: MarketAnalysisInput = {
    asset: 'XAU/USD',
    balance: 100,
    currentPrice: 2500.1,
    indicators1h: noSetupInd,
    indicators15m: noSetupInd,
    indicators5m: noSetupInd,
    recent5mCandles: noSetupCandles,
    recent1mCandles: noSetupCandles,
    candles1h: noSetupCandles,
    candles15m: noSetupCandles,
    losingStreak: 0,
    brokerSpecs: inputWithCandidate.brokerSpecs,
  };

  const signalFlat = await runAIAnalysis(noSetupInput);
  assert.strictEqual(signalFlat.signal, 'NO TRADE', `TEST 4 Failed: expected NO TRADE, got ${signalFlat.signal}`);
  assert.strictEqual(signalFlat.confidence, 0, `TEST 4 Failed: expected confidence 0, got ${signalFlat.confidence}`);
  assert.strictEqual(signalFlat.setup, 'NO TRADE (Waiting for GB-V5 setup)', `TEST 4 Failed: expected fallback setup, got ${signalFlat.setup}`);
  console.log('✅ [PASS] TEST 4: Market with no candidate returns NO TRADE with confidence=0.\n');

  // -------------------------------------------------------------------------
  // TEST 5: Candidate exists but Risk rejects -> NO TRADE due to Risk, setup retained, confidence preserved
  // -------------------------------------------------------------------------
  console.log('TEST 5: Candidate exists but Risk rejects (SL out of range) -> NO TRADE due to Risk');
  // Scenario 0 has SL = 2499.27 vs Entry = 2499.87 (slPoints = 6.0), which broker specs (minSlPoints=35) rejects
  const signalRejectedByRisk = await runAIAnalysis(inputWithCandidate);
  assert.strictEqual(signalRejectedByRisk.signal, 'NO TRADE', `TEST 5 Failed: signal should be NO TRADE when Risk rejects, got ${signalRejectedByRisk.signal}`);
  assert.notStrictEqual(signalRejectedByRisk.setup, 'NO TRADE (Waiting for GB-V5 setup)', 'TEST 5 Failed: setup should NOT be fallback waiting string when candidate existed');
  assert.strictEqual(signalRejectedByRisk.setup, algoRes.setup, `TEST 5 Failed: setup should retain candidate setup name, got ${signalRejectedByRisk.setup}`);
  assert.strictEqual(signalRejectedByRisk.confidence, algoRes.confidence, `TEST 5 Failed: confidence should retain candidate confidence, got ${signalRejectedByRisk.confidence}`);
  assert(signalRejectedByRisk.noTradeReason !== undefined && signalRejectedByRisk.noTradeReason.length > 0, 'TEST 5 Failed: noTradeReason must explain Risk rejection');
  assert(signalRejectedByRisk.noTradeReason.includes('Stop Loss') || signalRejectedByRisk.noTradeReason.includes('نقطة'), `TEST 5 Failed: noTradeReason should mention SL reason, got: ${signalRejectedByRisk.noTradeReason}`);
  console.log(`✅ [PASS] TEST 5: Risk rejection properly formatted as NO TRADE with retained setup (${signalRejectedByRisk.setup}), confidence=${signalRejectedByRisk.confidence}%, and risk reason: "${signalRejectedByRisk.noTradeReason}".\n`);

  console.log('========================================================================');
  console.log('🎉 ALL 5 PIPELINE CONTRACT REGRESSION TESTS PASSED (5/5)');
  console.log('========================================================================');
}

runPipelineContractTests().catch((err) => {
  console.error('❌ Pipeline Contract Tests Failed:', err);
  process.exit(1);
});
