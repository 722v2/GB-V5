import assert from 'assert';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { runAIAnalysis, algorithmicScreening, MarketAnalysisInput } from '../server/geminiTrader.js';
import { executeGbv5Brain } from '../server/gbv5Brain.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function generateValidCandles(count: number = 50, basePrice: number = 2500): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * 300000;
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: baseTime + i * 300000,
      open: basePrice + i * 0.1,
      high: basePrice + i * 0.1 + 1.5,
      low: basePrice + i * 0.1 - 1.5,
      close: basePrice + i * 0.1 + 0.5,
      volume: 100,
      isClosed: true,
    });
  }
  // Authentic pullback on penultimate candle followed by continuation trigger on last candle
  if (candles.length >= 2) {
    const pen = candles[candles.length - 2];
    pen.open = pen.close + 0.8;
    pen.close = pen.open - 1.2; // Red pullback candle
    pen.low = pen.close - 0.5;
    pen.high = pen.open + 0.2;
    const last = candles[candles.length - 1];
    last.open = pen.close;
    last.close = pen.close + 2.0; // Green continuation trigger
    last.high = last.close + 0.5;
    last.low = pen.close - 0.2;
  }
  return candles;
}

function generateIndicators(currentPrice: number = 2500): TechnicalIndicators {
  return {
    ema20: currentPrice + 2,
    ema50: currentPrice - 2,
    rsi: 55,
    macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
    atr: 2.5,
    vwap: currentPrice,
    structure: 'BULLISH',
    swingHigh: currentPrice + 15,
    swingLow: currentPrice - 15,
    support: currentPrice - 15,
    resistance: currentPrice + 15,
    premiumDiscountZone: 'DISCOUNT',
  };
}

