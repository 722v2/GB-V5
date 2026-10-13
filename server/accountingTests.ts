import { PersistentStorage, TradeOutcomeRecord } from './storage.js';
import { sanitizeFirestoreData } from './storage.js';
import { TradeLedgerItem, TradeSignal, TradeOpportunity } from '../src/types.js';

interface TestResult {
  testNumber: number;
  name: string;
  passed: boolean;
  details: string;
}

function createTestOpenTrade(id: string, overrides: Partial<TradeLedgerItem> = {}, targetStorage: PersistentStorage): TradeLedgerItem {
  const trade: TradeLedgerItem = {
    id,
    tradeNumber: Date.now(),
    date: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 4300.0,
    sl: 4295.0,
    tp1: 4310.0,
    tp2: 4315.0,
    rr: '1:2',
    riskPercent: 15,
    riskAmount: 1.5,
    lotSize: 0.01,
    confidence: 80,
    setup: 'Test Setup',
    result: 'OPEN',
    isActive: true,
    pl: 0,
    balanceAfterTrade: targetStorage.getCurrentBalance(),
    ...overrides,
  };
  targetStorage.saveTrade(trade);
  return trade;
}

export function runAccountingTests(customStorage?: PersistentStorage): { allPassed: boolean; results: TestResult[] } {
  if (customStorage && customStorage.isProductionStorage) {
    throw new Error('HARD SAFETY GUARD TRIGGERED: Refusing to run accounting tests on production storage instance!');
  }
  const activeStorage = customStorage || PersistentStorage.createIsolatedTestInstance(100.0);
  if (activeStorage.isProductionStorage) {
    throw new Error('HARD SAFETY GUARD TRIGGERED: Refusing to run accounting tests on production storage instance!');
  }
  try {
    const results: TestResult[] = [];

    const initialStartingBalance = 100.0;
    activeStorage.setStartingBalance(initialStartingBalance);

    // --------------------------------------------------------------------------
    // TEST 1: WIN outcome with explicit realized P&L on existing trade updates balance
    // --------------------------------------------------------------------------
    try {
      const balBefore = activeStorage.getCurrentBalance();
      const tradeId = 'test-trade-1-win-explicit';
      createTestOpenTrade(tradeId, { direction: 'SELL NOW', entry: 4296.49, sl: 4300.49, tp1: 4278.29 }, activeStorage);

      const record: TradeOutcomeRecord = {
        signalId: tradeId,
        tradeId,
        direction: 'SELL NOW',
        orderType: 'MARKET',
        entry: 4296.49,
        stopLoss: 4300.49,
        tp1: 4278.29,
        tp2: 4276.25,
        outcome: 'WIN',
        realizedPnl: 17.0,
        exitPrice: 4279.49,
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const res = activeStorage.recordTradeOutcome(record);
      const balAfter = activeStorage.getCurrentBalance();
      const pnlMatches = res.trade?.realizedPnl === 17.0;
      const balanceDiff = Number((balAfter - balBefore).toFixed(2));
      const passed = res.success && pnlMatches && balanceDiff === 17.0;

      results.push({
        testNumber: 1,
        name: 'WIN outcome with explicit realized P&L (+17.00 USD) on existing trade',
        passed,
        details: `Balance before: $${balBefore.toFixed(2)}, after: $${balAfter.toFixed(2)} (diff: +$${balanceDiff.toFixed(2)}), recorded PnL: $${res.trade?.realizedPnl}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 1,
        name: 'WIN outcome with explicit realized P&L (+17.00 USD) on existing trade',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 2: WIN outcome with composite RR calculates price distance, not fallback 1.5R
    // --------------------------------------------------------------------------
    try {
      const balBefore = activeStorage.getCurrentBalance();
      const tradeId = 'test-trade-2-composite-rr';
      createTestOpenTrade(tradeId, {
        direction: 'SELL NOW',
        entry: 4296.49,
        sl: 4300.49,
        tp1: 4278.29,
        tp2: 4276.25,
        lotSize: 0.01,
      }, activeStorage);

      const mockSignal = {
        id: tradeId,
        symbol: 'XAU/USD',
        signal: 'SELL NOW',
        entry: 4296.49,
        stopLoss: 4300.49,
        tp1: 4278.29,
        tp2: 4276.25,
        tp1Points: 182,
        tp2Points: 202.4,
        slPoints: 40,
        rr: 'TP1: 1:4.55 (182.0 pts) | TP2: 1:5.06 (202.4 pts)',
        lotSize: 0.01,
        riskAmount: 4.0,
        timestamp: Date.now(),
      } as any;

      const record: TradeOutcomeRecord = {
        signalId: tradeId,
        tradeId,
        direction: 'SELL NOW',
        orderType: 'MARKET',
        entry: 4296.49,
        stopLoss: 4300.49,
        tp1: 4278.29,
        tp2: 4276.25,
        outcome: 'WIN',
        exitPrice: 4278.29, // Closed at TP1
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const res = activeStorage.recordTradeOutcome(record, mockSignal);
      const balAfter = activeStorage.getCurrentBalance();
      const pnl = res.trade?.realizedPnl ?? 0;
      const notBuggy15R = pnl > 10.0 && pnl !== 6.0 && pnl !== 6.07;
      const balanceDiff = Number((balAfter - balBefore).toFixed(2));
      const passed = res.success && notBuggy15R && balanceDiff === pnl;

      results.push({
        testNumber: 2,
        name: 'WIN outcome does NOT fall back to 1.5R on composite RR string',
        passed,
        details: `Calculated P&L: $${pnl.toFixed(2)} (expected ~$18.20 based on 182 pts * $0.10, NOT $6.00), balance diff: +$${balanceDiff.toFixed(2)}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 2,
        name: 'WIN outcome does NOT fall back to 1.5R on composite RR string',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 3: LOSS outcome records exact negative P&L and reduces balance
    // --------------------------------------------------------------------------
    try {
      const balBefore = activeStorage.getCurrentBalance();
      const tradeId = 'test-trade-3-loss-exact';
      createTestOpenTrade(tradeId, { direction: 'BUY NOW', entry: 4300.0, sl: 4296.0, tp1: 4310.0 }, activeStorage);

      const record: TradeOutcomeRecord = {
        signalId: tradeId,
        tradeId,
        direction: 'BUY NOW',
        orderType: 'MARKET',
        entry: 4300.0,
        stopLoss: 4296.0,
        tp1: 4310.0,
        tp2: 4315.0,
        outcome: 'LOSS',
        realizedPnl: -4.0,
        exitPrice: 4296.0,
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const res = activeStorage.recordTradeOutcome(record);
      const balAfter = activeStorage.getCurrentBalance();
      const balanceDiff = Number((balAfter - balBefore).toFixed(2));
      const passed = res.success && res.trade?.realizedPnl === -4.0 && balanceDiff === -4.0;

      results.push({
        testNumber: 3,
        name: 'LOSS outcome records exact negative P&L (-$4.00) and reduces balance',
        passed,
        details: `Balance before: $${balBefore.toFixed(2)}, after: $${balAfter.toFixed(2)} (diff: -$${Math.abs(balanceDiff).toFixed(2)}), recorded PnL: $${res.trade?.realizedPnl}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 3,
        name: 'LOSS outcome records exact negative P&L (-$4.00) and reduces balance',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 4: Directional sign enforcement (WIN cannot be negative, LOSS cannot be positive)
    // --------------------------------------------------------------------------
    try {
      const tradeIdWin = 'test-trade-4-win-sign-guard';
      createTestOpenTrade(tradeIdWin, { direction: 'BUY NOW' }, activeStorage);
      const recordWinWithNegative: TradeOutcomeRecord = {
        signalId: tradeIdWin,
        tradeId: tradeIdWin,
        direction: 'BUY NOW',
        orderType: 'MARKET',
        entry: 4300.0,
        stopLoss: 4296.0,
        tp1: 4310.0,
        tp2: 4315.0,
        outcome: 'WIN',
        realizedPnl: -12.5, // Erroneously passed as negative
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const resWin = activeStorage.recordTradeOutcome(recordWinWithNegative);
      const winFixed = (resWin.trade?.realizedPnl ?? 0) > 0;

      const tradeIdLoss = 'test-trade-4-loss-sign-guard';
      createTestOpenTrade(tradeIdLoss, { direction: 'BUY NOW' }, activeStorage);
      const recordLossWithPositive: TradeOutcomeRecord = {
        signalId: tradeIdLoss,
        tradeId: tradeIdLoss,
        direction: 'BUY NOW',
        orderType: 'MARKET',
        entry: 4300.0,
        stopLoss: 4296.0,
        tp1: 4310.0,
        tp2: 4315.0,
        outcome: 'LOSS',
        realizedPnl: 8.0, // Erroneously passed as positive
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const resLoss = activeStorage.recordTradeOutcome(recordLossWithPositive);
      const lossFixed = (resLoss.trade?.realizedPnl ?? 0) < 0;

      const passed = winFixed && lossFixed;
      results.push({
        testNumber: 4,
        name: 'Directional sign enforcement for WIN (+) and LOSS (-)',
        passed,
        details: `WIN with input -12.50 normalized to: +$${resWin.trade?.realizedPnl}, LOSS with input +8.00 normalized to: $${resLoss.trade?.realizedPnl}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 4,
        name: 'Directional sign enforcement for WIN (+) and LOSS (-)',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 5: Idempotency / duplicate callback protection (prevents double counting)
    // --------------------------------------------------------------------------
    try {
      const balBefore = activeStorage.getCurrentBalance();
      const tradeId = 'test-trade-5-duplicate-protection';
      createTestOpenTrade(tradeId, { direction: 'SELL NOW' }, activeStorage);

      const record: TradeOutcomeRecord = {
        signalId: tradeId,
        tradeId,
        direction: 'SELL NOW',
        orderType: 'MARKET',
        entry: 4300.0,
        stopLoss: 4305.0,
        tp1: 4290.0,
        tp2: 4285.0,
        outcome: 'WIN',
        realizedPnl: 10.0,
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      // First submission
      const res1 = activeStorage.recordTradeOutcome(record);
      const balAfterFirst = activeStorage.getCurrentBalance();

      // Second duplicate submission
      const res2 = activeStorage.recordTradeOutcome(record);
      const balAfterSecond = activeStorage.getCurrentBalance();

      const firstPassed = res1.success && balAfterFirst === balBefore + 10.0;
      const secondBlocked = res2.isDuplicate === true && balAfterSecond === balAfterFirst;
      const passed = firstPassed && secondBlocked;

      results.push({
        testNumber: 5,
        name: 'Idempotency and duplicate submission protection',
        passed,
        details: `First submission success: ${res1.success} (bal: $${balAfterFirst.toFixed(2)}), second submission isDuplicate: ${res2.isDuplicate} (bal unchanged: $${balAfterSecond.toFixed(2)})`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 5,
        name: 'Idempotency and duplicate submission protection',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 6: Gold contract calculation: 100 multiplier with 0.01 lot
    // --------------------------------------------------------------------------
    try {
      const entry = 4296.49;
      const tp1 = 4278.29; // Sell trade, 18.20 gold points
      const lotSize = 0.01;
      const expectedPnl = Number((Math.abs(entry - tp1) * 100 * lotSize).toFixed(2)); // 18.20 * 100 * 0.01 = 18.20

      const tradeId = 'test-trade-6-gold-formula';
      createTestOpenTrade(tradeId, { direction: 'SELL NOW', entry, sl: 4300.49, tp1, lotSize }, activeStorage);

      const record: TradeOutcomeRecord = {
        signalId: tradeId,
        tradeId,
        direction: 'SELL NOW',
        orderType: 'MARKET',
        entry,
        stopLoss: 4300.49,
        tp1,
        tp2: 4276.25,
        outcome: 'WIN',
        exitPrice: tp1,
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const res = activeStorage.recordTradeOutcome(record);
      const pnl = res.trade?.realizedPnl;
      const passed = res.success && pnl === expectedPnl && pnl === 18.2;

      results.push({
        testNumber: 6,
        name: 'Gold contract size calculation (|ΔPrice| * 100 * LotSize)',
        passed,
        details: `18.20 points * 100 oz * 0.01 lot = $${expectedPnl.toFixed(2)}, recorded: $${pnl}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 6,
        name: 'Gold contract size calculation (|ΔPrice| * 100 * LotSize)',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 7: Future MT5 reconciliation (reconcileMt5Trade) with brokerDealId
    // --------------------------------------------------------------------------
    try {
      const balBefore = activeStorage.getCurrentBalance();
      const tradeId = 'test-trade-7-mt5-reconciliation';
      const brokerDealId = 'MT5_DEAL_987654321';
      const brokerOrderId = 'MT5_ORDER_123456';
      createTestOpenTrade(tradeId, { direction: 'SELL NOW', entry: 4290.0, sl: 4300.0, tp1: 4275.0, lotSize: 0.02 }, activeStorage);

      const res = activeStorage.reconcileMt5Trade({
        signalOrTradeId: tradeId,
        brokerDealId,
        brokerOrderId,
        entryPrice: 4290.0,
        exitPrice: 4275.0,
        lotSize: 0.02,
        realizedPnl: 30.0,
        closedAt: Date.now(),
        closeReason: 'MT5_TP_HIT',
        direction: 'SELL NOW',
      });

      const balAfter = activeStorage.getCurrentBalance();
      const balanceDiff = Number((balAfter - balBefore).toFixed(2));
      const passed =
        res.success &&
        res.trade?.source === 'MT5' &&
        res.trade?.brokerDealId === brokerDealId &&
        res.trade?.brokerOrderId === brokerOrderId &&
        res.trade?.realizedPnl === 30.0 &&
        balanceDiff === 30.0;

      results.push({
        testNumber: 7,
        name: 'Future MT5 trade reconciliation (reconcileMt5Trade)',
        passed,
        details: `Source: ${res.trade?.source}, brokerDealId: ${res.trade?.brokerDealId}, realizedPnl: $${res.trade?.realizedPnl}, balance diff: +$${balanceDiff.toFixed(2)}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 7,
        name: 'Future MT5 trade reconciliation (reconcileMt5Trade)',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 8: Source tagging distinction: MANUAL vs SYSTEM vs MT5
    // --------------------------------------------------------------------------
    try {
      const tradeManual = 'test-trade-8-src-manual';
      createTestOpenTrade(tradeManual, {}, activeStorage);
      const resManual = activeStorage.recordTradeOutcome({
        signalId: tradeManual,
        tradeId: tradeManual,
        direction: 'BUY NOW',
        orderType: 'MARKET',
        entry: 4300,
        stopLoss: 4295,
        tp1: 4310,
        tp2: 4315,
        outcome: 'WIN',
        realizedPnl: 5.0,
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      });

      const tradeSystem = 'test-trade-8-src-system';
      createTestOpenTrade(tradeSystem, {}, activeStorage);
      const resSystem = activeStorage.recordTradeOutcome({
        signalId: tradeSystem,
        tradeId: tradeSystem,
        direction: 'BUY NOW',
        orderType: 'MARKET',
        entry: 4300,
        stopLoss: 4295,
        tp1: 4310,
        tp2: 4315,
        outcome: 'WIN',
        realizedPnl: 5.0,
        source: 'SYSTEM',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      });

      const passed = resManual.trade?.source === 'MANUAL' && resSystem.trade?.source === 'SYSTEM';

      results.push({
        testNumber: 8,
        name: 'Multi-source attribution tags (MANUAL, SYSTEM, MT5)',
        passed,
        details: `Manual source: ${resManual.trade?.source}, System source: ${resSystem.trade?.source}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 8,
        name: 'Multi-source attribution tags (MANUAL, SYSTEM, MT5)',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 9: Firestore data sanitization (removes undefined fields)
    // --------------------------------------------------------------------------
    try {
      const dirtyData = {
        id: 'trade-clean-test',
        realizedPnl: 15.5,
        undefinedField: undefined,
        nullField: null,
        nested: {
          valid: 'ok',
          badUndefined: undefined,
        },
      };

      const cleaned: any = sanitizeFirestoreData(dirtyData);
      const hasNoUndefined = !('undefinedField' in cleaned) && !('badUndefined' in cleaned.nested);
      const keepsNullAndValues = cleaned.nullField === null && cleaned.realizedPnl === 15.5;
      const passed = hasNoUndefined && keepsNullAndValues;

      results.push({
        testNumber: 9,
        name: 'Firestore data sanitization against undefined fields',
        passed,
        details: `Removed undefinedField: ${!('undefinedField' in cleaned)}, nested undefined: ${!('badUndefined' in cleaned.nested)}, preserved null & values: ${keepsNullAndValues}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 9,
        name: 'Firestore data sanitization against undefined fields',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 10: Non-existent trade ID in recordTradeOutcome returns TRADE_NOT_FOUND (No phantom trade created)
    // --------------------------------------------------------------------------
    try {
      const nonExistentTradeId = 'phantom-trade-' + Date.now();
      const tradesCountBefore = activeStorage.getTrades().length;
      const balBefore = activeStorage.getCurrentBalance();

      const res = activeStorage.recordTradeOutcome({
        signalId: nonExistentTradeId,
        tradeId: nonExistentTradeId,
        direction: 'BUY NOW',
        orderType: 'MARKET',
        entry: 4300,
        stopLoss: 4295,
        tp1: 4310,
        tp2: 4315,
        outcome: 'WIN',
        realizedPnl: 50.0,
        source: 'MANUAL',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      });

      const tradesCountAfter = activeStorage.getTrades().length;
      const balAfter = activeStorage.getCurrentBalance();

      const passed =
        res.success === false &&
        res.message === 'TRADE_NOT_FOUND' &&
        tradesCountAfter === tradesCountBefore &&
        balAfter === balBefore;

      results.push({
        testNumber: 10,
        name: 'Non-existent trade ID in recordTradeOutcome returns TRADE_NOT_FOUND without creating phantom trade',
        passed,
        details: `Success: ${res.success}, message: ${res.message}, tradesCount delta: ${tradesCountAfter - tradesCountBefore}, balance delta: ${balAfter - balBefore}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 10,
        name: 'Non-existent trade ID in recordTradeOutcome returns TRADE_NOT_FOUND without creating phantom trade',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 11: markSignalOrOpportunityNotEntered() updates state to NOT_ENTERED without creating a trade
    // --------------------------------------------------------------------------
    try {
      const signalId = 'test-sig-not-entered-' + Date.now();
      const mockSignal: TradeSignal = {
        id: signalId,
        asset: 'XAU/USD',
        signal: 'BUY NOW',
        currentPrice: 4310.0,
        timeframe: '5M',
        entry: 4310.0,
        stopLoss: 4305.0,
        slPoints: 50,
        tp1: 4320.0,
        tp1Points: 100,
        tp2: 4325.0,
        tp2Points: 150,
        confidence: 85,
        timestamp: Date.now(),
        setup: 'Test setup',
        mainReasons: ['Test reason 1', 'Test reason 2'],
        invalidation: 'Break below 4305.0',
        rr: '1:2',
        rrRatio: 2.0,
        potentialProfit: 3.0,
        potentialLoss: 1.5,
        riskPercent: 15,
        riskAmount: 1.5,
        recommendedLotSize: 0.01,
        lifecycleState: 'READY',
      };
      activeStorage.saveSignal(mockSignal);

      const tradesBefore = activeStorage.getTrades().length;
      const balBefore = activeStorage.getCurrentBalance();

      const res = activeStorage.markSignalOrOpportunityNotEntered(signalId);
      const tradesAfter = activeStorage.getTrades().length;
      const balAfter = activeStorage.getCurrentBalance();

      const updatedSig = activeStorage.getSignal(signalId);
      const passed =
        res.success === true &&
        updatedSig?.lifecycleState === 'NOT_ENTERED' &&
        tradesAfter === tradesBefore &&
        balAfter === balBefore;

      results.push({
        testNumber: 11,
        name: 'markSignalOrOpportunityNotEntered updates signal lifecycleState to NOT_ENTERED without creating trade',
        passed,
        details: `Signal state: ${updatedSig?.lifecycleState}, trade ledger unchanged: ${tradesAfter === tradesBefore}, balance unchanged: ${balAfter === balBefore}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 11,
        name: 'markSignalOrOpportunityNotEntered updates signal lifecycleState to NOT_ENTERED without creating trade',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 12: Duplicate NOT_ENTERED check and outcome retrieval
    // --------------------------------------------------------------------------
    try {
      const sigId = 'test-sig-not-entered-dup-' + Date.now();
      activeStorage.markSignalOrOpportunityNotEntered(sigId);

      const outcome = activeStorage.getTradeOutcome(sigId);
      const isNotEntered = (outcome?.outcome as any) === 'NOT_ENTERED';
      const zeroPnl = outcome?.realizedPnl === 0 && outcome?.pl === 0;
      const passed = isNotEntered && zeroPnl;

      results.push({
        testNumber: 12,
        name: 'NOT_ENTERED outcome is properly recorded with 0 PnL and queryable via getTradeOutcome',
        passed,
        details: `Recorded outcome: ${outcome?.outcome}, P&L: $${outcome?.realizedPnl}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 12,
        name: 'NOT_ENTERED outcome is properly recorded with 0 PnL and queryable via getTradeOutcome',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 13: clearAllTrades clears memory and resets balance without resurrecting trades
    // --------------------------------------------------------------------------
    try {
      createTestOpenTrade('clear-trade-1', {}, activeStorage);
      createTestOpenTrade('clear-trade-2', {}, activeStorage);

      const tradesBeforeClear = activeStorage.getTrades().length;
      activeStorage.clearAllTrades();
      const tradesAfterClear = activeStorage.getTrades().length;

      const passed = tradesBeforeClear > 0 && tradesAfterClear === 0;

      results.push({
        testNumber: 13,
        name: 'clearAllTrades flushes ledger to exactly 0 trades',
        passed,
        details: `Trades before: ${tradesBeforeClear}, after: ${tradesAfterClear}`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 13,
        name: 'clearAllTrades flushes ledger to exactly 0 trades',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    // --------------------------------------------------------------------------
    // TEST 14: NOT_ENTERED signals do NOT count towards daily trade stats or ledger
    // --------------------------------------------------------------------------
    try {
      const initialStats = activeStorage.getTodayStats();
      const sigId = 'test-not-entered-daily-' + Date.now();
      
      const res = activeStorage.markSignalOrOpportunityNotEntered(sigId);
      const afterStats = activeStorage.getTodayStats();
      const outcome = activeStorage.getTradeOutcome(sigId);

      const passed =
        res.success === true &&
        afterStats.tradesCount === initialStats.tradesCount &&
        afterStats.totalRiskPercentUsed === initialStats.totalRiskPercentUsed &&
        outcome?.outcome === 'NOT_ENTERED';

      results.push({
        testNumber: 14,
        name: 'NOT_ENTERED signals do not increment daily tradesCount or risk percent used',
        passed,
        details: `Initial daily trades: ${initialStats.tradesCount}, After: ${afterStats.tradesCount}, Risk used: ${afterStats.totalRiskPercentUsed}%`,
      });
    } catch (err: any) {
      results.push({
        testNumber: 14,
        name: 'NOT_ENTERED signals do not increment daily tradesCount or risk percent used',
        passed: false,
        details: `Exception: ${err?.message}`,
      });
    }

    const allPassed = results.every((r) => r.passed);
    return { allPassed, results };
  } catch (e: any) {
    return { allPassed: false, results: [] };
  }
}
