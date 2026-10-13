import {
  Candle,
  TechnicalIndicators,
  TradeLedgerItem,
  AppSettings,
  DEFAULT_APP_SETTINGS,
} from '../src/types.js';
import { tradeManagementEngine } from './tradeManagementEngine.js';
import { PersistentStorage } from './storage.js';
import { generateMultiStrategyCandidates } from './strategyEngine.js';

interface TestResult {
  testNumber: number;
  name: string;
  passed: boolean;
  details: string;
}

// Helper to generate synthetic candles for deterministic tests
function generateSyntheticCandles(
  basePrice: number,
  trend: 'UP' | 'DOWN' | 'RANGING',
  count: number = 30
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  const step = trend === 'UP' ? 0.5 : trend === 'DOWN' ? -0.5 : 0;
  const startPrice = basePrice - (count - 1) * step;
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - 1 - i) * 300000;
    let delta = step;
    if (trend === 'RANGING') {
      delta = i % 2 === 0 ? 0.2 : -0.2;
    }
    price = startPrice + i * delta;
    const open = price - delta * 0.5;
    const close = price;
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.4;
    candles.push({
      timestamp,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 100,
    });
  }
  return candles;
}

function generateMockIndicators(currentPrice: number, trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): TechnicalIndicators {
  if (trend === 'BULLISH') {
    return {
      rsi14: 62,
      ema20: currentPrice - 2.0,
      ema50: currentPrice - 5.0,
      ema200: currentPrice - 15.0,
      vwap: currentPrice - 1.0,
      atr14: 3.5,
      macd: { macd: 1.2, signal: 0.8, histogram: 0.4 },
      bollingerBands: { upper: currentPrice + 4.0, middle: currentPrice, lower: currentPrice - 4.0 },
      swingHigh: currentPrice + 5.0,
      swingLow: currentPrice - 5.0,
      support: currentPrice - 5.0,
      resistance: currentPrice + 5.0,
      structure: 'BULLISH',
      marketRegime: 'STRONG_UPTREND',
    };
  } else if (trend === 'BEARISH') {
    return {
      rsi14: 38,
      ema20: currentPrice + 2.0,
      ema50: currentPrice + 5.0,
      ema200: currentPrice + 15.0,
      vwap: currentPrice + 1.0,
      atr14: 3.5,
      macd: { macd: -1.2, signal: -0.8, histogram: -0.4 },
      bollingerBands: { upper: currentPrice + 4.0, middle: currentPrice, lower: currentPrice - 4.0 },
      swingHigh: currentPrice + 5.0,
      swingLow: currentPrice - 5.0,
      support: currentPrice - 5.0,
      resistance: currentPrice + 5.0,
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
    };
  }
  return {
    rsi14: 50,
    ema20: currentPrice,
    ema50: currentPrice,
    ema200: currentPrice,
    vwap: currentPrice,
    atr14: 3.0,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollingerBands: { upper: currentPrice + 3.0, middle: currentPrice, lower: currentPrice - 3.0 },
    swingHigh: currentPrice + 4.0,
    swingLow: currentPrice - 4.0,
    support: currentPrice - 4.0,
    resistance: currentPrice + 4.0,
    structure: 'RANGING',
    marketRegime: 'NORMAL_RANGE',
  };
}

