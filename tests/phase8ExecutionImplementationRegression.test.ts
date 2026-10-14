import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { MT5BridgeService } from '../server/mt5Bridge.js';
import { PersistentStorage } from '../server/storage.js';

console.log('========================================================================');
console.log('🧪 RUNNING GB-V5 PHASE 8 EXECUTION IMPLEMENTATION REGRESSION SUITE');
console.log('========================================================================\n');

async function runPhase8RegressionTests() {
  const testStoragePath = path.join(process.cwd(), 'data', 'test_ledger.json');
  const testStorage5Path = path.join(process.cwd(), 'data', 'test_phase8_storage5.json');
  const testOutcomes5Path = path.join(process.cwd(), 'data', 'test_phase8_outcomes5.json');
  const testCommandsPath = path.join(process.cwd(), 'data', 'test_phase8_commands.json');

  // Helper to clean temporary test files
  const cleanup = () => {
    if (fs.existsSync(testCommandsPath)) {
      try { fs.unlinkSync(testCommandsPath); } catch {}
    }
    if (fs.existsSync(testStorage5Path)) {
      try { fs.unlinkSync(testStorage5Path); } catch {}
    }
    if (fs.existsSync(testOutcomes5Path)) {
      try { fs.unlinkSync(testOutcomes5Path); } catch {}
    }
  };

  cleanup();

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Full Execution Lifecycle States (REQUESTED, SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, REJECTED, CANCELLED, UNRESOLVED)
    // -------------------------------------------------------------------------
    console.log('TEST 1: Execution lifecycle states distinction and progression');
    const storage = new PersistentStorage({ isIsolatedTest: true, storageFilePath: testStoragePath });
    const bridge = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: testCommandsPath });

    // Enable demo auto-trading
    bridge.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      tradeMode: 0,
      accountMode: 'DEMO',
      login: 12345,
      server: 'DemoServer',
    });
    bridge.enableDemoAutoTrading();

    // Queue order -> status: PENDING / REQUESTED
    const qRes = bridge.queueDemoOrder({
      commandId: 'cmd_lifecycle_1',
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.10,
      price: 2500,
      sl: 2495,
      tp: 2520,
    });
    assert.strictEqual(qRes.success, true);
    const cmd1 = bridge.getCommand('cmd_lifecycle_1');
    assert.ok(cmd1);
    assert.strictEqual(cmd1.status === 'PENDING' || cmd1.status === 'REQUESTED', true, 'Initial status must be PENDING or REQUESTED');

    // Poll pending command -> transitions to SUBMITTED / DISPATCHED
    const pendingCmds = bridge.pollPendingCommands();
    assert.strictEqual(pendingCmds.length, 1);
    assert.strictEqual(pendingCmds[0].commandId, 'cmd_lifecycle_1');
    assert.strictEqual(cmd1.status === 'SUBMITTED' || cmd1.status === 'DISPATCHED', true, 'Polled command transitions to SUBMITTED or DISPATCHED');

    // Acknowledged result -> transitions to ACKNOWLEDGED
    bridge.handleCommandResult('cmd_lifecycle_1', {
      success: true,
      status: 'ACKNOWLEDGED' as any,
      orderTicket: 77001,
      retcode: 10009,
      retcodeDescription: 'Trade order placed on broker',
    }, storage);
    assert.strictEqual(cmd1.status, 'ACKNOWLEDGED');
    assert.strictEqual(cmd1.orderTicket, 77001);

    // Partial fill result -> transitions to PARTIALLY_FILLED
    bridge.handleCommandResult('cmd_lifecycle_1', {
      success: true,
      status: 'PARTIALLY_FILLED' as any,
      positionTicket: 77001,
      orderTicket: 77001,
      executionPrice: 2500.20,
      retcode: 10009,
    }, storage);
    assert.strictEqual(cmd1.status, 'PARTIALLY_FILLED');
    assert.strictEqual(cmd1.positionTicket, 77001);
    assert.ok(cmd1.filledVolume! > 0);

    // Complete fill result -> transitions to FILLED
    bridge.handleCommandResult('cmd_lifecycle_1', {
      success: true,
      status: 'FILLED',
      positionTicket: 77001,
      orderTicket: 77001,
      executionPrice: 2500.20,
      retcode: 10009,
    }, storage);
    assert.strictEqual(cmd1.status, 'FILLED');
    assert.strictEqual(cmd1.executionPrice, 2500.20);

    console.log('✅ [PASS] TEST 1: Execution lifecycle states distinction and progression verified.');

    // -------------------------------------------------------------------------
    // TEST 2: Retries Cannot Create Duplicate Orders & Unknown Outcomes Reconciled First
    // -------------------------------------------------------------------------
    console.log('TEST 2: Retries cannot create duplicate orders and reconcile unresolved outcomes');
    const bridge2 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: testCommandsPath });
    bridge2.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      tradeMode: 0,
      accountMode: 'DEMO',
      login: 12345,
      server: 'DemoServer',
    });
    bridge2.enableDemoAutoTrading();

    bridge2.queueDemoOrder({
      commandId: 'cmd_retry_test_1',
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.05,
      price: 2500,
      sl: 2495,
      tp: 2520,
    });
    bridge2.pollPendingCommands(); // Transitions to SUBMITTED / DISPATCHED

    // Simulate timeout -> transitions to UNRESOLVED
    const cmdRetry = bridge2.getCommand('cmd_retry_test_1')!;
    cmdRetry.status = 'UNRESOLVED';

    // Simulate heartbeat reporting open position with ticket #88100 matching magic and timeframe
    bridge2.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      tradeMode: 0,
      accountMode: 'DEMO',
      positions: [
        {
          ticket: 88100,
          symbol: 'XAUUSD',
          type: 0, // BUY
          volume: 0.05,
          priceOpen: 2500.10,
          magic: 240726,
          time: Math.floor(Date.now() / 1000),
        },
      ],
    });

    // Retry attempt must reconcile first and reject duplicating retry
    const retryRes = bridge2.retryCommand('cmd_retry_test_1', { targetStorage: storage });
    assert.strictEqual(retryRes.success, false, 'Retry must be rejected because position exists');
    assert.strictEqual(cmdRetry.status, 'FILLED', 'UNRESOLVED command must be reconciled to FILLED');
    assert.strictEqual(cmdRetry.positionTicket, 88100);

    console.log('✅ [PASS] TEST 2: Duplicate order prevention and UNRESOLVED reconciliation verified.');

    // -------------------------------------------------------------------------
    // TEST 3: CLOSE, MODIFY, and CANCEL Commands Cannot Fabricate Opening Trades
    // -------------------------------------------------------------------------
    console.log('TEST 3: CLOSE, MODIFY, and CANCEL cannot fabricate new opening trades');
    const storage3 = new PersistentStorage({ isIsolatedTest: true, storageFilePath: testStoragePath });
    const bridge3 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: testCommandsPath });
    bridge3.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      tradeMode: 0,
      accountMode: 'DEMO',
      login: 12345,
      server: 'DemoServer',
    });
    bridge3.enableDemoAutoTrading();

    const initialTradeCount = storage3.getTrades().length;

    // MODIFY for non-existent position
    const modRes = await bridge3.modifyOrder({ ticket: 999111, stopLoss: 2495 });
    assert.strictEqual(modRes.success, true);
    bridge3.handleCommandResult(modRes.commandId!, {
      success: true,
      status: 'FILLED',
      positionTicket: 999111,
      retcode: 10009,
    }, storage3);
    assert.strictEqual(storage3.getTrades().length, initialTradeCount, 'Zero opening trades must be created on MODIFY');

    // CLOSE for non-existent position
    const clsRes = await bridge3.closeOrder({ ticket: 999222, lot: 0.05 });
    assert.strictEqual(clsRes.success, true);
    bridge3.handleCommandResult(clsRes.commandId!, {
      success: true,
      status: 'FILLED',
      positionTicket: 999222,
      executionPrice: 2510,
      retcode: 10009,
    }, storage3);
    assert.strictEqual(storage3.getTrades().length, initialTradeCount, 'Zero opening trades must be created on CLOSE');

    // CANCEL for non-existent pending order
    const canRes = bridge3.cancelOrder(999333);
    assert.strictEqual(canRes.success, true);
    bridge3.handleCommandResult(canRes.commandId!, {
      success: true,
      status: 'CANCELLED',
      orderTicket: 999333,
      retcode: 10009,
    }, storage3);
    assert.strictEqual(storage3.getTrades().length, initialTradeCount, 'Zero opening trades must be created on CANCEL');

    console.log('✅ [PASS] TEST 3: CLOSE, MODIFY, and CANCEL non-fabrication verified.');

    // -------------------------------------------------------------------------
    // TEST 4: Symmetrical Execution Behavior Between BUY and SELL Setups
    // -------------------------------------------------------------------------
    console.log('TEST 4: Symmetrical execution behavior between BUY and SELL');
    const storage4 = new PersistentStorage({ isIsolatedTest: true, storageFilePath: testStoragePath });
    const bridge4 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: testCommandsPath });
    bridge4.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      tradeMode: 0,
      accountMode: 'DEMO',
      login: 12345,
      server: 'DemoServer',
    });
    bridge4.enableDemoAutoTrading();

    // Valid BUY command validation
    const buyRes = bridge4.queueDemoOrder({
      commandId: 'cmd_sym_buy',
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.05,
      price: 2500,
      sl: 2495, // 50 points
      tp: 2510,
    });
    assert.strictEqual(buyRes.success, true, 'BUY validation failed');

    // Invalid BUY command validation (SL > entry)
    const badBuyRes = bridge4.queueDemoOrder({
      commandId: 'cmd_sym_bad_buy',
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.05,
      price: 2500,
      sl: 2505,
      tp: 2510,
    });
    assert.strictEqual(badBuyRes.success, false, 'Invalid BUY with SL > entry must fail');

    // Valid SELL command validation
    const sellRes = bridge4.queueDemoOrder({
      commandId: 'cmd_sym_sell',
      action: 'SELL',
      symbol: 'XAUUSD',
      volume: 0.05,
      price: 2500,
      sl: 2505, // 50 points
      tp: 2490,
    });
    assert.strictEqual(sellRes.success, true, 'SELL validation failed');

    // Invalid SELL command validation (SL < entry)
    const badSellRes = bridge4.queueDemoOrder({
      commandId: 'cmd_sym_bad_sell',
      action: 'SELL',
      symbol: 'XAUUSD',
      volume: 0.05,
      price: 2500,
      sl: 2495,
      tp: 2490,
    });
    assert.strictEqual(badSellRes.success, false, 'Invalid SELL with SL < entry must fail');

    console.log('✅ [PASS] TEST 4: Symmetrical execution behavior verified.');

    // -------------------------------------------------------------------------
    // TEST 5: Deals Report Reconciliation with Commissions and Swaps
    // -------------------------------------------------------------------------
    console.log('TEST 5: Deals report reconciliation including commissions and swaps');
    if (fs.existsSync(testStorage5Path)) { try { fs.unlinkSync(testStorage5Path); } catch {} }
    if (fs.existsSync(testOutcomes5Path)) { try { fs.unlinkSync(testOutcomes5Path); } catch {} }
    const storage5 = new PersistentStorage({ isIsolatedTest: true, storageFilePath: testStorage5Path, outcomesFilePath: testOutcomes5Path });
    const bridge5 = new MT5BridgeService({ isIsolatedTest: true, commandsFilePath: testCommandsPath });

    const posTicket = Math.floor(700000 + Math.random() * 200000);
    const dealTicket = Math.floor(900000 + Math.random() * 200000);

    bridge5.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      tradeMode: 0,
      accountMode: 'DEMO',
      login: 12345,
      server: 'DemoServer',
    });
    bridge5.enableDemoAutoTrading();

    bridge5.queueDemoOrder({
      commandId: 'cmd_deal_seed',
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.10,
      price: 2500,
      sl: 2495,
      tp: 2520,
    });

    // Pre-seed trade ledger with open position
    bridge5.handleCommandResult('cmd_deal_seed', {
      success: true,
      status: 'FILLED',
      positionTicket: posTicket,
      orderTicket: posTicket,
      executionPrice: 2500.00,
    }, storage5);

    const initialBal = storage5.getCurrentBalance();

    // Handle deal report: profit $50, commission -$2, swap -$1 => Net PnL $47
    const dealReportRes = bridge5.handleDealsReport([
      {
        ticket: dealTicket,
        order: posTicket,
        positionId: posTicket,
        time: Math.floor(Date.now() / 1000),
        type: 1, // OUT deal
        entry: 1, // OUT
        magic: 240726,
        volume: 0.10,
        price: 2505.00,
        profit: 50.00,
        commission: -2.00,
        swap: -1.00,
        symbol: 'XAUUSD',
        comment: 'TP hit',
      },
    ], storage5);

    assert.strictEqual(dealReportRes.processedCount, 1);
    const updatedTrade = storage5.getTrade(`mt5_${posTicket}`);
    assert.ok(updatedTrade);
    assert.strictEqual(updatedTrade.result, 'WIN');
    assert.strictEqual(updatedTrade.pl, 47.00, 'Net PnL must be profit ($50) + comm (-$2) + swap (-$1) = $47');
    assert.strictEqual(storage5.getCurrentBalance(), Number((initialBal + 47.00).toFixed(2)));

    // Duplicate deal submission must be idempotent
    const dupDealRes = bridge5.handleDealsReport([
      {
        ticket: dealTicket,
        order: posTicket,
        positionId: posTicket,
        time: Math.floor(Date.now() / 1000),
        type: 1,
        entry: 1,
        magic: 240726,
        volume: 0.10,
        price: 2505.00,
        profit: 50.00,
        commission: -2.00,
        swap: -1.00,
        symbol: 'XAUUSD',
      },
    ], storage5);

    assert.strictEqual(dupDealRes.duplicateCount, 1);
    assert.strictEqual(storage5.getCurrentBalance(), Number((initialBal + 47.00).toFixed(2)), 'Balance must not double count duplicate deals');

    console.log('✅ [PASS] TEST 5: Deals report reconciliation with commissions and swaps verified.');

    console.log('\n========================================================================');
    console.log('🎉 ALL 5/5 PHASE 8 EXECUTION IMPLEMENTATION REGRESSION TESTS PASSED!');
    console.log('========================================================================\n');
  } finally {
    cleanup();
  }
}

runPhase8RegressionTests().catch((err) => {
  console.error('✖ PHASE 8 REGRESSION SUITE FAILED:', err);
  process.exit(1);
});
