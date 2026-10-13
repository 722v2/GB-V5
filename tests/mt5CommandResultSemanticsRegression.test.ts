import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MT5BridgeService } from '../server/mt5Bridge.js';
import { storage, PersistentStorage } from '../server/storage.js';
import { TradeLedgerItem } from '../src/types.js';

function computeFileHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function runMT5CommandResultSemanticsTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 5A MT5 COMMAND-RESULT SEMANTICS REGRESSION SUITE');
  console.log('========================================================================\n');

  let totalTests = 0;
  let passedCount = 0;

  // Snapshot sensitive production files before test suite
  const candleFilePath = 'server/data/mt5_candles.json';
  const telegramRetryPath = 'data/telegram_retry_queue.json';
  const telegramDispatchPath = 'data/telegram_dispatches.json';

  const candleHashBefore = computeFileHash(candleFilePath);
  const telegramRetryHashBefore = computeFileHash(telegramRetryPath);
  const telegramDispatchHashBefore = computeFileHash(telegramDispatchPath);

  // Snapshot production storage singleton before test suite
  await storage.waitUntilReady();
  const prodTradesBefore = storage.getTrades().length;
  const prodOutcomesBefore = storage.getTradeOutcomes().length;
  const prodBalanceBefore = storage.getCurrentBalance();

  // Install Telegram Network Interceptor with counter
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
    // -------------------------------------------------------------------------
    // TEST 1: BUY command creates managed trade in isolated storage when valid
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 1: Valid BUY command creates managed trade in isolated storage');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      // Seed a pending BUY command in bridge
      const cmdId = 'cmd_buy_valid_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.02,
        price: 2650.0,
        sl: 2640.0,
        tp: 2670.0,
        magic: 240726,
        comment: 'Test BUY Order',
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 55001,
        orderTicket: 55001,
        executionPrice: 2650.5,
        retcode: 10009,
        retcodeDescription: 'Done',
      }, testStorage);

      assert.strictEqual(res.success, true, 'Result handling must succeed');
      assert.strictEqual(res.message, 'FILLED', 'Message must be FILLED');

      const cmd = bridge.getCommand(cmdId);
      assert.strictEqual(cmd?.status, 'FILLED', 'Command status must be FILLED');
      assert.strictEqual(cmd?.positionTicket, 55001, 'Position ticket must match');
      assert.strictEqual(cmd?.executionPrice, 2650.5, 'Execution price must match');

      const trade = testStorage.getTrade('mt5_55001');
      assert(!!trade, 'Trade mt5_55001 must exist in isolated storage');
      assert.strictEqual(trade?.direction, 'BUY NOW', 'Trade direction must be BUY NOW');
      assert.strictEqual(trade?.entry, 2650.5, 'Trade entry must be 2650.5');
      assert.strictEqual(trade?.lotSize, 0.02, 'Trade lotSize must be 0.02');
      assert.strictEqual(trade?.sl, 2640.0, 'Trade SL must be 2640.0');
      assert.strictEqual(trade?.tp1, 2670.0, 'Trade TP1 must be 2670.0');
      assert.strictEqual(trade?.result, 'OPEN', 'Trade result must be OPEN');
      assert.strictEqual(trade?.isActive, true, 'Trade must be active');

      passedCount++;
      console.log('✅ [PASS] TEST 1: Managed open trade created accurately.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 2: SELL command creates managed trade in isolated storage
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 2: Valid SELL command creates managed trade in isolated storage');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_sell_valid_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'SELL',
        symbol: 'XAUUSD',
        volume: 0.05,
        price: 2655.0,
        sl: 2665.0,
        tp: 2635.0,
        magic: 240726,
        comment: 'Test SELL Order',
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 55002,
        orderTicket: 55002,
        executionPrice: 2654.8,
        retcode: 10009,
      }, testStorage);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.message, 'FILLED');

      const trade = testStorage.getTrade('mt5_55002');
      assert(!!trade, 'Trade mt5_55002 must exist in isolated storage');
      assert.strictEqual(trade?.direction, 'SELL NOW', 'Trade direction must be SELL NOW');
      assert.strictEqual(trade?.entry, 2654.8, 'Trade entry must match execution price');
      assert.strictEqual(trade?.lotSize, 0.05, 'Lot size must match command volume');

      passedCount++;
      console.log('✅ [PASS] TEST 2: Managed SELL trade created accurately.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 3: BUY command with missing/zero ticket fails closed safely
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 3: BUY command with missing/zero ticket fails closed without creating trade');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_buy_bad_ticket';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 2650.0,
        sl: 2640.0,
        tp: 2670.0,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 0, // Invalid ticket
        executionPrice: 2650.0,
      }, testStorage);

      assert.strictEqual(res.success, false, 'Result handling must fail closed');
      assert.strictEqual(res.message, 'MISSING_OR_INVALID_TICKET');

      const cmd = bridge.getCommand(cmdId);
      assert.strictEqual(cmd?.status, 'FAILED', 'Command status must transition to FAILED');
      assert.strictEqual(testStorage.getTrades().length, 0, 'Zero trades must be created in storage');

      passedCount++;
      console.log('✅ [PASS] TEST 3: Fails closed on invalid ticket without creating trade.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 4: BUY command with invalid execution price fails closed safely
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 4: BUY command with invalid execution price fails closed');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_buy_bad_price';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 0, // Invalid fallback
        sl: 2640.0,
        tp: 2670.0,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 55003,
        executionPrice: -10, // Invalid negative price
      }, testStorage);

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.message, 'MISSING_OR_INVALID_PRICE');
      assert.strictEqual(testStorage.getTrades().length, 0, 'Zero trades created');

      passedCount++;
      console.log('✅ [PASS] TEST 4: Fails closed on invalid execution price.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 5: MODIFY command updates existing position's SL/TP in place
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 5: MODIFY command updates existing position SL/TP without creating new trade');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      // Create an existing open trade in isolated storage
      const initialTrade: TradeLedgerItem = {
        id: 'mt5_60001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        slPoints: 100,
        tp1: 2670.0,
        tp1Points: 200,
        rr: '1:2.0',
        riskPercent: 1.5,
        riskAmount: 1.5,
        lotSize: 0.01,
        confidence: 85,
        setup: 'Test Setup',
        result: 'OPEN',
        isActive: true,
        notes: 'Ticket #60001',
      };
      testStorage.saveTrade(initialTrade);
      assert.strictEqual(testStorage.getTrades().length, 1, 'Initial trade count must be 1');

      // Create a MODIFY command targeting ticket 60001 with new SL 2645 and TP 2675
      const cmdId = 'cmd_mod_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'MODIFY',
        symbol: 'XAUUSD',
        volume: 0,
        sl: 2645.0,
        tp: 2675.0,
        ticket: 60001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 60001,
        retcode: 10009,
      }, testStorage);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.message, 'FILLED');

      // Assert trade ledger length is still exactly 1 (NO new trade created!)
      const allTrades = testStorage.getTrades();
      assert.strictEqual(allTrades.length, 1, 'Trade count must remain exactly 1 after MODIFY');

      const updatedTrade = testStorage.getTrade('mt5_60001');
      assert.strictEqual(updatedTrade?.sl, 2645.0, 'SL must be updated to 2645.0');
      assert.strictEqual(updatedTrade?.slPoints, 50, 'slPoints must be updated to 50');
      assert.strictEqual(updatedTrade?.tp1, 2675.0, 'TP1 must be updated to 2675.0');
      assert.strictEqual(updatedTrade?.tp1Points, 250, 'tp1Points must be updated to 250');
      assert.strictEqual(updatedTrade?.result, 'OPEN', 'Trade must remain OPEN');
      assert(updatedTrade?.notes?.includes('Modified SL: $2645'), 'Notes must record modification');

      passedCount++;
      console.log('✅ [PASS] TEST 5: MODIFY updated SL/TP in place without adding new trade.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 6: MODIFY command for non-existent trade never creates phantom trade
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 6: MODIFY command for non-existent trade creates zero phantom trades');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_mod_nonexistent';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'MODIFY',
        symbol: 'XAUUSD',
        volume: 0,
        sl: 2645.0,
        tp: 2675.0,
        ticket: 999999, // Non-existent
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 999999,
        retcode: 10009,
      }, testStorage);

      assert.strictEqual(res.success, true);
      assert.strictEqual(testStorage.getTrades().length, 0, 'Must create zero phantom trades');

      passedCount++;
      console.log('✅ [PASS] TEST 6: Zero phantom trade created on missing position modify.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 7: CLOSE command settles existing open position without opening trade
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 7: CLOSE command settles existing position without creating opening trade');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      // Seed open BUY trade: entry 2650.0, lot 0.02
      const initialTrade: TradeLedgerItem = {
        id: 'mt5_70001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2670.0,
        lotSize: 0.02,
        result: 'OPEN',
        isActive: true,
        notes: 'Ticket #70001',
      };
      testStorage.saveTrade(initialTrade);

      // Close at 2660.0 (+10 points * 0.02 lot * 100 oz = +$20.00 PnL)
      const cmdId = 'cmd_cls_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CLOSE',
        symbol: 'XAUUSD',
        volume: 0.02,
        ticket: 70001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 70001,
        executionPrice: 2660.0,
        retcode: 10009,
      }, testStorage);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.message, 'FILLED');

      // Assert trade ledger length is still exactly 1 (NO opening trade added!)
      const trades = testStorage.getTrades();
      assert.strictEqual(trades.length, 1, 'Trade count must remain 1');

      const settledTrade = testStorage.getTrade('mt5_70001');
      assert.strictEqual(settledTrade?.result, 'WIN', 'Trade result must be WIN');
      assert.strictEqual(settledTrade?.isActive, false, 'Trade isActive must be false');
      assert.strictEqual(settledTrade?.exitPrice, 2660.0, 'Exit price must be 2660.0');
      assert.strictEqual(settledTrade?.pl, 20.0, 'Realized PnL must be +$20.00');

      passedCount++;
      console.log('✅ [PASS] TEST 7: CLOSE settled open position with +$20.00 PnL and 0 phantom trades.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 8: CLOSE command with missing exit price fails closed safely
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 8: CLOSE command with missing exit price fails closed');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_cls_bad_price';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CLOSE',
        symbol: 'XAUUSD',
        volume: 0.01,
        ticket: 70002,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 70002,
        executionPrice: 0, // Missing/zero exit price
      }, testStorage);

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.message, 'MISSING_OR_INVALID_PRICE');

      const cmd = bridge.getCommand(cmdId);
      assert.strictEqual(cmd?.status, 'FAILED');

      passedCount++;
      console.log('✅ [PASS] TEST 8: Fails closed on invalid exit price without mutating trades.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 9: REJECTED / FAILED commands transition status and create 0 trades
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 9: REJECTED / FAILED commands never create phantom trades');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_rejected_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 2650.0,
        sl: 2640.0,
        tp: 2670.0,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: false,
        status: 'REJECTED',
        retcode: 10019,
        retcodeDescription: 'No money',
        message: 'Insufficient margin on broker',
      }, testStorage);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.message, 'COMMAND_REJECTED');

      const cmd = bridge.getCommand(cmdId);
      assert.strictEqual(cmd?.status, 'REJECTED');
      assert.strictEqual(cmd?.failureReason, 'Insufficient margin on broker');
      assert.strictEqual(testStorage.getTrades().length, 0, 'Zero trades must be created in ledger');

      passedCount++;
      console.log('✅ [PASS] TEST 9: REJECTED command transitions cleanly without phantom trades.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 10: Idempotency of duplicate FILLED result submissions
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 10: Duplicate FILLED result submissions are idempotent');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_idem_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 2650.0,
        sl: 2640.0,
        tp: 2670.0,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      // First submission
      const res1 = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 88001,
        executionPrice: 2650.0,
      }, testStorage);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.message, 'FILLED');
      assert.strictEqual(testStorage.getTrades().length, 1);

      // Second identical submission (e.g. network retry from Windows bridge)
      const res2 = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 88001,
        executionPrice: 2650.0,
      }, testStorage);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.message, 'ALREADY_FILLED');

      // Assert trade was not duplicated
      assert.strictEqual(testStorage.getTrades().length, 1, 'Trades count must remain exactly 1');

      passedCount++;
      console.log('✅ [PASS] TEST 10: Idempotency confirmed: returns ALREADY_FILLED and 0 duplicate trades.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 11: Idempotency of duplicate REJECTED result submissions
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 11: Duplicate REJECTED result submissions are idempotent');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_idem_rej';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 2650.0,
        sl: 2640.0,
        tp: 2670.0,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res1 = bridge.handleCommandResult(cmdId, {
        success: false,
        status: 'REJECTED',
        message: 'Invalid stops',
      }, testStorage);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.message, 'COMMAND_REJECTED');

      const res2 = bridge.handleCommandResult(cmdId, {
        success: false,
        status: 'REJECTED',
        message: 'Invalid stops',
      }, testStorage);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.message, 'ALREADY_FINALIZED');

      passedCount++;
      console.log('✅ [PASS] TEST 11: Idempotent duplicate rejection verified.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 12: Unknown commandId fails closed safely
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 12: Unknown commandId fails closed safely');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const res = bridge.handleCommandResult('cmd_does_not_exist', {
        success: true,
        status: 'FILLED',
        positionTicket: 99999,
        executionPrice: 2650.0,
      }, testStorage);

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.message, 'UNKNOWN_COMMAND');
      assert.strictEqual(testStorage.getTrades().length, 0);

      passedCount++;
      console.log('✅ [PASS] TEST 12: Unknown command rejected safely.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 13: Verify production storage singleton was completely untouched
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 13: Verify production storage singleton was completely untouched');
    {
      const prodTradesAfter = storage.getTrades().length;
      const prodOutcomesAfter = storage.getTradeOutcomes().length;
      const prodBalanceAfter = storage.getCurrentBalance();

      assert.strictEqual(prodTradesAfter, prodTradesBefore, 'Production trades count must be identical');
      assert.strictEqual(prodOutcomesAfter, prodOutcomesBefore, 'Production outcomes count must be identical');
      assert.strictEqual(prodBalanceAfter, prodBalanceBefore, 'Production balance must be identical');

      passedCount++;
      console.log('✅ [PASS] TEST 13: Production storage singleton 100% untouched.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 14: Durable command persistence and service restart recovery
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 14: Durable command persistence and restart recovery');
    {
      const tempCmdPath = path.join(process.cwd(), 'data', 'test_mt5_commands_temp.json');
      if (fs.existsSync(tempCmdPath)) fs.unlinkSync(tempCmdPath);

      try {
        const bridge1 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: tempCmdPath });
        const testStorage1 = PersistentStorage.createIsolatedTestInstance(100.0);

        const cmdId = 'cmd_restart_test_1';
        (bridge1 as any).commands.set(cmdId, {
          commandId: cmdId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          action: 'BUY',
          symbol: 'XAUUSD',
          volume: 0.01,
          price: 2650.0,
          sl: 2640.0,
          tp: 2670.0,
          status: 'PENDING',
          retryCount: 0,
          maxRetries: 2,
        });

        // Poll to transition status from PENDING to DISPATCHED
        const polled = bridge1.pollPendingCommands();
        assert.strictEqual(polled.length, 1);
        assert.strictEqual(polled[0].status, 'DISPATCHED');

        // Simulate service restart by creating fresh bridge2 using same temp commands path
        const bridge2 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: tempCmdPath });

        // Recovered in-flight DISPATCHED command must transition to UNRESOLVED on restart
        const recoveredCmd = bridge2.getCommand(cmdId);
        assert.strictEqual(recoveredCmd?.status, 'UNRESOLVED', 'In-flight command must recover to UNRESOLVED');
        assert(recoveredCmd?.failureReason?.includes('restarted'), 'Failure reason must document restart');

        // Recovered command must NEVER be automatically re-submitted on poll
        const repolled = bridge2.pollPendingCommands();
        assert.strictEqual(repolled.length, 0, 'Recovered UNRESOLVED command must not be re-polled');

        passedCount++;
        console.log('✅ [PASS] TEST 14: Durable restart recovery to UNRESOLVED verified.\n');
      } finally {
        if (fs.existsSync(tempCmdPath)) fs.unlinkSync(tempCmdPath);
      }
    }

    // -------------------------------------------------------------------------
    // TEST 15: Late broker result resolves recovered UNRESOLVED command
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 15: Late broker result resolves recovered UNRESOLVED command');
    {
      const tempCmdPath = path.join(process.cwd(), 'data', 'test_mt5_commands_temp2.json');
      if (fs.existsSync(tempCmdPath)) fs.unlinkSync(tempCmdPath);

      try {
        const bridge1 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: tempCmdPath });
        const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

        const cmdId = 'cmd_unresolved_resolve_1';
        (bridge1 as any).commands.set(cmdId, {
          commandId: cmdId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          action: 'BUY',
          symbol: 'XAUUSD',
          volume: 0.01,
          price: 2650.0,
          sl: 2640.0,
          tp: 2670.0,
          status: 'PENDING',
          retryCount: 0,
          maxRetries: 2,
        });

        bridge1.pollPendingCommands(); // Transitions to DISPATCHED
        const bridge2 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: tempCmdPath }); // Recovers to UNRESOLVED

        // Send late broker result
        const res = bridge2.handleCommandResult(cmdId, {
          success: true,
          status: 'FILLED',
          positionTicket: 91001,
          executionPrice: 2650.0,
        }, testStorage);

        assert.strictEqual(res.success, true);
        assert.strictEqual(res.message, 'FILLED');

        const cmd = bridge2.getCommand(cmdId);
        assert.strictEqual(cmd?.status, 'FILLED', 'Command must resolve to FILLED');

        const trade = testStorage.getTrade('mt5_91001');
        assert(!!trade, 'Trade mt5_91001 must be created in ledger');

        passedCount++;
        console.log('✅ [PASS] TEST 15: Late broker result resolved UNRESOLVED command cleanly.\n');
      } finally {
        if (fs.existsSync(tempCmdPath)) fs.unlinkSync(tempCmdPath);
      }
    }

    // -------------------------------------------------------------------------
    // TEST 16: Reconciliation Order 1 — CLOSE result first, Deals report second (Delta P&L)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 16: Reconciliation Order 1 — CLOSE result first, Deals report second');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      // 1. Create open BUY trade: entry 2650.0, lot 0.02
      const initialTrade: TradeLedgerItem = {
        id: 'mt5_92001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2670.0,
        lotSize: 0.02,
        result: 'OPEN',
        isActive: true,
        brokerPositionTicket: 92001,
        notes: 'Ticket #92001',
      };
      testStorage.saveTrade(initialTrade);

      // 2. CLOSE command result arrives first with exitPrice 2660.0 (+10 pts * 0.02 * 100 = +$20.00 interim PnL)
      const cmdId = 'cmd_cls_order1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CLOSE',
        symbol: 'XAUUSD',
        volume: 0.02,
        ticket: 92001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const closeRes = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 92001,
        executionPrice: 2660.0,
      }, testStorage);

      assert.strictEqual(closeRes.success, true);
      const interimTrade = testStorage.getTrade('mt5_92001');
      assert.strictEqual(interimTrade?.result, 'WIN');
      assert.strictEqual(interimTrade?.pl, 20.0);
      assert.strictEqual(testStorage.getCurrentBalance(), 120.0, 'Balance after interim close must be $120.00');

      // 3. Authoritative Deals report arrives second with profit $19.00, commission -$0.50, swap -$0.10 (net = $18.40)
      const deal1 = {
        ticket: 920011,
        order: 820011,
        positionId: 92001,
        time: Math.floor(Date.now() / 1000),
        type: 1,
        entry: 1,
        magic: 240726,
        volume: 0.02,
        price: 2659.50,
        profit: 19.00,
        commission: -0.50,
        swap: -0.10,
        symbol: 'XAUUSD',
        comment: 'Close Deal',
      };

      const dealsRes = bridge.handleDealsReport([deal1], testStorage);
      assert.strictEqual(dealsRes.success, true);
      assert.strictEqual(dealsRes.processedCount, 1);

      const finalTrade = testStorage.getTrade('mt5_92001');
      assert.strictEqual(finalTrade?.result, 'WIN');
      assert.strictEqual(finalTrade?.pl, 18.40, 'Final PnL must match authoritative broker net PnL ($18.40)');
      assert.strictEqual(finalTrade?.isAuthoritative, true, 'Trade must be marked isAuthoritative');
      assert.strictEqual(testStorage.getCurrentBalance(), 118.40, 'Balance must be adjusted cleanly by delta (-$1.60) to $118.40!');

      passedCount++;
      console.log('✅ [PASS] TEST 16: CLOSE first then Deals report second reconciled with exact delta accounting ($118.40).\n');
    }

    // -------------------------------------------------------------------------
    // TEST 17: Reconciliation Order 2 — Deals report first, CLOSE result second
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 17: Reconciliation Order 2 — Deals report first, CLOSE result second');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const initialTrade: TradeLedgerItem = {
        id: 'mt5_93001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2670.0,
        lotSize: 0.02,
        result: 'OPEN',
        isActive: true,
        brokerPositionTicket: 93001,
        notes: 'Ticket #93001',
      };
      testStorage.saveTrade(initialTrade);

      // 1. Authoritative Deals report arrives first (net PnL = $18.40)
      const deal1 = {
        ticket: 930011,
        order: 830011,
        positionId: 93001,
        time: Math.floor(Date.now() / 1000),
        type: 1,
        entry: 1,
        magic: 240726,
        volume: 0.02,
        price: 2659.50,
        profit: 19.00,
        commission: -0.50,
        swap: -0.10,
        symbol: 'XAUUSD',
        comment: 'Close Deal',
      };

      const dealsRes = bridge.handleDealsReport([deal1], testStorage);
      assert.strictEqual(dealsRes.success, true);
      assert.strictEqual(testStorage.getCurrentBalance(), 118.40);

      // 2. Late CLOSE result arrives second with interim estimate +$20.00
      const cmdId = 'cmd_cls_order2';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CLOSE',
        symbol: 'XAUUSD',
        volume: 0.02,
        ticket: 93001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const closeRes = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 93001,
        executionPrice: 2660.0,
      }, testStorage);

      assert.strictEqual(closeRes.success, true);

      // Assert authoritative PnL and balance were preserved without double counting!
      const finalTrade = testStorage.getTrade('mt5_93001');
      assert.strictEqual(finalTrade?.pl, 18.40, 'Authoritative PnL must be preserved');
      assert.strictEqual(testStorage.getCurrentBalance(), 118.40, 'Balance must remain $118.40 without double counting');

      passedCount++;
      console.log('✅ [PASS] TEST 17: Deals report first then CLOSE result second preserved authoritative accounting.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 18: Duplicate Deals reports and duplicate CLOSE results are idempotent
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 18: Duplicate Deals reports and duplicate CLOSE results are idempotent');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      // A. Test duplicate Deals report on same bridge/storage instance
      const initialTrade: TradeLedgerItem = {
        id: 'mt5_93001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2670.0,
        lotSize: 0.02,
        result: 'OPEN',
        isActive: true,
        brokerPositionTicket: 93001,
        notes: 'Ticket #93001',
      };
      testStorage.saveTrade(initialTrade);

      const deal1 = {
        ticket: 930011,
        order: 830011,
        positionId: 93001,
        time: Math.floor(Date.now() / 1000),
        type: 1,
        entry: 1,
        magic: 240726,
        volume: 0.02,
        price: 2659.50,
        profit: 19.00,
        commission: -0.50,
        swap: -0.10,
        symbol: 'XAUUSD',
      };

      const firstDealsRes = bridge.handleDealsReport([deal1], testStorage);
      assert.strictEqual(firstDealsRes.processedCount, 1, 'First deals report must process 1 deal');
      assert.strictEqual(testStorage.getCurrentBalance(), 118.40, 'Balance after first deal must be $118.40');

      const dupeDealsRes = bridge.handleDealsReport([deal1], testStorage);
      assert.strictEqual(dupeDealsRes.processedCount, 0, 'Duplicate deal must not be re-processed');
      assert.strictEqual(dupeDealsRes.duplicateCount, 1, 'Duplicate deal must be counted in duplicateCount');
      assert.strictEqual(testStorage.getCurrentBalance(), 118.40, 'Balance must remain unchanged on duplicate deal');

      // B. Test duplicate CLOSE command results
      const cmdId = 'cmd_cls_dupe_test';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CLOSE',
        symbol: 'XAUUSD',
        volume: 0.02,
        ticket: 93001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const firstCloseRes = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 93001,
        executionPrice: 2660.0,
      }, testStorage);
      assert.strictEqual(firstCloseRes.success, true);

      const dupeCloseRes = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'FILLED',
        positionTicket: 93001,
        executionPrice: 2660.0,
      }, testStorage);
      assert.strictEqual(dupeCloseRes.message, 'ALREADY_FILLED', 'Duplicate CLOSE command must return ALREADY_FILLED');
      assert.strictEqual(testStorage.getCurrentBalance(), 118.40, 'Balance must remain unchanged on duplicate CLOSE');

      passedCount++;
      console.log('✅ [PASS] TEST 18: Idempotency of duplicate deals and duplicate CLOSE results confirmed.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 19: Multiple partial-close deals for one position
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 19: Multiple partial-close deals for one position');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const initialTrade: TradeLedgerItem = {
        id: 'mt5_94001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2670.0,
        lotSize: 0.05,
        result: 'OPEN',
        isActive: true,
        brokerPositionTicket: 94001,
        notes: 'Ticket #94001',
      };
      testStorage.saveTrade(initialTrade);

      // Deal 1: Closes 0.02 lot @ 2655.0 (+5 pts * 0.02 * 100 = +$10.00 net)
      const deal1 = {
        ticket: 940011,
        order: 840011,
        positionId: 94001,
        time: Math.floor(Date.now() / 1000),
        type: 1,
        entry: 1,
        magic: 240726,
        volume: 0.02,
        price: 2655.0,
        profit: 10.00,
        symbol: 'XAUUSD',
      };
      bridge.handleDealsReport([deal1], testStorage);
      assert.strictEqual(testStorage.getCurrentBalance(), 110.0);

      // Deal 2: Closes remaining 0.03 lot @ 2660.0 (+10 pts * 0.03 * 100 = +$30.00 net)
      const deal2 = {
        ticket: 940012,
        order: 840012,
        positionId: 94001,
        time: Math.floor(Date.now() / 1000),
        type: 1,
        entry: 1,
        magic: 240726,
        volume: 0.03,
        price: 2660.0,
        profit: 30.00,
        symbol: 'XAUUSD',
      };
      bridge.handleDealsReport([deal2], testStorage);

      // Cumulative balance must be $100 + $10 + $30 = $140.00!
      assert.strictEqual(testStorage.getCurrentBalance(), 140.0, 'Balance after both partial deals must be $140.00');

      passedCount++;
      console.log('✅ [PASS] TEST 19: Multiple partial-close deals reconciled accurately ($140.00).\n');
    }

    // -------------------------------------------------------------------------
    // TEST 20: DISPATCHED command timeout transitions to UNRESOLVED without auto-retry
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 20: DISPATCHED command timeout transitions to UNRESOLVED');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });

      const cmdId = 'cmd_to_test_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now() - 70000,
        updatedAt: Date.now() - 70000, // 70s ago (> 60s timeout)
        action: 'BUY',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 2650.0,
        sl: 2640.0,
        tp: 2670.0,
        status: 'DISPATCHED',
        retryCount: 0,
        maxRetries: 2,
      });

      const timedOutCount = bridge.checkCommandTimeouts();
      assert.strictEqual(timedOutCount, 1);

      const cmd = bridge.getCommand(cmdId);
      assert.strictEqual(cmd?.status, 'UNRESOLVED', 'Status must transition to UNRESOLVED');
      assert(cmd?.failureReason?.includes('timed out'), 'Failure reason must document timeout');

      // Verify polling does not re-submit command
      const polled = bridge.pollPendingCommands();
      assert.strictEqual(polled.length, 0, 'Timed out UNRESOLVED command must not be re-polled');

      passedCount++;
      console.log('✅ [PASS] TEST 20: Command timeout transition to UNRESOLVED verified.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 21: Pending-order cancellation semantics
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 21: Pending-order CANCEL result semantics');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const cmdId = 'cmd_cancel_test_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CANCEL',
        symbol: 'XAUUSD',
        volume: 0,
        ticket: 96001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      const res = bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'CANCELLED',
        orderCancelled: true,
        orderTicket: 96001,
      }, testStorage);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.message, 'CANCELLED');

      const cmd = bridge.getCommand(cmdId);
      assert.strictEqual(cmd?.status, 'CANCELLED');
      assert.strictEqual(testStorage.getTrades().length, 0, 'Zero phantom trades created');

      passedCount++;
      console.log('✅ [PASS] TEST 21: Pending-order cancellation handled safely without exit price or phantom trades.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 22: Cancellation of tracked pending trade in ledger
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 22: Cancellation of tracked pending trade in ledger');
    {
      const bridge = new MT5BridgeService({ isIsolatedTest: true });
      const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

      const pendingTrade: TradeLedgerItem = {
        id: 'mt5_97001',
        tradeNumber: 1,
        date: 'Oct 13',
        isoTime: new Date().toISOString(),
        asset: 'XAU/USD',
        direction: 'BUY',
        entry: 2650.0,
        sl: 2640.0,
        tp1: 2670.0,
        lotSize: 0.01,
        result: 'OPEN',
        isActive: true,
        brokerPositionTicket: 97001,
        notes: 'Ticket #97001',
      };
      testStorage.saveTrade(pendingTrade);

      const cmdId = 'cmd_cancel_pending_1';
      (bridge as any).commands.set(cmdId, {
        commandId: cmdId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        action: 'CANCEL',
        symbol: 'XAUUSD',
        ticket: 97001,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 2,
      });

      bridge.handleCommandResult(cmdId, {
        success: true,
        status: 'CANCELLED',
        orderCancelled: true,
        orderTicket: 97001,
      }, testStorage);

      const cancelledTrade = testStorage.getTrade('mt5_97001');
      assert.strictEqual(cancelledTrade?.result, 'CANCELLED');
      assert.strictEqual(cancelledTrade?.pl, 0);
      assert.strictEqual(testStorage.getCurrentBalance(), 100.0, 'Balance must remain unchanged ($100.00)');

      passedCount++;
      console.log('✅ [PASS] TEST 22: Pending trade cancellation set result CANCELLED with 0 balance change.\n');
    }

    // -------------------------------------------------------------------------
    // TEST 23: Verify persistent file SHA-256 hash integrity and zero Telegram calls
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 23: Verify persistent file hash integrity and zero Telegram side effects');
    {
      const commandsFilePath = 'data/mt5_commands.json';
      const commandsHashBefore = computeFileHash(commandsFilePath);

      console.log(`  • Observed Telegram fetch request attempts: ${telegramFetchAttemptCount}`);
      assert.strictEqual(telegramFetchAttemptCount, 0, 'Telegram fetch attempt count must be exactly 0');

      const candleHashAfter = computeFileHash(candleFilePath);
      const telegramRetryHashAfter = computeFileHash(telegramRetryPath);
      const telegramDispatchHashAfter = computeFileHash(telegramDispatchPath);
      const commandsHashAfter = computeFileHash(commandsFilePath);

      assert.strictEqual(candleHashAfter, candleHashBefore, 'mt5_candles.json hash must match before and after');
      assert.strictEqual(telegramRetryHashAfter, telegramRetryHashBefore, 'telegram_retry_queue.json hash must match');
      assert.strictEqual(telegramDispatchHashAfter, telegramDispatchHashBefore, 'telegram_dispatches.json hash must match');
      assert.strictEqual(commandsHashAfter, commandsHashBefore, 'mt5_commands.json hash must match');

      passedCount++;
      console.log('✅ [PASS] TEST 23: 100% persistent file hash match and 0 network calls verified.\n');
    }

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('========================================================================');
  console.log(`🎉 ALL ${passedCount}/${totalTests} MT5 COMMAND-RESULT SEMANTICS TESTS PASSED!`);
  console.log('========================================================================\n');
}

runMT5CommandResultSemanticsTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