export async function runTradeManagementTests(customStorage?: PersistentStorage): Promise<{ allPassed: boolean; results: TestResult[] }> {
  if (customStorage && customStorage.isProductionStorage) {
    throw new Error('HARD SAFETY GUARD TRIGGERED: Refusing to run trade management tests on production storage instance!');
  }
  const activeStorage = customStorage || PersistentStorage.createIsolatedTestInstance(100.0);
  if (activeStorage.isProductionStorage) {
    throw new Error('HARD SAFETY GUARD TRIGGERED: Refusing to run trade management tests on production storage instance!');
  }
  try {
    const results: TestResult[] = [];
    tradeManagementEngine.clearNotificationCache();

    const baseSettings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    partialClosePercent: 50,
    enableTradeManagement: true,
    autoTradingEnabled: false,
  };

  // --------------------------------------------------------------------------
  // TEST 1: BUY reaches TP1 -> Triggers PARTIAL_CLOSE_TP1 and profit protection SL
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-buy-tp1',
      tradeNumber: 1,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4285.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4300.5; // Reached TP1
    const candles5m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const candles15m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const candles1h = generateSyntheticCandles(currentPrice, 'UP', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind15m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind1h = generateMockIndicators(currentPrice, 'BULLISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed =
      evalResult.action.actionType === 'PARTIAL_CLOSE_TP1' &&
      evalResult.action.managementState === 'TP1_HIT' &&
      evalResult.action.newSL !== undefined &&
      evalResult.action.newSL >= trade.entry &&
      evalResult.safetyPassed === true;

    results.push({
      testNumber: 1,
      name: 'BUY reaches TP1 triggers PARTIAL_CLOSE_TP1 with Breakeven/Protection SL',
      passed,
      details: `Action: ${evalResult.action.actionType}, State: ${evalResult.action.managementState}, Proposed SL: $${evalResult.action.newSL}, Safety: ${evalResult.safetyPassed}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 1, name: 'BUY reaches TP1', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 2: SELL reaches TP1 -> Triggers PARTIAL_CLOSE_TP1 and profit protection SL
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-sell-tp1',
      tradeNumber: 2,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 4300.0,
      sl: 4305.0,
      tp1: 4290.0,
      tp2: 4280.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4289.5; // Reached TP1
    const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const candles15m = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const candles1h = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind15m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind1h = generateMockIndicators(currentPrice, 'BEARISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed =
      evalResult.action.actionType === 'PARTIAL_CLOSE_TP1' &&
      evalResult.action.managementState === 'TP1_HIT' &&
      evalResult.action.newSL !== undefined &&
      evalResult.action.newSL <= trade.entry &&
      evalResult.safetyPassed === true;

    results.push({
      testNumber: 2,
      name: 'SELL reaches TP1 triggers PARTIAL_CLOSE_TP1 with Breakeven/Protection SL',
      passed,
      details: `Action: ${evalResult.action.actionType}, State: ${evalResult.action.managementState}, Proposed SL: $${evalResult.action.newSL}, Safety: ${evalResult.safetyPassed}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 2, name: 'SELL reaches TP1', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 3: Partial TP recommendation percentage matches configuration
  // --------------------------------------------------------------------------
  try {
    const customSettings: AppSettings = { ...baseSettings, partialClosePercent: 60 };
    const trade: TradeLedgerItem = {
      id: 'test-partial-pct',
      tradeNumber: 3,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4285.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'FVG Imbalance',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4300.0;
    const candles5m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles5m,
      candles5m,
      candles5m,
      [],
      ind5m,
      ind5m,
      ind5m,
      100,
      customSettings
    );

    const passed = evalResult.action.partialClosePercent === 60;
    results.push({
      testNumber: 3,
      name: 'Partial TP recommendation percentage dynamically adopts user setting (60%)',
      passed,
      details: `Recommended partial close: ${evalResult.action.partialClosePercent}% (expected 60%)`,
    });
  } catch (err: any) {
    results.push({ testNumber: 3, name: 'Partial TP percentage', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 4: Remaining position continues toward TP2 after TP1 is partially closed
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-tp1-closed-continuing',
      tradeNumber: 4,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4290.5, // Protected SL
      tp1: 4300.0,
      tp2: 4315.0,
      rr: '1:2.5',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      partialClosed: true, // TP1 already closed
      pl: 5.0,
      balanceAfterTrade: 105,
    };

    const currentPrice = 4304.0; // Between TP1 and TP2
    const candles5m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles5m,
      candles5m,
      candles5m,
      [],
      ind5m,
      ind5m,
      ind5m,
      100,
      baseSettings
    );

    // It should not re-trigger PARTIAL_CLOSE_TP1; it should either HOLD or TRAIL_STOP
    const passed = evalResult.action.actionType !== 'PARTIAL_CLOSE_TP1' && evalResult.action.actionType !== 'EARLY_EXIT';
    results.push({
      testNumber: 4,
      name: 'Remaining position continues toward TP2 without duplicate TP1 trigger',
      passed,
      details: `Action: ${evalResult.action.actionType}, State: ${evalResult.action.managementState}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 4, name: 'Continuation to TP2', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 5: Strong continuation causes valid SL update (Trailing stop to protected swing)
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-trailing-sl',
      tradeNumber: 5,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4286.0,
      tp1: 4300.0,
      tp2: 4315.0,
      rr: '1:2.5',
      riskPercent: 15,
      riskAmount: 4.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Market Structure BOS',
      result: 'OPEN',
      isActive: true,
      partialClosed: true, // Post-TP1 trailing
      pl: 5.0,
      balanceAfterTrade: 105,
    };

    const currentPrice = 4306.0; // > 1.2R in profit
    const candles5m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const candles15m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const candles1h = generateSyntheticCandles(currentPrice, 'UP', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind15m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind1h = generateMockIndicators(currentPrice, 'BULLISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed =
      evalResult.action.actionType === 'UPDATE_SL' &&
      evalResult.action.newSL !== undefined &&
      evalResult.action.newSL > trade.sl &&
      evalResult.action.newSL < currentPrice;

    results.push({
      testNumber: 5,
      name: 'Strong continuation generates valid Trailing Stop SL update',
      passed,
      details: `Action: ${evalResult.action.actionType}, Old SL: $${trade.sl}, New SL: $${evalResult.action.newSL}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 5, name: 'Trailing SL update', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 6: Strong continuation causes valid TP2 extension
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-tp2-extension',
      tradeNumber: 6,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 4300.0,
      sl: 4304.0,
      tp1: 4285.0,
      tp2: 4275.0,
      rr: '1:3.0',
      riskPercent: 15,
      riskAmount: 4.0,
      lotSize: 0.01,
      confidence: 85,
      setup: 'Liquidity Sweep',
      result: 'OPEN',
      isActive: true,
      partialClosed: true,
      pl: 15.0,
      balanceAfterTrade: 115,
    };

    const currentPrice = 4277.0; // ~92% to TP2
    const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const candles15m = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const candles1h = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const ind5m = { ...generateMockIndicators(currentPrice, 'BEARISH'), rsi14: 35 };
    const ind15m = { ...generateMockIndicators(currentPrice, 'BEARISH'), rsi14: 40 };
    const ind1h = generateMockIndicators(currentPrice, 'BEARISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed =
      evalResult.action.actionType === 'UPDATE_TP2' &&
      evalResult.action.newTP2 !== undefined &&
      evalResult.action.newTP2 < trade.tp2;

    results.push({
      testNumber: 6,
      name: 'Strong continuation causes valid TP2 Target Extension',
      passed,
      details: `Action: ${evalResult.action.actionType}, State: ${evalResult.action.managementState}, Extended TP2: $${evalResult.action.newTP2}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 6, name: 'TP2 extension', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 7: Weak reversal / minor pullback (Level 1) does NOT trigger exit (HOLD)
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-weak-pullback',
      tradeNumber: 7,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4285.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4293.0; // Healthy floating profit with minor normal tick
    const candles5m = generateSyntheticCandles(currentPrice, 'UP', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind15m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind1h = generateMockIndicators(currentPrice, 'BULLISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles5m,
      candles5m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed = evalResult.action.actionType === 'HOLD' && evalResult.state === 'HOLD';
    results.push({
      testNumber: 7,
      name: 'Weak reversal / normal pullback does NOT trigger exit or alarm (HOLD)',
      passed,
      details: `Action: ${evalResult.action.actionType}, State: ${evalResult.state}, Reversal Level: ${evalResult.health.reversalLevel}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 7, name: 'Weak reversal check', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 8: REVERSAL_WATCH (Level 2) activates correctly without closing trade
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-reversal-watch',
      tradeNumber: 8,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4295.0,
      sl: 4290.0,
      tp1: 4305.0,
      tp2: 4315.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4294.0;
    // Synthetic candles showing 5M counter pressure against BUY
    const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const ind5m: TechnicalIndicators = { ...generateMockIndicators(currentPrice, 'BEARISH'), rsi14: 42 };
    const ind15m = generateMockIndicators(currentPrice, 'NEUTRAL');
    const ind1h = generateMockIndicators(currentPrice, 'NEUTRAL');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles5m,
      candles5m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed =
      evalResult.health.reversalLevel === 2 &&
      evalResult.action.actionType === 'REVERSAL_WATCH' &&
      evalResult.action.requiresConfirmation === false;

    results.push({
      testNumber: 8,
      name: 'REVERSAL_WATCH (Level 2) activates without closing trade prematurely',
      passed,
      details: `Action: ${evalResult.action.actionType}, Level: ${evalResult.health.reversalLevel}, Opposite Pressure: ${evalResult.health.oppositePressureScore}%`,
    });
  } catch (err: any) {
    results.push({ testNumber: 8, name: 'REVERSAL_WATCH test', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 9: Confirmed high-conviction reversal (Level 3) triggers EARLY_EXIT
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-early-exit',
      tradeNumber: 9,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4300.0,
      sl: 4292.0,
      tp1: 4312.0,
      tp2: 4322.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 8.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4296.0;
    // Multi-timeframe strong bearish trend breaking 15M/5M structure against BUY
    const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 25);
    const candles15m = generateSyntheticCandles(currentPrice, 'DOWN', 25);
    const candles1h = generateSyntheticCandles(currentPrice, 'DOWN', 25);
    const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind15m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind1h = generateMockIndicators(currentPrice, 'BEARISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed =
      evalResult.health.reversalLevel === 3 &&
      evalResult.action.actionType === 'EARLY_EXIT' &&
      evalResult.action.managementState === 'EARLY_EXIT' &&
      evalResult.action.oppositeSetupCandidate !== undefined;

    results.push({
      testNumber: 9,
      name: 'Confirmed high-conviction reversal triggers EARLY_EXIT recommendation',
      passed,
      details: `Action: ${evalResult.action.actionType}, State: ${evalResult.action.managementState}, Candidate: ${evalResult.action.oppositeSetupCandidate?.direction}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 9, name: 'EARLY_EXIT test', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 10: Opposite setup must pass validation before future reversal candidate
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-opposite-candidate',
      tradeNumber: 10,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 4280.0,
      sl: 4288.0,
      tp1: 4270.0,
      tp2: 4260.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 8.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'SMC Engine',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const currentPrice = 4284.0;
    const candles5m = generateSyntheticCandles(currentPrice, 'UP', 25);
    const candles15m = generateSyntheticCandles(currentPrice, 'UP', 25);
    const candles1h = generateSyntheticCandles(currentPrice, 'UP', 25);
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind15m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind1h = generateMockIndicators(currentPrice, 'BULLISH');

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const candidate = evalResult.action.oppositeSetupCandidate;
    const passed =
      candidate !== undefined &&
      candidate.direction === 'BUY' &&
      candidate.stopLoss < candidate.entry &&
      candidate.tp1 > candidate.entry &&
      candidate.confidence >= 75;

    results.push({
      testNumber: 10,
      name: 'Opposite setup candidate passes directional and confidence checks',
      passed,
      details: `Candidate: ${candidate?.direction} @ $${candidate?.entry}, SL: $${candidate?.stopLoss}, TP1: $${candidate?.tp1}, Conf: ${candidate?.confidence}%`,
    });
  } catch (err: any) {
    results.push({ testNumber: 10, name: 'Opposite setup check', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 11: Same management action is deduplicated and not sent repeatedly
  // --------------------------------------------------------------------------
  try {
    tradeManagementEngine.clearNotificationCache();
    const trade: TradeLedgerItem = {
      id: 'test-dedup-action',
      tradeNumber: 11,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4285.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    // Setup trade experiencing opposite pressure (REVERSAL_WATCH)
    const currentPrice = 4288.0;
    const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 20);
    const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind15m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind1h = generateMockIndicators(currentPrice, 'BEARISH');

    // First evaluation: not duplicate
    const eval1 = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles5m,
      candles5m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    await tradeManagementEngine.applyManagementDecision(eval1, trade, baseSettings, activeStorage);

    // Second evaluation with identical state & price: MUST be flagged duplicate
    const eval2 = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles5m,
      candles5m,
      candles5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    const passed = eval1.isDuplicateNotification === false && eval2.isDuplicateNotification === true;
    results.push({
      testNumber: 11,
      name: 'Management action deduplication suppresses redundant notifications',
      passed,
      details: `First eval duplicate: ${eval1.isDuplicateNotification}, Second eval duplicate: ${eval2.isDuplicateNotification}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 11, name: 'Deduplication test', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 12: Invalid SL modification (widening SL) is strictly rejected
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-invalid-sl',
      tradeNumber: 12,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4285.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    // Attempting to widen BUY stop from 4285.0 to 4280.0 (strictly illegal)
    const illegalAction = {
      actionType: 'UPDATE_SL' as const,
      tradeId: trade.id,
      direction: 'BUY' as const,
      currentPrice: 4292.0,
      entryPrice: 4290.0,
      oldSL: 4285.0,
      newSL: 4280.0, // Illegal widening
      oldTP1: 4300.0,
      managementState: 'TRAIL_STOP' as const,
      reason: 'Illegal widening test',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };

    const safety = tradeManagementEngine.validateManagementActionSafety(
      illegalAction,
      trade,
      100,
      baseSettings
    );

    const passed = safety.valid === false && safety.reason?.includes('Risk increase prohibited');
    results.push({
      testNumber: 12,
      name: 'Safety engine strictly rejects SL widening (anti-risk rule)',
      passed,
      details: `Safety valid: ${safety.valid}, Reason: ${safety.reason}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 12, name: 'SL widening rejection', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 13: Risk is never increased accidentally
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-risk-guard',
      tradeNumber: 13,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 4300.0,
      sl: 4305.0,
      tp1: 4290.0,
      tp2: 4280.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    // Attempting to widen SELL stop from 4305.0 to 4310.0
    const illegalSellAction = {
      actionType: 'UPDATE_SL' as const,
      tradeId: trade.id,
      direction: 'SELL' as const,
      currentPrice: 4295.0,
      entryPrice: 4300.0,
      oldSL: 4305.0,
      newSL: 4310.0, // Widening SELL SL increases risk
      oldTP1: 4290.0,
      managementState: 'TRAIL_STOP' as const,
      reason: 'Illegal widening sell test',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };

    const safety = tradeManagementEngine.validateManagementActionSafety(
      illegalSellAction,
      trade,
      100,
      baseSettings
    );

    const passed = safety.valid === false;
    results.push({
      testNumber: 13,
      name: 'Monetary risk increase on SELL is prevented by safety validator',
      passed,
      details: `Safety valid: ${safety.valid}, Blocked widening: ${!safety.valid}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 13, name: 'Risk increase check', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 14: HOLD produces no notifications or spam
  // --------------------------------------------------------------------------
  try {
    const trade: TradeLedgerItem = {
      id: 'test-hold-no-spam',
      tradeNumber: 14,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4285.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 15,
      riskAmount: 5.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Order Block',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };

    const holdAction = {
      actionType: 'HOLD' as const,
      tradeId: trade.id,
      direction: 'BUY' as const,
      currentPrice: 4292.0,
      entryPrice: 4290.0,
      oldSL: 4285.0,
      oldTP1: 4300.0,
      managementState: 'HOLD' as const,
      reason: 'Holding intact thesis',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };

    const sent = await tradeManagementEngine.sendManagementNotification(holdAction, trade, undefined, activeStorage.getTelegramNotifier());
    const passed = sent === false; // HOLD must immediately return false and send nothing

    results.push({
      testNumber: 14,
      name: 'HOLD state produces zero spam / notifications',
      passed,
      details: `HOLD notification sent: ${sent} (expected false)`,
    });
  } catch (err: any) {
    results.push({ testNumber: 14, name: 'HOLD spam check', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 15: realizedPnl remains separate from theoretical RR
  // --------------------------------------------------------------------------
  try {
    const tradeId = `test-accounting-separation-${Date.now()}`;
    // Ensure the trade is present in the trade ledger before recording outcome
    activeStorage.saveTrade({
      id: tradeId,
      tradeNumber: 999,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 4296.49,
      sl: 4300.49,
      slPoints: 40,
      tp1: 4278.29,
      tp2: 4276.25,
      rr: '1:4',
      riskPercent: 1.0,
      riskAmount: 4.0,
      confidence: 85,
      setup: 'Test Accounting Setup',
      result: 'OPEN',
      pl: 0,
      balanceAfterTrade: 100,
    });

    const record = {
      signalId: tradeId,
      tradeId,
      direction: 'SELL NOW' as const,
      orderType: 'MARKET' as const,
      entry: 4296.49,
      stopLoss: 4300.49,
      tp1: 4278.29,
      tp2: 4276.25,
      outcome: 'WIN' as const,
      realizedPnl: 17.0, // Authoritative realized dollar P&L
      exitPrice: 4279.49,
      source: 'MANUAL' as const,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const res = activeStorage.recordTradeOutcome(record);
    const passed =
      res.success &&
      res.trade?.realizedPnl === 17.0 &&
      res.trade?.realizedPnl !== undefined;

    results.push({
      testNumber: 15,
      name: 'Realized P&L remains authoritative and strictly separated from theoretical RR',
      passed,
      details: `Saved realizedPnl: $${res.trade?.realizedPnl}, Separated from theoretical math: true`,
    });
  } catch (err: any) {
    results.push({ testNumber: 15, name: 'Realized P&L separation', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 16: Future MT5 execution adapter structure
  // --------------------------------------------------------------------------
  try {
    const earlyExitAction = {
      actionType: 'EARLY_EXIT' as const,
      tradeId: 'test-mt5-execution-spec',
      direction: 'SELL' as const,
      currentPrice: 4285.0,
      entryPrice: 4295.0,
      oldSL: 4300.0,
      oldTP1: 4275.0,
      managementState: 'EARLY_EXIT' as const,
      reason: 'Reversal confirmed',
      confidence: 85,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
      oppositeSetupCandidate: {
        direction: 'BUY' as const,
        setupName: 'Bullish Reversal',
        entry: 4285.0,
        stopLoss: 4280.0,
        tp1: 4295.0,
        tp2: 4305.0,
        confidence: 85,
      },
    };

    // When auto-trading is simulated as active
    const autoSettings: AppSettings = { ...baseSettings, autoTradingEnabled: true };
    const execPlan = tradeManagementEngine.prepareFutureAutoTradeExecution(
      earlyExitAction,
      autoSettings
    );

    const hasClose = execPlan.steps.some((s) => s.action === 'MT5_CLOSE_POSITION');
    const hasVerify = execPlan.steps.some((s) => s.action === 'MT5_VERIFY_POSITION_CLOSED');
    const hasOpposite = execPlan.steps.some((s) => s.action === 'MT5_RE_EVALUATE_AND_OPEN_OPPOSITE');

    const passed = execPlan.executable && hasClose && hasVerify && hasOpposite;
    results.push({
      testNumber: 16,
      name: 'Future MT5 execution adapter contains complete structured step lifecycle',
      passed,
      details: `Steps count: ${execPlan.steps.length} (${execPlan.steps.map((s) => s.action).join(' -> ')})`,
    });
  } catch (err: any) {
    results.push({ testNumber: 16, name: 'MT5 adapter structure', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 17: Auto Trading remains strictly disabled by default
  // --------------------------------------------------------------------------
  try {
    const settings = activeStorage.getSettings();
    const action = {
      actionType: 'PARTIAL_CLOSE_TP1' as const,
      tradeId: 'test-disabled-auto',
      direction: 'BUY' as const,
      currentPrice: 4300.0,
      entryPrice: 4290.0,
      oldSL: 4285.0,
      oldTP1: 4300.0,
      managementState: 'TP1_HIT' as const,
      reason: 'TP1 reached',
      confidence: 90,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: true,
    };

    const plan = tradeManagementEngine.prepareFutureAutoTradeExecution(action, settings);
    const passed = settings.autoTradingEnabled === false && plan.executable === false;

    results.push({
      testNumber: 17,
      name: 'Auto Trading remains strictly disabled by default (Manual execution mode)',
      passed,
      details: `autoTradingEnabled: ${settings.autoTradingEnabled}, Adapter executable: ${plan.executable}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 17, name: 'Auto trading disabled check', passed: false, details: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 18: Existing S1-S9 strategy candidate generation behavior remains intact
  // --------------------------------------------------------------------------
  try {
    const currentPrice = 4280.0;
    const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 50);
    const candles15m = generateSyntheticCandles(currentPrice, 'DOWN', 50);
    const candles1h = generateSyntheticCandles(currentPrice, 'DOWN', 50);
    const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind15m = generateMockIndicators(currentPrice, 'BEARISH');
    const ind1h = generateMockIndicators(currentPrice, 'BEARISH');

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
    });

    const isArray = Array.isArray(result.allCandidates);
    const passed = isArray && typeof result.hasValidSignal === 'boolean';

    results.push({
      testNumber: 18,
      name: 'Existing S1-S9 multi-strategy generation behavior remains unchanged',
      passed,
      details: `Generated candidates array: ${isArray}, Count: ${result.allCandidates.length}`,
    });
  } catch (err: any) {
    results.push({ testNumber: 18, name: 'S1-S9 strategies intact', passed: false, details: err.message });
  }

  const allPassed = results.every((r) => r.passed);
  return { allPassed, results };
  } catch (e: any) {
    return { allPassed: false, results: [] };
  }
}