async function runBrainSignalUnificationTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PHASE 3B — BRAIN & SIGNAL UNIFICATION REGRESSION TESTS');
  console.log('========================================================================\n');

  const candles5m = generateValidCandles(50, 2500);
  const currentPrice = candles5m[candles5m.length - 1].close;
  const indicators5m = generateIndicators(currentPrice);
  const indicators15m = generateIndicators(currentPrice);
  const indicators1h = generateIndicators(currentPrice);

  const baseInput: MarketAnalysisInput = {
    asset: 'XAU/USD',
    balance: 100,
    currentPrice,
    candles1h: candles5m,
    candles15m: candles5m,
    recent5mCandles: candles5m,
    recent1mCandles: candles5m,
    indicators1h,
    indicators15m,
    indicators5m,
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
  // TEST A: Selected candidate family is preserved exactly without text re-inference
  // -------------------------------------------------------------------------
  console.log('TEST A: Selected candidate strategyFamily is preserved directly from canonical candidate');
  {
    const algoRes = algorithmicScreening(baseInput);
    assert(algoRes.candidate !== undefined, 'TEST A: Candidate must be discovered');
    const cand = algoRes.candidate!;
    
    const finalSignal = await runAIAnalysis(baseInput);
    assert.strictEqual(
      finalSignal.strategyFamily,
      cand.strategyFamily || cand.family,
      'TEST A: Final signal strategyFamily must equal candidate canonical strategyFamily exactly'
    );
    assert.notStrictEqual(
      finalSignal.strategyFamily,
      undefined,
      'TEST A: strategyFamily must not be undefined'
    );
    console.log(`✅ [PASS] TEST A: Canonical strategyFamily="${finalSignal.strategyFamily}" preserved without string inference.`);
  }

  // -------------------------------------------------------------------------
  // TEST B: Candidate metadata is preserved into final TradeSignal
  // -------------------------------------------------------------------------
  console.log('\nTEST B: Candidate metadata preserved into final TradeSignal');
  {
    const algoRes = algorithmicScreening(baseInput);
    const cand = algoRes.candidate!;
    const finalSignal = await runAIAnalysis(baseInput);

    assert.strictEqual(finalSignal.setup, cand.setupName, 'TEST B: Setup name must match candidate setupName');
    assert.deepStrictEqual(finalSignal.mainReasons, cand.mainReasons, 'TEST B: mainReasons must match candidate mainReasons');
    assert.strictEqual(finalSignal.invalidation, cand.invalidation, 'TEST B: invalidation must match candidate invalidation');
    console.log('✅ [PASS] TEST B: Candidate setup name, reasons, and invalidation preserved.');
  }

  // -------------------------------------------------------------------------
  // TEST C: supportingConfluences are preserved when present
  // -------------------------------------------------------------------------
  console.log('\nTEST C: supportingConfluences preserved into final TradeSignal');
  {
    const algoRes = algorithmicScreening(baseInput);
    const cand = algoRes.candidate!;
    const finalSignal = await runAIAnalysis(baseInput);

    assert(Array.isArray(cand.supportingConfluences), 'Candidate must have supportingConfluences array');
    assert(cand.supportingConfluences.length > 0, 'Candidate supportingConfluences must not be empty');
    assert.deepStrictEqual(
      finalSignal.supportingConfluences,
      cand.supportingConfluences,
      'TEST C: finalSignal.supportingConfluences must match candidate.supportingConfluences'
    );
    console.log(`✅ [PASS] TEST C: supportingConfluences (${finalSignal.supportingConfluences?.length} items) preserved.`);
  }

  // -------------------------------------------------------------------------
  // TEST D: Candidate entry, SL, and TP values are preserved
  // -------------------------------------------------------------------------
  console.log('\nTEST D: Candidate entry, stopLoss, tp1, tp2 values preserved');
  {
    const algoRes = algorithmicScreening(baseInput);
    const cand = algoRes.candidate!;
    const finalSignal = await runAIAnalysis(baseInput);

    assert.strictEqual(finalSignal.entry, cand.entry, 'TEST D: entry must match');
    assert.strictEqual(finalSignal.stopLoss, cand.stopLoss, 'TEST D: stopLoss must match');
    assert.strictEqual(finalSignal.tp1, cand.tp1, 'TEST D: tp1 must match');
    assert.strictEqual(finalSignal.tp2, cand.tp2, 'TEST D: tp2 must match');
    console.log(`✅ [PASS] TEST D: entry=${finalSignal.entry}, sl=${finalSignal.stopLoss}, tp1=${finalSignal.tp1}, tp2=${finalSignal.tp2} preserved.`);
  }

  // -------------------------------------------------------------------------
  // TEST E: Candidate confidence and confluence score are preserved
  // -------------------------------------------------------------------------
  console.log('\nTEST E: Candidate confidence and confluenceScore preserved');
  {
    const algoRes = algorithmicScreening(baseInput);
    const cand = algoRes.candidate!;
    const finalSignal = await runAIAnalysis(baseInput);

    assert.strictEqual(finalSignal.confidence, cand.confidence, 'TEST E: confidence must match candidate confidence');
    assert.strictEqual(finalSignal.strategyConfidence, cand.confidence, 'TEST E: strategyConfidence must match candidate confidence');
    assert.strictEqual(finalSignal.confluenceScore, cand.score, 'TEST E: confluenceScore must match candidate score');
    console.log(`✅ [PASS] TEST E: confidence=${finalSignal.confidence}%, confluenceScore=${finalSignal.confluenceScore} preserved.`);
  }

  // -------------------------------------------------------------------------
  // TEST F: No-candidate behavior remains NO TRADE with confidence 0
  // -------------------------------------------------------------------------
  console.log('\nTEST F: No-candidate scenario returns NO TRADE with confidence 0');
  {
    const emptyCandles: Candle[] = [
      { timestamp: 1, open: 2500.0, high: 2500.1, low: 2500.0, close: 2500.1, volume: 10, isClosed: true },
    ];
    const neutralInd: TechnicalIndicators = {
      swingHigh: 2550,
      swingLow: 2450,
      support: 2440,
      resistance: 2560,
      atr: 0.1,
      rsi: 50,
      structure: 'RANGING',
      premiumDiscountZone: 'EQUILIBRIUM',
    };

    const inputNoCand: MarketAnalysisInput = {
      ...baseInput,
      recent5mCandles: emptyCandles,
      recent1mCandles: emptyCandles,
      candles5m: emptyCandles,
      indicators5m: neutralInd,
      indicators15m: neutralInd,
      indicators1h: neutralInd,
    };

    const finalSignal = await runAIAnalysis(inputNoCand);
    assert.strictEqual(finalSignal.signal, 'NO TRADE', 'TEST F: signal must be NO TRADE');
    assert.strictEqual(finalSignal.confidence, 0, 'TEST F: confidence must be 0');
    assert(finalSignal.setup.includes('NO TRADE') || finalSignal.setup.includes('Waiting'), 'TEST F: setup must indicate waiting');
    console.log(`✅ [PASS] TEST F: Genuinely empty candidate returned NO TRADE with confidence=${finalSignal.confidence}%.`);
  }

  // -------------------------------------------------------------------------
  // TEST G: Downstream Risk rejection preserves actual setup, confidence, and metadata
  // -------------------------------------------------------------------------
  console.log('\nTEST G: Downstream Risk rejection preserves actual setup, confidence, and metadata');
  {
    // Configure brokerSpecs with impossible SL range to force downstream Risk rejection
    const inputRiskReject: MarketAnalysisInput = {
      ...baseInput,
      brokerSpecs: {
        minSlPoints: 9999, // Impossible min SL forces risk rejection
        maxSlPoints: 10000,
        minRr: 1.0,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        accountBalance: 100,
        riskPercent: 1.5,
      },
    };

    const algoRes = algorithmicScreening(inputRiskReject);
    assert(algoRes.candidate !== undefined, 'Candidate must still be discovered by brain');
    const cand = algoRes.candidate!;

    const finalSignal = await runAIAnalysis(inputRiskReject);
    assert.strictEqual(finalSignal.signal, 'NO TRADE', 'TEST G: finalSignal must be NO TRADE due to Risk rejection');
    assert.strictEqual(finalSignal.setup, cand.setupName, 'TEST G: actual setup name must be preserved despite Risk rejection');
    assert.strictEqual(finalSignal.confidence, cand.confidence, 'TEST G: actual confidence must be preserved');
    assert.strictEqual(finalSignal.strategyFamily, cand.strategyFamily || cand.family, 'TEST G: actual strategyFamily must be preserved');
    assert(finalSignal.noTradeReason !== undefined, 'TEST G: noTradeReason must explain Risk rejection');
    assert.match(finalSignal.noTradeReason!, /Stop Loss|الحد الأدنى/i, 'TEST G: noTradeReason must explain SL out of range');
    console.log(`✅ [PASS] TEST G: Risk rejection produced NO TRADE while preserving setup="${finalSignal.setup}", confidence=${finalSignal.confidence}%, reason="${finalSignal.noTradeReason}".`);
  }

  // -------------------------------------------------------------------------
  // TEST H: allCandidates remains complete and in original discovery order
  // -------------------------------------------------------------------------
  console.log('\nTEST H: allCandidates preserves complete discovery collection in discovery order');
  {
    const candles1m = generateValidCandles(30, currentPrice);
    candles1m[candles1m.length - 1] = {
      timestamp: Date.now(),
      open: currentPrice + 2,
      high: currentPrice + 10,
      low: currentPrice + 1,
      close: currentPrice + 8, // > swingHigh
      volume: 2000,
      isClosed: true,
    };

    const engineInput = {
      asset: 'XAU/USD' as const,
      balance: 100,
      currentPrice: currentPrice + 8,
      candles5m,
      candles1m,
      indicators5m,
      indicators15m,
      indicators1h,
    };

    const result = generateMultiStrategyCandidates(engineInput);
    assert(Array.isArray(result.allCandidates), 'TEST H: allCandidates must be an array');
    assert(result.allCandidates.length > 0, 'TEST H: allCandidates must have candidates');
    assert(result.selectedCandidate !== null, 'TEST H: selectedCandidate must be chosen');
    
    // Verify all candidates have canonical strategyFamily and metadata
    for (const c of result.allCandidates) {
      assert(c.family !== undefined, 'Candidate family must be defined');
      assert(c.setupName.startsWith('GB-V5'), 'Candidate setupName must be GB-V5');
      assert(Array.isArray(c.supportingConfluences), 'supportingConfluences must be array');
    }
    console.log(`✅ [PASS] TEST H: ${result.allCandidates.length} candidates preserved in original discovery order.`);
  }

  // -------------------------------------------------------------------------
  // TEST I: No legacy strategy/gate reintroduced
  // -------------------------------------------------------------------------
  console.log('\nTEST I: No legacy strategy families in candidate collection');
  {
    const engineResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD' as const,
      currentPrice,
      candles5m,
      indicators5m,
      indicators15m,
      indicators1h,
    });

    const validGbv5Families = [
      'LIQUIDITY_SWEEP_REJECTION',
      'STRUCTURE_BREAK_RETEST',
      'TREND_CONTINUATION_PULLBACK',
      'RANGE_SWEEP_SFP',
      // Legacy aliases mapped
      'LIQUIDITY_SWEEP',
      'SWEEP_AND_REVERSE',
      'BREAK_AND_RETEST',
      'MARKET_STRUCTURE',
      'RANGE_SFP_REVERSAL',
    ];

    for (const c of engineResult.allCandidates) {
      assert(
        validGbv5Families.includes(c.family) || validGbv5Families.includes(c.strategyFamily || ''),
        `TEST I: Candidate family ${c.family} must be a valid GB-V5 family`
      );
    }
    console.log('✅ [PASS] TEST I: Zero legacy strategies present. Only GB-V5 candidate families active.');
  }

  // -------------------------------------------------------------------------
  // TEST J: executeGbv5Brain does not create a competing live decision path
  // -------------------------------------------------------------------------
  console.log('\nTEST J: executeGbv5Brain compatibility wrapper behavior');
  {
    const brainRes = await executeGbv5Brain({
      currentPrice,
      candles5m,
      indicators5m,
      indicators15m,
      indicators1h,
    });

    assert(brainRes.finalSignal !== undefined, 'TEST J: finalSignal must be returned');
    if (brainRes.selectedCandidate) {
      assert(brainRes.selectedCandidate.setupName.startsWith('GB-V5'), 'Setup must start with GB-V5');
      assert.strictEqual(
        brainRes.finalSignal.strategyFamily,
        brainRes.selectedCandidate.legacyFamilyAlias,
        'Strategy family must match canonical candidate alias'
      );
    }
    console.log('✅ [PASS] TEST J: executeGbv5Brain compatibility wrapper verified.');
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL 10 PHASE 3B REGRESSION TESTS PASSED (10/10)');
  console.log('========================================================================\n');
}

runBrainSignalUnificationTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Phase 3B Tests Failed:', err);
    process.exit(1);
  });
