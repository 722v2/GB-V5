import assert from 'assert';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { storage, PersistentStorage } from '../server/storage.js';
import { tradeManagementEngine } from '../server/tradeManagementEngine.js';
import {
  Candle,
  TechnicalIndicators,
  TradeLedgerItem,
  TradeSignal,
  AppSettings,
  DEFAULT_APP_SETTINGS,
} from '../src/types.js';

function computeFileHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function generateSyntheticCandles(
  basePrice: number,
  trend: 'UP' | 'DOWN' | 'RANGING',
  count: number = 30
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  const step = trend === 'UP' ? 0.5 : trend === 'DOWN' ? -0.5 : 0;
  const startPrice = basePrice - (count - 1) * step;

  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - 1 - i) * 300000;
    let delta = step;
    if (trend === 'RANGING') {
      delta = i % 2 === 0 ? 0.2 : -0.2;
    }
    const price = startPrice + i * delta;
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

function generateMockIndicators(
  currentPrice: number,
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
): TechnicalIndicators {
  if (trend === 'BULLISH') {
    return {
      rsi14: 65,
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
      rsi14: 35,
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

async function runPhase5BRegressionSuite() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 5B: TRADE MANAGEMENT & USER TRACKING REGRESSION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function recordPass(testName: string, detail?: string) {
    passed++;
    console.log(`✅ [PASS] ${testName}${detail ? ': ' + detail : ''}`);
  }

  // Snapshot sensitive production files before test suite
  const queuePath = 'data/telegram_retry_queue.json';
  const dispatchPath = 'data/telegram_dispatches.json';
  const queueHashBefore = computeFileHash(queuePath);
  const dispatchHashBefore = computeFileHash(dispatchPath);

  // Snapshot production storage singleton before test suite
  await storage.waitUntilReady();
  const prodTradesBefore = storage.getTrades().length;
  const prodOutcomesBefore = storage.getTradeOutcomes().length;
  const prodBalanceBefore = storage.getCurrentBalance();
  const prodStartingBefore = storage.getStartingBalance();

  // Setup Fetch Interceptor to strictly block and record any Telegram calls
  const originalFetch = globalThis.fetch;
  let telegramFetchAttemptCount = 0;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      telegramFetchAttemptCount++;
      throw new Error('Test Isolation Violation: Outbound Telegram network call intercepted');
    }
    return originalFetch(input, init);
  };

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Analysis Mode Signal Entry Confirmation creates managed open trade
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 1: Analysis Mode Signal Entry Confirmation creates managed open trade');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const testSignal: TradeSignal = {
        id: 'sig_p5b_entry_1',
        timestamp: Date.now(),
        asset: 'XAU/USD',
        signal: 'BUY NOW',
        entry: 2650.0,
        stopLoss: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        confidence: 85,
        riskPercent: 15,
        riskAmount: 15.0,
        standardLot: 0.03,
        rr: '1:2.0',
        setup: 'Bullish OB Liquidity Sweep',
        lifecycleState: 'READY',
        mainReasons: ['Strong 1H alignment', '5M MSS Confirmation'],
        invalidation: 'Break below 2645.00',
      } as any;
      testStorage.saveSignal(testSignal);

      const confirmResult = testStorage.confirmSignalEntry({
        signalId: testSignal.id,
        actualEntry: 2651.0,
        lotSize: 0.02,
        riskPercent: 10,
        notes: 'User confirmed manual entry at 2651.00',
      });

      assert.strictEqual(confirmResult.success, true, 'Confirmation should succeed');
      assert.strictEqual(confirmResult.isDuplicate, false, 'Should not be marked as duplicate on first entry');
      assert.ok(confirmResult.trade, 'Managed trade should be returned');
      assert.strictEqual(confirmResult.trade?.entry, 2651.0, 'Trade entry should reflect actual user entry price');
      assert.strictEqual(confirmResult.trade?.lotSize, 0.02, 'Trade lotSize should reflect user custom lot');
      assert.strictEqual(confirmResult.trade?.riskPercent, 10, 'Trade riskPercent should reflect user custom risk');
      assert.strictEqual(confirmResult.trade?.result, 'OPEN', 'Trade must be OPEN in ledger');
      assert.strictEqual(confirmResult.trade?.source, 'MANUAL', 'Trade source must be MANUAL in Analysis Mode');
      assert.strictEqual(confirmResult.signal?.lifecycleState, 'ENTERED', 'Signal lifecycleState must transition to ENTERED');

      const ledgerTrades = testStorage.getTrades();
      assert.strictEqual(ledgerTrades.length, 1, 'Exactly 1 trade should exist in isolated ledger');
      recordPass('TEST 1: Analysis Mode Signal Entry Confirmation', `Trade #${confirmResult.trade?.tradeNumber} created @ $2651.00`);
    }

    // --------------------------------------------------------------------------
    // TEST 2: Idempotency of confirmSignalEntry (prevents duplicate trades)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 2: Idempotency of confirmSignalEntry');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const testSignal: TradeSignal = {
        id: 'sig_p5b_idempotent_2',
        timestamp: Date.now(),
        asset: 'XAU/USD',
        signal: 'SELL NOW',
        entry: 2655.0,
        stopLoss: 2660.0,
        tp1: 2645.0,
        confidence: 80,
        riskPercent: 15,
        riskAmount: 15.0,
        standardLot: 0.03,
        rr: '1:2.0',
        setup: 'Bearish OB',
        lifecycleState: 'READY',
        mainReasons: ['Liquidity swept'],
        invalidation: 'Break above 2660',
      } as any;
      testStorage.saveSignal(testSignal);

      const firstConfirm = testStorage.confirmSignalEntry({ signalId: testSignal.id });
      assert.strictEqual(firstConfirm.success, true);
      assert.strictEqual(firstConfirm.isDuplicate, false);

      const secondConfirm = testStorage.confirmSignalEntry({ signalId: testSignal.id });
      assert.strictEqual(secondConfirm.success, true);
      assert.strictEqual(secondConfirm.isDuplicate, true, 'Second confirmation must report isDuplicate: true');
      assert.strictEqual(secondConfirm.trade?.id, firstConfirm.trade?.id, 'Returned trade must match existing trade');

      assert.strictEqual(testStorage.getTrades().length, 1, 'Ledger must not contain duplicate trades');
      recordPass('TEST 2: confirmSignalEntry Idempotency', 'Prevented duplicate trade creation cleanly');
    }

    // --------------------------------------------------------------------------
    // TEST 3: User Rejection / Not Entered (Zero penalty, no trade created)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 3: User Rejection (markSignalOrOpportunityNotEntered)');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const testSignal: TradeSignal = {
        id: 'sig_p5b_not_entered_3',
        timestamp: Date.now(),
        asset: 'XAU/USD',
        signal: 'BUY NOW',
        entry: 2660.0,
        stopLoss: 2655.0,
        tp1: 2670.0,
        confidence: 78,
        riskPercent: 15,
        riskAmount: 15.0,
        standardLot: 0.03,
        rr: '1:2.0',
        setup: 'Order Block',
        lifecycleState: 'READY',
        mainReasons: ['Setup'],
        invalidation: 'Stop',
      } as any;
      testStorage.saveSignal(testSignal);

      const rejectRes = testStorage.markSignalOrOpportunityNotEntered(testSignal.id);
      assert.strictEqual(rejectRes.success, true);
      assert.strictEqual(rejectRes.signal?.lifecycleState, 'NOT_ENTERED', 'Signal must be marked NOT_ENTERED');
      assert.strictEqual(testStorage.getTrades().length, 0, 'No trade should be added to ledger');

      const todayStats = testStorage.getTodayStats();
      assert.strictEqual(todayStats.tradesCount, 0, 'Not-entered signal must not count towards executed trades');
      assert.strictEqual(todayStats.losses, 0, 'Not-entered signal must never count as a loss');

      const dashStats = testStorage.getDashboardStats();
      assert.strictEqual(dashStats.signalsNotEntered, 1, 'Dashboard stats signalsNotEntered must be incremented');
      recordPass('TEST 3: User Rejection (NOT_ENTERED)', 'Correctly recorded with 0 penalty to win rate');
    }

    // --------------------------------------------------------------------------
    // TEST 4: Pre-TP1 Predictive Momentum generates Target Extension (UPDATE_TP2)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 4: Pre-TP1 Predictive Momentum generates Target Extension');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_pre_tp1_ext',
        tradeNumber: 1,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      // Price at 2658.0 = 80% progress to TP1 with strong continuation
      const currentPrice = 2658.0;
      const candles5m = generateSyntheticCandles(currentPrice, 'UP', 30);
      const ind5m = generateMockIndicators(currentPrice, 'BULLISH');
      ind5m.rsi14 = 68;

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        [],
        candles5m,
        [],
        generateMockIndicators(currentPrice, 'BULLISH'),
        generateMockIndicators(currentPrice, 'BULLISH'),
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.safetyPassed, true, 'Safety validation must pass');
      assert.strictEqual(evalRes.action.actionType, 'UPDATE_TP2', 'Must recommend UPDATE_TP2 target extension');
      assert.strictEqual(evalRes.action.managementState, 'TARGET_EXTENSION', 'Management state must be TARGET_EXTENSION');
      assert.ok(evalRes.action.newTP2 && evalRes.action.newTP2 > trade.tp1, 'newTP2 must be beyond TP1');
      recordPass('TEST 4: Pre-TP1 Target Extension', `Extended proposed TP2 to $${evalRes.action.newTP2}`);
    }

    // --------------------------------------------------------------------------
    // TEST 5: Pre-TP1 Predictive Weakening generates Profit Protection (UPDATE_SL)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 5: Pre-TP1 Predictive Weakening generates Profit Protection');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_pre_tp1_prot',
        tradeNumber: 2,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      // Price at 2657.5 = 75% progress to TP1, but weakening structure with counter pressure
      const currentPrice = 2657.5;
      const candles5m = generateSyntheticCandles(currentPrice, 'RANGING', 30);
      const ind5m = generateMockIndicators(currentPrice, 'NEUTRAL');
      ind5m.rsi14 = 48;
      ind5m.structure = 'RANGING';

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        [],
        candles5m,
        [],
        generateMockIndicators(currentPrice, 'NEUTRAL'),
        generateMockIndicators(currentPrice, 'NEUTRAL'),
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      // Should recommend locking profit / moving SL to protection
      assert.strictEqual(evalRes.safetyPassed, true);
      assert.strictEqual(evalRes.action.actionType, 'UPDATE_SL', 'Must recommend UPDATE_SL profit protection');
      assert.ok(evalRes.action.newSL && evalRes.action.newSL > trade.sl, 'New SL must be higher than initial SL');
      assert.ok(evalRes.action.newSL! >= trade.entry, 'New SL must protect entry or lock profit');
      recordPass('TEST 5: Pre-TP1 Profit Protection', `Protected SL at $${evalRes.action.newSL}`);
    }

    // --------------------------------------------------------------------------
    // TEST 6: TP1 Hit triggers PARTIAL_CLOSE_TP1 with user setting percent
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 6: TP1 Hit triggers PARTIAL_CLOSE_TP1');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_tp1_hit',
        tradeNumber: 3,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      const customSettings: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        partialClosePercent: 60,
      };

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        2660.5, // reached TP1
        [],
        [],
        generateSyntheticCandles(2660.5, 'UP', 30),
        [],
        generateMockIndicators(2660.5, 'BULLISH'),
        generateMockIndicators(2660.5, 'BULLISH'),
        generateMockIndicators(2660.5, 'BULLISH'),
        100,
        customSettings,
        testStorage
      );

      assert.strictEqual(evalRes.action.actionType, 'PARTIAL_CLOSE_TP1');
      assert.strictEqual(evalRes.action.managementState, 'TP1_HIT');
      assert.strictEqual(evalRes.action.partialClosePercent, 60, 'Must adopt user partialClosePercent of 60%');
      assert.ok(evalRes.action.newSL && evalRes.action.newSL >= trade.entry, 'New SL must protect breakeven');
      recordPass('TEST 6: TP1 Partial Close', `Triggered 60% partial close with BE SL $${evalRes.action.newSL}`);
    }

    // --------------------------------------------------------------------------
    // TEST 7: Post-TP1 Dynamic Stop Trailing (UPDATE_SL / TRAIL_STOP)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 7: Post-TP1 Dynamic Stop Trailing');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_trail',
        tradeNumber: 4,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2650.5, // already moved to BE
        tp1: 2660.0,
        tp2: 2675.0,
        partialClosed: true,
        rr: '1:2.5',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      const currentPrice = 2668.0; // Past TP1, 1.8R profit
      const ind5m = generateMockIndicators(currentPrice, 'BULLISH');
      ind5m.swingLow = 2662.0;

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        [],
        generateSyntheticCandles(currentPrice, 'UP', 30),
        [],
        generateMockIndicators(currentPrice, 'BULLISH'),
        generateMockIndicators(currentPrice, 'BULLISH'),
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.action.actionType, 'UPDATE_SL');
      assert.strictEqual(evalRes.action.managementState, 'TRAIL_STOP');
      assert.ok(evalRes.action.newSL && evalRes.action.newSL > trade.sl, 'Trailing SL must ratchet upward');
      recordPass('TEST 7: Dynamic Stop Trailing', `Trailed SL to $${evalRes.action.newSL}`);
    }

    // --------------------------------------------------------------------------
    // TEST 8: Post-TP1 Target Extension when approaching TP2 (UPDATE_TP2)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 8: Post-TP1 Dynamic Target Extension');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_post_tp2_ext',
        tradeNumber: 5,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'SELL NOW',
        entry: 2650.0,
        sl: 2649.5,
        tp1: 2640.0,
        tp2: 2630.0,
        partialClosed: true,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bearish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      // Price at 2632.0 (90% to TP2) with strong bearish momentum
      const currentPrice = 2632.0;
      const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
      ind5m.marketRegime = 'STRONG_DOWNTREND';
      ind5m.structure = 'BEARISH';
      ind5m.rsi14 = 28;

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        [],
        generateSyntheticCandles(currentPrice, 'DOWN', 30),
        [],
        generateMockIndicators(currentPrice, 'BEARISH'),
        generateMockIndicators(currentPrice, 'BEARISH'),
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.action.actionType, 'UPDATE_TP2');
      assert.strictEqual(evalRes.action.managementState, 'TARGET_EXTENSION');
      assert.ok(evalRes.action.newTP2 && evalRes.action.newTP2 < trade.tp2, 'New SELL TP2 must be lower than original TP2');
      recordPass('TEST 8: Post-TP1 Target Extension', `Extended SELL TP2 to $${evalRes.action.newTP2}`);
    }

    // --------------------------------------------------------------------------
    // TEST 9: Level 1 Reversal / Normal Pullback evaluates to HOLD (Zero noise)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 9: Normal Pullback evaluates to HOLD (Zero noise)');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_hold',
        tradeNumber: 6,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      const currentPrice = 2652.0; // Early in trade, normal consolidation
      const ind5m = generateMockIndicators(currentPrice, 'BULLISH');

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        [],
        generateSyntheticCandles(currentPrice, 'RANGING', 30),
        [],
        generateMockIndicators(currentPrice, 'BULLISH'),
        generateMockIndicators(currentPrice, 'BULLISH'),
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.action.actionType, 'HOLD');
      assert.strictEqual(evalRes.action.managementState, 'HOLD');
      assert.strictEqual(evalRes.health.reversalLevel, 0);
      assert.strictEqual(evalRes.isDuplicateNotification, true, 'HOLD must be marked as duplicate/suppressed');
      recordPass('TEST 9: Normal Pullback evaluates to HOLD', 'Zero noise / zero notifications generated');
    }

    // --------------------------------------------------------------------------
    // TEST 10: Level 2 Reversal evaluates to REVERSAL_WATCH without closing prematurely
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 10: Level 2 Reversal evaluates to REVERSAL_WATCH');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_rev_watch',
        tradeNumber: 7,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      const currentPrice = 2648.5; // Slight dip with counter pressure
      const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
      ind5m.structure = 'BEARISH';
      ind5m.rsi14 = 42;

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        [],
        generateSyntheticCandles(currentPrice, 'DOWN', 30),
        [],
        generateMockIndicators(currentPrice, 'NEUTRAL'),
        generateMockIndicators(currentPrice, 'BEARISH'),
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.action.actionType, 'REVERSAL_WATCH');
      assert.strictEqual(evalRes.action.managementState, 'REVERSAL_WATCH');
      assert.strictEqual(evalRes.health.reversalLevel, 2);
      assert.strictEqual(trade.isActive, true, 'Trade must remain open during REVERSAL_WATCH');
      recordPass('TEST 10: Level 2 Reversal Watch', 'Issued warning while keeping trade active');
    }

    // --------------------------------------------------------------------------
    // TEST 11: Level 3 Reversal evaluates to EARLY_EXIT recommendation
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 11: Level 3 Reversal evaluates to EARLY_EXIT');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      tradeManagementEngine.clearNotificationCache();

      const trade: TradeLedgerItem = {
        id: 'trade_p5b_early_exit',
        tradeNumber: 8,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2665.0,
        tp2: 2680.0,
        rr: '1:2.5',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Bullish OB',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      };
      testStorage.saveTrade(trade);

      // Deep opposing breakdown across 1H, 15M, and 5M
      const currentPrice = 2644.0;
      const candles5m = generateSyntheticCandles(currentPrice, 'DOWN', 50);
      const candles15m = generateSyntheticCandles(currentPrice, 'DOWN', 30);
      const ind5m = generateMockIndicators(currentPrice, 'BEARISH');
      ind5m.structure = 'BEARISH';
      ind5m.marketRegime = 'STRONG_DOWNTREND';
      ind5m.rsi14 = 29;

      const ind15m = generateMockIndicators(currentPrice, 'BEARISH');
      ind15m.structure = 'BEARISH';
      ind15m.marketRegime = 'STRONG_DOWNTREND';

      const ind1h = generateMockIndicators(currentPrice, 'BEARISH');

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        trade,
        currentPrice,
        [],
        candles15m,
        candles5m,
        [],
        ind1h,
        ind15m,
        ind5m,
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.action.actionType, 'EARLY_EXIT');
      assert.strictEqual(evalRes.action.managementState, 'EARLY_EXIT');
      assert.strictEqual(evalRes.health.reversalLevel, 3);
      recordPass('TEST 11: Level 3 Confirmed Reversal Early Exit', 'EARLY_EXIT recommended with opposite setup evaluation');
    }

    // --------------------------------------------------------------------------
    // TEST 12: Anti-Risk Safety: Rejects Stop Loss widening on BUY
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 12: Anti-Risk Safety: Rejects Stop Loss widening on BUY');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const action = {
        actionType: 'UPDATE_SL' as const,
        tradeId: 't_safe_buy',
        direction: 'BUY' as const,
        currentPrice: 2650.0,
        entryPrice: 2650.0,
        oldSL: 2645.0,
        newSL: 2640.0, // WIDENED! (Anti-risk violation)
        oldTP1: 2660.0,
        managementState: 'PROTECT' as const,
        reason: 'Attempted widening',
        confidence: 80,
        timestamp: Date.now(),
        source: 'DETERMINISTIC' as const,
        requiresConfirmation: true,
      };

      const safetyRes = (tradeManagementEngine as any).validateManagementActionSafety(
        action,
        { sl: 2645.0, lotSize: 0.01 } as TradeLedgerItem,
        100,
        DEFAULT_APP_SETTINGS
      );

      assert.strictEqual(safetyRes.valid, false, 'Widening BUY SL must be rejected');
      assert.ok(safetyRes.reason?.includes('Risk increase prohibited') || safetyRes.reason?.includes('widen'), 'Reason must mention risk prohibition');
      recordPass('TEST 12: Rejects BUY SL widening', safetyRes.reason);
    }

    // --------------------------------------------------------------------------
    // TEST 13: Anti-Risk Safety: Rejects Stop Loss widening on SELL
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 13: Anti-Risk Safety: Rejects Stop Loss widening on SELL');
    {
      const action = {
        actionType: 'UPDATE_SL' as const,
        tradeId: 't_safe_sell',
        direction: 'SELL' as const,
        currentPrice: 2650.0,
        entryPrice: 2650.0,
        oldSL: 2655.0,
        newSL: 2660.0, // WIDENED! (Anti-risk violation)
        oldTP1: 2640.0,
        managementState: 'PROTECT' as const,
        reason: 'Attempted widening on SELL',
        confidence: 80,
        timestamp: Date.now(),
        source: 'DETERMINISTIC' as const,
        requiresConfirmation: true,
      };

      const safetyRes = (tradeManagementEngine as any).validateManagementActionSafety(
        action,
        { sl: 2655.0, lotSize: 0.01 } as TradeLedgerItem,
        100,
        DEFAULT_APP_SETTINGS
      );

      assert.strictEqual(safetyRes.valid, false, 'Widening SELL SL must be rejected');
      recordPass('TEST 13: Rejects SELL SL widening', safetyRes.reason);
    }

    // --------------------------------------------------------------------------
    // TEST 14: Anti-Risk Safety: Blocks Monetary Risk Increases
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 14: Anti-Risk Safety: Blocks Monetary Risk Increases');
    {
      const action = {
        actionType: 'UPDATE_SL' as const,
        tradeId: 't_safe_risk',
        direction: 'BUY' as const,
        currentPrice: 2650.0,
        entryPrice: 2650.0,
        oldSL: 2647.0, // initial risk: $30
        newSL: 2642.0, // proposed risk: $80
        oldTP1: 2660.0,
        managementState: 'PROTECT' as const,
        reason: 'Increased monetary risk',
        confidence: 80,
        timestamp: Date.now(),
        source: 'DETERMINISTIC' as const,
        requiresConfirmation: true,
      };

      const safetyRes = (tradeManagementEngine as any).validateManagementActionSafety(
        action,
        { sl: 2647.0, lotSize: 0.01 } as TradeLedgerItem,
        100,
        DEFAULT_APP_SETTINGS
      );

      assert.strictEqual(safetyRes.valid, false, 'Monetary risk increase must be strictly blocked');
      recordPass('TEST 14: Blocks Monetary Risk Increases', safetyRes.reason);
    }

    // --------------------------------------------------------------------------
    // TEST 15: Safety Guard auto-voids anomalous price deviation (>30%)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 15: Auto-voids anomalous price deviation (>30%)');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const anomalyTrade: TradeLedgerItem = {
        id: 't_anomalous_100',
        tradeNumber: 9,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 100.0, // Extreme deviation from $2650 market price
        sl: 90.0,
        tp1: 120.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Test',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      } as any;
      testStorage.saveTrade(anomalyTrade);

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        anomalyTrade,
        2650.0,
        [],
        [],
        [],
        [],
        generateMockIndicators(2650, 'NEUTRAL'),
        generateMockIndicators(2650, 'NEUTRAL'),
        generateMockIndicators(2650, 'NEUTRAL'),
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.state, 'CLOSED');
      assert.strictEqual(evalRes.action.managementState, 'CLOSED');
      recordPass('TEST 15: Extreme Price Anomaly Guard', 'Auto-voided trade cleanly');
    }

    // --------------------------------------------------------------------------
    // TEST 16: Missing critical price levels marks trade DATA_INCOMPLETE
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 16: Missing price levels marks trade DATA_INCOMPLETE');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const incompleteTrade: any = {
        id: 't_incomplete_data',
        tradeNumber: 10,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 0, // missing entry
        sl: 0,
        tp1: 0,
        result: 'OPEN',
        isActive: true,
      };
      testStorage.saveTrade(incompleteTrade);

      const evalRes = await tradeManagementEngine.evaluateSingleTrade(
        incompleteTrade,
        2650.0,
        [],
        [],
        [],
        [],
        generateMockIndicators(2650, 'NEUTRAL'),
        generateMockIndicators(2650, 'NEUTRAL'),
        generateMockIndicators(2650, 'NEUTRAL'),
        100,
        DEFAULT_APP_SETTINGS,
        testStorage
      );

      assert.strictEqual(evalRes.state, 'DATA_INCOMPLETE');
      assert.strictEqual(evalRes.action.managementState, 'DATA_INCOMPLETE');
      assert.strictEqual(evalRes.safetyPassed, false);
      recordPass('TEST 16: Incomplete Data Safety Guard', 'Safely skipped without fabricating synthetic levels');
    }

    // --------------------------------------------------------------------------
    // TEST 17: Management Action Deduplication suppresses identical state alerts
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 17: Deduplication suppresses identical state alerts');
    {
      tradeManagementEngine.clearNotificationCache();
      const action = {
        actionType: 'UPDATE_SL' as const,
        tradeId: 't_dedup_1',
        direction: 'BUY' as const,
        currentPrice: 2655.0,
        entryPrice: 2650.0,
        oldSL: 2645.0,
        newSL: 2650.5,
        oldTP1: 2660.0,
        managementState: 'BE_LOCKED' as const,
        reason: 'Breakeven locked',
        confidence: 85,
        timestamp: Date.now(),
        source: 'DETERMINISTIC' as const,
        requiresConfirmation: true,
      };

      // First check: Not duplicate (state transition)
      const firstCheck = tradeManagementEngine.checkNotificationDeduplication('t_dedup_1', action);
      assert.strictEqual(firstCheck, false, 'First notification should NOT be suppressed');

      // Simulate applying and recording state
      (tradeManagementEngine as any).tradeLastNotifiedState.set('t_dedup_1', 'BE_LOCKED');
      (tradeManagementEngine as any).tradeLastNotifiedLevel.set('t_dedup_1', 2650.5);

      // Second check with same state and same level: suppressed!
      const secondCheck = tradeManagementEngine.checkNotificationDeduplication('t_dedup_1', action);
      assert.strictEqual(secondCheck, true, 'Duplicate identical state must be suppressed');
      recordPass('TEST 17: Deduplication suppresses redundant alerts', 'Identical state alert suppressed');
    }

    // --------------------------------------------------------------------------
    // TEST 18: Deduplication allows alert when level shifts significantly (>= 1.0)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 18: Deduplication allows alert on significant level update (>= 1.0)');
    {
      const shiftedAction = {
        actionType: 'UPDATE_SL' as const,
        tradeId: 't_dedup_1',
        direction: 'BUY' as const,
        currentPrice: 2658.0,
        entryPrice: 2650.0,
        oldSL: 2650.5,
        newSL: 2653.0, // shifted by +2.5 (> 1.0)
        oldTP1: 2660.0,
        managementState: 'BE_LOCKED' as const,
        reason: 'Further locked profit',
        confidence: 85,
        timestamp: Date.now(),
        source: 'DETERMINISTIC' as const,
        requiresConfirmation: true,
      };

      const shiftCheck = tradeManagementEngine.checkNotificationDeduplication('t_dedup_1', shiftedAction);
      assert.strictEqual(shiftCheck, false, 'Significant level change must NOT be suppressed');
      recordPass('TEST 18: Allows significant level updates', 'Level shift >= 1.0 passed deduplication');
    }

    // --------------------------------------------------------------------------
    // TEST 19: User manually closes Analysis Mode trade with authoritative USD P/L
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 19: User manually closes trade with authoritative USD P/L');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const trade: TradeLedgerItem = {
        id: 't_manual_close_user',
        signalId: 'sig_user_manual',
        tradeNumber: 11,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        rr: '1:2.0',
        riskPercent: 15,
        riskAmount: 5.0,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Manual Test',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
        source: 'MANUAL',
      } as any;
      testStorage.saveTrade(trade);

      const outcomeRecord: any = {
        signalId: trade.signalId,
        tradeId: trade.id,
        direction: trade.direction,
        orderType: 'MARKET',
        entry: trade.entry,
        stopLoss: trade.sl,
        tp1: trade.tp1,
        outcome: 'WIN',
        realizedPnl: 18.50, // Authoritative USD profit
        pl: 18.50,
        exitPrice: 2668.50,
        source: 'MANUAL',
        closedAt: Date.now(),
        closeReason: 'MANUAL_USER_CLOSE',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const outcomeRes = await testStorage.recordTradeOutcomeAsync(outcomeRecord);
      assert.strictEqual(outcomeRes.success, true);
      assert.strictEqual(outcomeRes.trade?.result, 'WIN');
      assert.strictEqual(outcomeRes.trade?.isActive, false);
      assert.strictEqual(outcomeRes.trade?.pl, 18.50);
      assert.strictEqual(outcomeRes.trade?.realizedPnl, 18.50);
      assert.strictEqual(testStorage.getCurrentBalance(), 118.50, 'Balance must be updated with exact realized P/L');
      recordPass('TEST 19: User Manual Close with Authoritative P/L', 'Balance updated to $118.50 with realized P/L $18.50');
    }

    // --------------------------------------------------------------------------
    // TEST 20: User applies management recommendation (applyManagementRecommendation)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 20: User applies management recommendation');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);
      const trade: TradeLedgerItem = {
        id: 't_apply_recom',
        tradeNumber: 12,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650.0,
        sl: 2645.0,
        tp1: 2660.0,
        tp2: 2670.0,
        suggestedSL: 2652.0, // Pending recommendation
        suggestedTP2: 2675.0,
        lastManagementAction: 'UPDATE_SL',
        managementState: 'TRAIL_STOP',
        result: 'OPEN',
        isActive: true,
        pl: 0,
        balanceAfterTrade: 100,
      } as any;
      testStorage.saveTrade(trade);

      const applyRes = testStorage.applyManagementRecommendation(trade.id);
      assert.strictEqual(applyRes.success, true);
      assert.strictEqual(applyRes.trade?.sl, 2652.0, 'Trade SL must be updated to suggestedSL');
      assert.strictEqual(applyRes.trade?.tp2, 2675.0, 'Trade TP2 must be updated to suggestedTP2');
      assert.strictEqual(applyRes.trade?.isRecommendationApplied, true, 'isRecommendationApplied must be true');
      recordPass('TEST 20: Apply Management Recommendation', `Updated SL: $${applyRes.trade?.sl}, TP2: $${applyRes.trade?.tp2}`);
    }

    // --------------------------------------------------------------------------
    // TEST 21: Separate Analytics Metrics (Signals vs User vs MT5)
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 21: Separate Analytics Metrics');
    {
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      // Seed 2 signals: 1 ENTERED, 1 NOT_ENTERED
      testStorage.saveSignal({
        id: 's_sep_1',
        timestamp: Date.now(),
        asset: 'XAU/USD',
        signal: 'BUY NOW',
        entry: 2650,
        stopLoss: 2645,
        tp1: 2660,
        confidence: 80,
        riskPercent: 15,
        riskAmount: 15,
        standardLot: 0.01,
        rr: '1:2',
        setup: 'Test',
        lifecycleState: 'ENTERED',
        mainReasons: [],
        invalidation: '',
      } as any);
      testStorage.saveSignal({
        id: 's_sep_2',
        timestamp: Date.now(),
        asset: 'XAU/USD',
        signal: 'SELL NOW',
        entry: 2650,
        stopLoss: 2655,
        tp1: 2640,
        confidence: 80,
        riskPercent: 15,
        riskAmount: 15,
        standardLot: 0.01,
        rr: '1:2',
        setup: 'Test',
        lifecycleState: 'NOT_ENTERED',
        mainReasons: [],
        invalidation: '',
      } as any);

      // Seed 1 Manual User Trade (WIN)
      testStorage.saveTrade({
        id: 't_user_win',
        tradeNumber: 1,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'BUY NOW',
        entry: 2650,
        sl: 2645,
        tp1: 2660,
        rr: '1:2',
        riskPercent: 15,
        riskAmount: 15,
        lotSize: 0.01,
        confidence: 80,
        setup: 'Manual',
        result: 'WIN',
        isActive: false,
        pl: 20.0,
        source: 'MANUAL',
        balanceAfterTrade: 120,
      } as any);

      // Seed 1 MT5 Automated Trade (LOSS)
      testStorage.saveTrade({
        id: 't_mt5_loss',
        tradeNumber: 2,
        date: 'Today',
        asset: 'XAU/USD',
        direction: 'SELL NOW',
        entry: 2650,
        sl: 2655,
        tp1: 2640,
        rr: '1:2',
        riskPercent: 15,
        riskAmount: 15,
        lotSize: 0.01,
        confidence: 80,
        setup: 'Auto MT5',
        result: 'LOSS',
        isActive: false,
        pl: -10.0,
        source: 'MT5',
        balanceAfterTrade: 110,
      } as any);

      const stats = testStorage.getDashboardStats();

      assert.strictEqual(stats.signalsGenerated, 2, 'signalsGenerated must be 2');
      assert.strictEqual(stats.signalsNotEntered, 1, 'signalsNotEntered must be 1');
      assert.strictEqual(stats.userTradesEntered, 1, 'userTradesEntered must be 1');
      assert.strictEqual(stats.userTradesWon, 1, 'userTradesWon must be 1');
      assert.strictEqual(stats.userTradesLost, 0, 'userTradesLost must be 0');
      assert.strictEqual(stats.userTradesPl, 20.0, 'userTradesPl must be 20.0');

      assert.strictEqual(stats.mt5TradesExecuted, 1, 'mt5TradesExecuted must be 1');
      assert.strictEqual(stats.mt5TradesWon, 0, 'mt5TradesWon must be 0');
      assert.strictEqual(stats.mt5TradesLost, 1, 'mt5TradesLost must be 1');
      assert.strictEqual(stats.mt5TradesPl, -10.0, 'mt5TradesPl must be -10.0');

      recordPass('TEST 21: Separate Analytics Metrics', 'Strict separation of Signals vs User Trades vs MT5 verified');
    }

    // --------------------------------------------------------------------------
    // TEST 22: Thread-Safe Concurrency & In-Flight Lock Guard
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 22: Thread-Safe Concurrency & In-Flight Lock Guard');
    {
      const lockTradeId = `lock_test_${Date.now()}`;
      assert.strictEqual(tradeManagementEngine.isInFlight(lockTradeId), false);

      const acquire1 = tradeManagementEngine.acquireInFlight(lockTradeId);
      assert.strictEqual(acquire1, true, 'First lock acquisition must succeed');
      assert.strictEqual(tradeManagementEngine.isInFlight(lockTradeId), true);

      const acquire2 = tradeManagementEngine.acquireInFlight(lockTradeId);
      assert.strictEqual(acquire2, false, 'Concurrent lock acquisition must be blocked');

      tradeManagementEngine.releaseInFlight(lockTradeId);
      assert.strictEqual(tradeManagementEngine.isInFlight(lockTradeId), false, 'Lock must be released');
      recordPass('TEST 22: Thread-Safe Concurrency Guard', 'In-flight locking prevented duplicate evaluations');
    }

    // --------------------------------------------------------------------------
    // TEST 23: Complete Isolation & Immutability Verification
    // --------------------------------------------------------------------------
    total++;
    console.log('\nTEST 23: Isolation Audit (Zero Telegram calls & Production Immutability)');
    {
      assert.strictEqual(telegramFetchAttemptCount, 0, 'Must have made 0 outbound network calls to api.telegram.org');

      // Verify production file hashes remain byte-for-byte identical
      const queueHashAfter = computeFileHash(queuePath);
      const dispatchHashAfter = computeFileHash(dispatchPath);
      assert.strictEqual(queueHashAfter, queueHashBefore, 'telegram_retry_queue.json must be byte-for-byte immutable');
      assert.strictEqual(dispatchHashAfter, dispatchHashBefore, 'telegram_dispatches.json must be byte-for-byte immutable');

      // Verify production storage singleton state remains 100% equal
      assert.strictEqual(storage.getTrades().length, prodTradesBefore, 'Production trades count must be untouched');
      assert.strictEqual(storage.getTradeOutcomes().length, prodOutcomesBefore, 'Production outcomes count must be untouched');
      assert.strictEqual(storage.getCurrentBalance(), prodBalanceBefore, 'Production balance must be untouched');
      assert.strictEqual(storage.getStartingBalance(), prodStartingBefore, 'Production starting balance must be untouched');

      recordPass('TEST 23: Complete Isolation Audit', 'Zero Telegram network leakage & 100% file immutability verified');
    }

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('\n========================================================================');
  console.log(`🎉 ALL PHASE 5B REGRESSION TESTS PASSED: ${passed}/${total} (100%)`);
  console.log('========================================================================');

  if (passed !== total) {
    process.exit(1);
  }
}

runPhase5BRegressionSuite().catch((err) => {
  console.error('Unhandled Phase 5B test suite error:', err);
  process.exit(1);
});
