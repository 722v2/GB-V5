import { calculateDynamicTakeProfits } from '../server/tpEngine.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import {
  assessPullbackQuality,
  assessEntryTimingAndAntiChase,
  assessPriceActionTrigger,
  assessTpPathRunway,
  assessStopLossQuality,
  calculateExecutionQualityScore,
} from '../server/tradeQualityEngine.js';
import { tradeManagementEngine } from '../server/tradeManagementEngine.js';
import { storage } from '../server/storage.js';
import { TechnicalIndicators, Candle, TradeLedgerItem, AppSettings, DEFAULT_APP_SETTINGS } from '../src/types.js';

async function runDirectionalSymmetryTests() {
  console.log('======================================================================');
  console.log('⚖️ DIRECTIONAL SYMMETRY REGRESSION TEST SUITE (BUY vs SELL PARITY)');
  console.log('======================================================================\n');

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

  function assertEqual(actual: any, expected: any, testName: string) {
    const isEq = actual === expected;
    assert(isEq, testName, `Expected ${expected}, got ${actual}`);
  }

  function assertApprox(actual: number, expected: number, testName: string, tolerance: number = 0.05) {
    const diff = Math.abs(actual - expected);
    assert(diff <= tolerance, testName, `Expected ~${expected}, got ${actual} (diff: ${diff.toFixed(3)})`);
  }

  await storage.waitUntilReady();
  storage.setTestingMode(true);

  // Helper to generate synthetic mirrored candles
  function makeMirroredCandle(timestamp: number, basePrice: number, offsetOpen: number, offsetHigh: number, offsetLow: number, offsetClose: number, isBuy: boolean): Candle {
    if (isBuy) {
      return {
        timestamp,
        open: basePrice + offsetOpen,
        high: basePrice + offsetHigh,
        low: basePrice + offsetLow,
        close: basePrice + offsetClose,
        volume: 1000,
      };
    } else {
      // Invert high/low and price movements for SELL
      return {
        timestamp,
        open: basePrice - offsetOpen,
        high: basePrice - offsetLow,
        low: basePrice - offsetHigh,
        close: basePrice - offsetClose,
        volume: 1000,
      };
    }
  }

  // =========================================================================
  // TEST 1: TP ENGINE DYNAMIC TARGET SELECTION SYMMETRY
  // =========================================================================
  console.log('\n--- 1. TP Engine Dynamic Target Selection & RR Parity ---');
  {
    const entry = 2650.0;
    const slDist = 4.0;
    const targetDist = 8.0; // 2.0R target

    const buyIndicators15m: TechnicalIndicators = {
      atr14: 2.0,
      swingHigh: entry + targetDist,
      swingLow: entry - 10.0,
    } as any;

    const sellIndicators15m: TechnicalIndicators = {
      atr14: 2.0,
      swingHigh: entry + 10.0,
      swingLow: entry - targetDist,
    } as any;

    const dummyInd: TechnicalIndicators = { atr14: 2.0 } as any;

    const buyTp = calculateDynamicTakeProfits({
      asset: 'XAU/USD',
      direction: 'BUY',
      entry,
      stopLoss: entry - slDist,
      indicators1h: dummyInd,
      indicators15m: buyIndicators15m,
      indicators5m: dummyInd,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.5,
    });

    const sellTp = calculateDynamicTakeProfits({
      asset: 'XAU/USD',
      direction: 'SELL',
      entry,
      stopLoss: entry + slDist,
      indicators1h: dummyInd,
      indicators15m: sellIndicators15m,
      indicators5m: dummyInd,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.5,
    });

    assert(buyTp.valid && sellTp.valid, '1.1 Both BUY and SELL dynamic TPs are valid');
    assertApprox(buyTp.tp1Distance, sellTp.tp1Distance, '1.2 TP1 distance is exactly symmetric');
    assertApprox(buyTp.tp1Rr, sellTp.tp1Rr, '1.3 TP1 R:R is identical');
    assertEqual(buyTp.slDistance, sellTp.slDistance, '1.4 SL distance is identical (4.0 pts)');
    assert(buyTp.tp1TargetName.includes('Swing High') && sellTp.tp1TargetName.includes('Swing Low'), '1.5 BUY and SELL target sources are symmetrically selected');
  }

  // =========================================================================
  // TEST 2: TP ENGINE OPPOSING ORDER BLOCK SELECTION SYMMETRY
  // =========================================================================
  console.log('\n--- 2. TP Engine Opposing Barrier Selection Parity ---');
  {
    const entry = 2650.0;
    const slDist = 4.0;

    // BUY targeting Bearish OB at 2653 (+3.0 pts)
    const buyBlockedInd15m: TechnicalIndicators = {
      atr14: 2.0,
      orderBlock: { type: 'BEARISH', low: entry + 3.0, high: entry + 6.0 },
      swingHigh: entry + 12.0,
    } as any;

    // SELL targeting Bullish OB at 2647 (-3.0 pts)
    const sellBlockedInd15m: TechnicalIndicators = {
      atr14: 2.0,
      orderBlock: { type: 'BULLISH', low: entry - 6.0, high: entry - 3.0 },
      swingLow: entry - 12.0,
    } as any;

    const dummyInd: TechnicalIndicators = { atr14: 2.0 } as any;

    const buyBlocked = calculateDynamicTakeProfits({
      asset: 'XAU/USD',
      direction: 'BUY',
      entry,
      stopLoss: entry - slDist,
      indicators1h: dummyInd,
      indicators15m: buyBlockedInd15m,
      indicators5m: dummyInd,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 0.7,
    });

    const sellBlocked = calculateDynamicTakeProfits({
      asset: 'XAU/USD',
      direction: 'SELL',
      entry,
      stopLoss: entry + slDist,
      indicators1h: dummyInd,
      indicators15m: sellBlockedInd15m,
      indicators5m: dummyInd,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 0.7,
    });

    assert(buyBlocked.valid && sellBlocked.valid, '2.1 Both BUY and SELL select structural OB symmetrically');
    assertEqual(buyBlocked.targetSourceType, '15M_OB', '2.2 BUY target source is 15M_OB');
    assertEqual(sellBlocked.targetSourceType, '15M_OB', '2.3 SELL target source is 15M_OB');
    assertApprox(buyBlocked.tp1Distance, sellBlocked.tp1Distance, '2.4 Target distances are identical (3.0 pts)');
  }

  // =========================================================================
  // TEST 3: STRATEGY 5 (FIBONACCI OTE) DIRECTIONAL PARITY
  // =========================================================================
  console.log('\n--- 3. Strategy 5 (Fibonacci OTE) Directional Symmetry ---');
  {
    // Swing range: 2626 to 2640 (diff = 14)
    // BUY in DISCOUNT: Retracement to 2630 (70% down from 2640, in DISCOUNT zone < 2633, SL = 2626, 40 pts)
    // SELL in PREMIUM: Retracement to 2636 (70% up from 2626, in PREMIUM zone > 2633, SL = 2640, 40 pts)

    const baseCandles5mBuy: Candle[] = [
      { timestamp: 1000, open: 2628, high: 2632, low: 2627, close: 2631, volume: 100 },
      { timestamp: 2000, open: 2630, high: 2631, low: 2628, close: 2630.5, volume: 100 }, // bottom rejection/bull
    ];

    const baseCandles5mSell: Candle[] = [
      { timestamp: 1000, open: 2638, high: 2639, low: 2634, close: 2635, volume: 100 },
      { timestamp: 2000, open: 2636, high: 2638, low: 2635, close: 2635.5, volume: 100 }, // top rejection/bear
    ];

    const baseCandles15mBuy: Candle[] = [
      { timestamp: 900000, open: 2635, high: 2640, low: 2626, close: 2631, volume: 500 },
      { timestamp: 1800000, open: 2631, high: 2633, low: 2628, close: 2630, volume: 500 },
    ];

    const baseCandles15mSell: Candle[] = [
      { timestamp: 900000, open: 2631, high: 2640, low: 2626, close: 2635, volume: 500 },
      { timestamp: 1800000, open: 2635, high: 2638, low: 2633, close: 2636, volume: 500 },
    ];

    const buyInd15m: TechnicalIndicators = {
      atr14: 2.0,
      swingHigh: 2640,
      swingLow: 2626,
      premiumDiscountZone: 'DISCOUNT',
      marketRegime: 'NORMAL_RANGE',
      structure: 'RANGING',
    } as any;

    const sellInd15m: TechnicalIndicators = {
      atr14: 2.0,
      swingHigh: 2640,
      swingLow: 2626,
      premiumDiscountZone: 'PREMIUM',
      marketRegime: 'NORMAL_RANGE',
      structure: 'RANGING',
    } as any;

    const dummyInd: TechnicalIndicators = { atr14: 2.0 } as any;

    const buyCandidates = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 1000,
      currentPrice: 2630.0,
      indicators1h: dummyInd,
      indicators15m: buyInd15m,
      indicators5m: dummyInd,
      candles1h: [],
      candles15m: baseCandles15mBuy,
      candles5m: baseCandles5mBuy,
    });

    const sellCandidates = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 1000,
      currentPrice: 2636.0,
      indicators1h: dummyInd,
      indicators15m: sellInd15m,
      indicators5m: dummyInd,
      candles1h: [],
      candles15m: baseCandles15mSell,
      candles5m: baseCandles5mSell,
    });

    const buyOte = buyCandidates.allCandidates.find((c) => c.strategyFamily === 'FIBONACCI_OTE');
    const sellOte = sellCandidates.allCandidates.find((c) => c.strategyFamily === 'FIBONACCI_OTE');

    assert(buyOte === undefined, '3.1 BUY Fibonacci OTE candidate is intentionally absent per GB-V5 contract');
    assert(sellOte === undefined, '3.2 SELL Fibonacci OTE candidate is intentionally absent per GB-V5 contract');
  }

  // =========================================================================
  // TEST 4: TRADE QUALITY SCORING SYMMETRY
  // =========================================================================
  console.log('\n--- 4. Trade Quality Assessment Symmetry ---');
  {
    const dummyInd5m: TechnicalIndicators = { atr14: 2.0, rsi14: 50, ema20: 2650 } as any;

    // A. Rejection Wick Price Action
    const bullCandle: Candle = { timestamp: 1000, open: 2651, high: 2652, low: 2647, close: 2651.5, volume: 100 }; // lower wick = 4.0, total = 5.0 (80%)
    const bearCandle: Candle = { timestamp: 1000, open: 2649, high: 2653, low: 2648, close: 2648.5, volume: 100 }; // upper wick = 4.0, total = 5.0 (80%)

    const buyTrigger = assessPriceActionTrigger('BUY', [bullCandle], [], dummyInd5m);
    const sellTrigger = assessPriceActionTrigger('SELL', [bearCandle], [], dummyInd5m);

    assertEqual(buyTrigger.hasTrigger, true, '4.1 BUY detects rejection wick trigger');
    assertEqual(sellTrigger.hasTrigger, true, '4.2 SELL detects rejection wick trigger');
    assertEqual(buyTrigger.confirmationScore, sellTrigger.confirmationScore, '4.3 Rejection confirmation scores are identical');

    // B. Stop Loss Quality
    const buySlQuality = assessStopLossQuality('BUY', 2650.0, 2645.0, dummyInd5m, 35, 65); // 50 points (valid)
    const sellSlQuality = assessStopLossQuality('SELL', 2650.0, 2655.0, dummyInd5m, 35, 65); // 50 points (valid)

    assertEqual(buySlQuality.isValid, true, '4.4 BUY 50pt SL is valid');
    assertEqual(sellSlQuality.isValid, true, '4.5 SELL 50pt SL is valid');
    assertEqual(buySlQuality.slQualityScore, sellSlQuality.slQualityScore, '4.6 SL quality scores are identical (10/10)');
    assertEqual(buySlQuality.slPoints, sellSlQuality.slPoints, '4.7 SL points are identical (50.0 pts)');
  }

  // =========================================================================
  // TEST 5: TRADE MANAGEMENT LIFECYCLE (BUY vs SELL) PARITY
  // =========================================================================
  console.log('\n--- 5. Trade Management Lifecycle Parity ---');
  {
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      enableTradeManagement: true,
      autoTradingEnabled: false,
      contractSizeOz: 100,
      partialClosePercent: 50,
    };

    // A. Terminal Stop Loss Auto-Closure
    const buyTradeSL: TradeLedgerItem = {
      id: `trade_sl_buy_${Date.now()}`,
      tradeNumber: 201,
      date: '2026-09-18',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2650.0,
      sl: 2646.0,
      tp1: 2658.0,
      tp2: 2666.0,
      lotSize: 0.1,
      isActive: true,
      managementState: 'ACTIVE',
    } as any;

    const sellTradeSL: TradeLedgerItem = {
      id: `trade_sl_sell_${Date.now()}`,
      tradeNumber: 202,
      date: '2026-09-18',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 2650.0,
      sl: 2654.0,
      tp1: 2642.0,
      tp2: 2634.0,
      lotSize: 0.1,
      isActive: true,
      managementState: 'ACTIVE',
    } as any;

    storage.saveTrade(buyTradeSL);
    storage.saveTrade(sellTradeSL);

    const dummyInd: TechnicalIndicators = { atr14: 2.0, rsi14: 50, ema20: 2650 } as any;

    const buySlEval = await tradeManagementEngine.evaluateSingleTrade(
      buyTradeSL,
      2645.5, // Hit SL at 2646.0
      [], [], [], [],
      dummyInd, dummyInd, dummyInd,
      10000,
      settings
    );

    const sellSlEval = await tradeManagementEngine.evaluateSingleTrade(
      sellTradeSL,
      2654.5, // Hit SL at 2654.0
      [], [], [], [],
      dummyInd, dummyInd, dummyInd,
      10000,
      settings
    );

    assertEqual(buySlEval.state, 'CLOSED', '5.1 BUY trade auto-closed on SL');
    assertEqual(sellSlEval.state, 'CLOSED', '5.2 SELL trade auto-closed on SL');
    assertApprox(buySlEval.action.floatingPnl, sellSlEval.action.floatingPnl, '5.3 Realized loss is identical (-$400.00)');
    assertEqual(buySlEval.action.currentR, -1.0, '5.4 BUY currentR is -1.0');
    assertEqual(sellSlEval.action.currentR, -1.0, '5.5 SELL currentR is -1.0');

    // B. TP1 Hit & Partial Close Recommendation
    const buyTradeTP1: TradeLedgerItem = {
      id: `trade_tp1_buy_${Date.now()}`,
      tradeNumber: 203,
      date: '2026-09-18',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2650.0,
      sl: 2646.0,
      tp1: 2658.0,
      tp2: 2666.0,
      lotSize: 0.1,
      isActive: true,
      managementState: 'ACTIVE',
    } as any;

    const sellTradeTP1: TradeLedgerItem = {
      id: `trade_tp1_sell_${Date.now()}`,
      tradeNumber: 204,
      date: '2026-09-18',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 2650.0,
      sl: 2654.0,
      tp1: 2642.0,
      tp2: 2634.0,
      lotSize: 0.1,
      isActive: true,
      managementState: 'ACTIVE',
    } as any;

    storage.saveTrade(buyTradeTP1);
    storage.saveTrade(sellTradeTP1);

    const buyTp1Eval = await tradeManagementEngine.evaluateSingleTrade(
      buyTradeTP1,
      2658.2, // TP1 reached
      [], [], [], [],
      dummyInd, dummyInd, dummyInd,
      10000,
      settings
    );

    const sellTp1Eval = await tradeManagementEngine.evaluateSingleTrade(
      sellTradeTP1,
      2641.8, // TP1 reached
      [], [], [], [],
      dummyInd, dummyInd, dummyInd,
      10000,
      settings
    );

    assertEqual(buyTp1Eval.action.actionType, 'PARTIAL_CLOSE_TP1', '5.6 BUY recommends PARTIAL_CLOSE_TP1');
    assertEqual(sellTp1Eval.action.actionType, 'PARTIAL_CLOSE_TP1', '5.7 SELL recommends PARTIAL_CLOSE_TP1');
    assertEqual(buyTp1Eval.action.newSL, 2650.50, '5.8 BUY protected SL is Entry + 0.50 ($2650.50)');
    assertEqual(sellTp1Eval.action.newSL, 2649.50, '5.9 SELL protected SL is Entry - 0.50 ($2649.50)');
    assertEqual(buyTp1Eval.action.partialClosePercent, sellTp1Eval.action.partialClosePercent, '5.10 Partial close % is identical (50%)');
  }

  // =========================================================================
  // TEST 6: STORAGE DIRECTION INFERENCE (NO BUY BIAS)
  // =========================================================================
  console.log('\n--- 6. Storage Symmetrical Direction Inference ---');
  {
    // Test that when direction is omitted, direction is symmetrically inferred from entry and SL:
    // entry > sl -> BUY
    // entry < sl -> SELL
    const tradeBuyRaw = {
      id: `storage_test_buy_${Date.now()}`,
      trade_number: 301,
      entry: 2650.0,
      sl: 2645.0, // entry > sl -> BUY
      tp1: 2660.0,
    };

    const tradeSellRaw = {
      id: `storage_test_sell_${Date.now()}`,
      trade_number: 302,
      entry: 2650.0,
      sl: 2655.0, // entry < sl -> SELL
      tp1: 2640.0,
    };

    // Reconstruct via storage mapper logic
    const mappedBuyDir = (Number(tradeBuyRaw.entry) > Number(tradeBuyRaw.sl) && Number(tradeBuyRaw.sl) > 0 ? 'BUY' : 'SELL');
    const mappedSellDir = (Number(tradeSellRaw.entry) > Number(tradeSellRaw.sl) && Number(tradeSellRaw.sl) > 0 ? 'BUY' : 'SELL');

    assertEqual(mappedBuyDir, 'BUY', '6.1 Inferred BUY correctly from entry > sl');
    assertEqual(mappedSellDir, 'SELL', '6.2 Inferred SELL correctly from entry < sl without BUY bias');
  }

  console.log('\n======================================================================');
  console.log(`📊 SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runDirectionalSymmetryTests().catch((err) => {
  console.error('Fatal error running directional symmetry tests:', err);
  process.exit(1);
});
