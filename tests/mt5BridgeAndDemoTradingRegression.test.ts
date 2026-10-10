import assert from 'assert';
import { mt5Bridge } from '../server/mt5Bridge.js';
import { storage } from '../server/storage.js';
import { fetchHistoricalBacktestDataset } from '../server/marketData.js';
import { Candle } from '../src/types.js';

function createCandles(count: number, basePrice: number): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * 60000;
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: baseTime + i * 60000,
      open: basePrice + i * 0.1,
      high: basePrice + i * 0.1 + 0.5,
      low: basePrice + i * 0.1 - 0.5,
      close: basePrice + i * 0.1 + 0.2,
      volume: 500,
      isClosed: true,
    });
  }
  return candles;
}

async function runMT5BridgeRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 MT5 BRIDGE & DEMO AUTO-TRADING REGRESSION SUITE');
  console.log('========================================================================\n');

  // TEST 1: Disconnected state by default
  console.log('TEST 1: Initial state is disconnected with auto-trading disabled');
  assert.strictEqual(mt5Bridge.isAvailable(), false, 'Bridge should be unavailable before connection');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Auto-trading should be inactive initially');
  console.log('✅ [PASS] TEST 1: Initial state safely disconnected.\n');

  // TEST 2: Refuse REAL account connection and trip kill switch
  console.log('TEST 2: Strict rejection of REAL account (tradeMode = 2)');
  const realHeartbeatRes = mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 12345678,
    server: 'Live-Server',
    currency: 'USD',
    balance: 50000,
    equity: 50000,
    freeMargin: 50000,
    tradeMode: 2, // ACCOUNT_TRADE_MODE_REAL
    accountMode: 'REAL',
  });
  assert.strictEqual(realHeartbeatRes.success, false, 'Heartbeat must reject real accounts');
  assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), false, 'Must not verify real account as demo');
  assert.strictEqual(mt5Bridge.getStatus().safety.killSwitchActivated, true, 'Emergency kill switch must trip on real account');
  console.log('✅ [PASS] TEST 2: REAL account strictly refused and kill switch tripped.\n');

  // Reset kill switch for subsequent tests
  mt5Bridge.resetKillSwitch();

  // TEST 3: Accept valid DEMO account heartbeat
  console.log('TEST 3: Accept valid DEMO account heartbeat (tradeMode = 0)');
  const demoHeartbeatRes = mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 99887766,
    server: 'MetaQuotes-Demo',
    currency: 'USD',
    balance: 10000,
    equity: 10000,
    freeMargin: 10000,
    tradeMode: 0, // ACCOUNT_TRADE_MODE_DEMO
    accountMode: 'DEMO',
    brokerGoldSymbol: 'XAUUSD',
  });
  assert.strictEqual(demoHeartbeatRes.success, true, 'Heartbeat must accept demo account');
  assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), true, 'Must verify demo account');
  assert.strictEqual(mt5Bridge.isAvailable(), true, 'Bridge must be available');
  // Auto-trading remains disabled by default until user explicitly enables it
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Auto-trading must remain disabled by default on connect');
  console.log('✅ [PASS] TEST 3: DEMO account verified and auto-trading defaults to disabled.\n');

  // TEST 4: Enabling and disabling demo auto-trading
  console.log('TEST 4: User explicit enable and disable of demo auto-trading');
  const enableRes = mt5Bridge.enableDemoAutoTrading();
  assert.strictEqual(enableRes.success, true, 'User should be able to enable demo auto-trading');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), true, 'Auto-trading should now be active');

  const disableRes = mt5Bridge.disableDemoAutoTrading();
  assert.strictEqual(disableRes.success, true, 'User should be able to disable demo auto-trading');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Auto-trading should now be inactive');

  // Re-enable for order tests
  mt5Bridge.enableDemoAutoTrading();
  console.log('✅ [PASS] TEST 4: Explicit user enable/disable controls verified.\n');

  // TEST 5: Order validation - Mandatory protective Stop Loss
  console.log('TEST 5: Mandatory protective Stop Loss enforcement');
  const noSlRes = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    price: 2500.0,
    sl: 0, // Missing SL
    tp: 2510.0,
  });
  assert.strictEqual(noSlRes.success, false, 'Order without SL must be rejected');
  assert(noSlRes.reason?.includes('Stop Loss'), 'Rejection reason must mention Stop Loss');
  console.log('✅ [PASS] TEST 5: Missing Stop Loss correctly rejected.\n');

  // TEST 6: Order validation - Stop Loss side validation
  console.log('TEST 6: Stop Loss on wrong side of entry');
  const badBuySlRes = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    price: 2500.0,
    sl: 2505.0, // Above buy price
    tp: 2515.0,
  });
  assert.strictEqual(badBuySlRes.success, false, 'BUY order with SL above price must be rejected');

  const badSellSlRes = mt5Bridge.queueDemoOrder({
    action: 'SELL',
    price: 2500.0,
    sl: 2495.0, // Below sell price
    tp: 2485.0,
  });
  assert.strictEqual(badSellSlRes.success, false, 'SELL order with SL below price must be rejected');
  console.log('✅ [PASS] TEST 6: SL side validation correctly enforced.\n');

  // TEST 7: Order validation - Strict 35-85 points SL range
  console.log('TEST 7: Strict 35-85 points SL range enforcement');
  const tinySlRes = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    price: 2500.0,
    sl: 2498.0, // 20 points (below 35 min)
    tp: 2510.0,
  });
  assert.strictEqual(tinySlRes.success, false, 'SL with 20 points (<35 min) must be rejected');

  const hugeSlRes = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    price: 2500.0,
    sl: 2490.0, // 100 points (>85 max)
    tp: 2520.0,
  });
  assert.strictEqual(hugeSlRes.success, false, 'SL with 100 points (>85 max) must be rejected');
  console.log('✅ [PASS] TEST 7: 35-85 points SL bounds correctly enforced.\n');

  // TEST 8: Valid compliant demo order queuing and polling
  console.log('TEST 8: Valid compliant DEMO order queued and polled');
  const validOrderRes = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD',
    volume: 0.02,
    price: 2500.0,
    sl: 2495.0, // 50 points (within 35-85 points)
    tp: 2510.0,
    comment: 'GB-V5 Test Trade',
  });
  assert.strictEqual(validOrderRes.success, true, 'Compliant demo order must be accepted');
  assert(validOrderRes.commandId, 'Command ID must be generated');

  // Poll command
  const pendingCommands = mt5Bridge.pollPendingCommands();
  assert(pendingCommands.length >= 1, 'Should poll the queued pending command');
  const polled = pendingCommands.find((c) => c.commandId === validOrderRes.commandId);
  assert(polled, 'Target command should be present in polled commands');
  assert.strictEqual(polled?.status, 'DISPATCHED', 'Polled command status must be DISPATCHED');
  console.log('✅ [PASS] TEST 8: Valid order queued and polled as DISPATCHED.\n');

  // TEST 9: Broker fill result handling
  console.log('TEST 9: Broker FILLED result callback and position reconciliation');
  const fillRes = mt5Bridge.handleCommandResult(validOrderRes.commandId!, {
    success: true,
    status: 'FILLED',
    orderTicket: 555111,
    dealTicket: 555112,
    positionTicket: 555111,
    executionPrice: 2500.05,
    retcode: 10009, // TRADE_RETCODE_DONE
    retcodeDescription: 'Done',
  });
  assert.strictEqual(fillRes.success, true, 'Command result should be acknowledged');
  
  const statusAfterFill = mt5Bridge.getStatus();
  const recentCmd = statusAfterFill.commands.recent.find((c) => c.commandId === validOrderRes.commandId);
  assert.strictEqual(recentCmd?.status, 'FILLED', 'Command status must be FILLED');
  assert.strictEqual(recentCmd?.positionTicket, 555111, 'Position ticket must match');
  console.log('✅ [PASS] TEST 9: Broker FILLED execution correctly recorded.\n');

  // TEST 10: Consecutive failures trigger safety kill switch
  console.log('TEST 10: Consecutive failures limit triggers emergency kill switch');
  // Send 3 failed order results
  for (let i = 1; i <= 3; i++) {
    const failCmdRes = mt5Bridge.queueDemoOrder({
      commandId: `fail_cmd_${i}`,
      action: 'BUY',
      price: 2500.0,
      sl: 2495.0,
      tp: 2510.0,
    });
    assert.strictEqual(failCmdRes.success, true);
    mt5Bridge.pollPendingCommands();
    mt5Bridge.handleCommandResult(`fail_cmd_${i}`, {
      success: false,
      status: 'REJECTED',
      retcode: 10019,
      retcodeDescription: 'No money',
      message: 'Margin insufficient',
    });
  }

  const statusAfterFailures = mt5Bridge.getStatus();
  assert.strictEqual(statusAfterFailures.safety.killSwitchActivated, true, 'Kill switch must trip after consecutive failures');
  assert.strictEqual(statusAfterFailures.safety.isAutoTradingActive, false, 'Auto-trading must be halted');
  console.log('✅ [PASS] TEST 10: Consecutive failures properly tripped emergency kill switch.\n');

  // Reset kill switch
  mt5Bridge.resetKillSwitch();

  // TEST 11: Historical candles extraction and caching for backtesting
  console.log('TEST 11: Historical candles storage and retrieval across timeframes');
  const m1Candles = createCandles(100, 2500);
  const m5Candles = createCandles(50, 2500);
  const m15Candles = createCandles(40, 2500);
  const h1Candles = createCandles(30, 2500);

  mt5Bridge.storeHistoricalCandles('M1', m1Candles);
  mt5Bridge.storeHistoricalCandles('M5', m5Candles);
  mt5Bridge.storeHistoricalCandles('M15', m15Candles);
  mt5Bridge.storeHistoricalCandles('H1', h1Candles);

  assert.strictEqual(mt5Bridge.hasHistoricalCandles('M1'), true, 'Should have M1 candles');
  assert.strictEqual(mt5Bridge.hasHistoricalCandles('M5'), true, 'Should have M5 candles');
  assert.strictEqual(mt5Bridge.hasHistoricalCandles('M15'), true, 'Should have M15 candles');
  assert.strictEqual(mt5Bridge.hasHistoricalCandles('H1'), true, 'Should have H1 candles');

  const retrievedM5 = mt5Bridge.getHistoricalCandles('M5');
  assert.strictEqual(retrievedM5?.length, 50, 'Retrieved M5 candles length must match stored');
  console.log('✅ [PASS] TEST 11: Historical candles cached and accessible for backtesting.\n');

  // TEST 12: Broker symbol specifications validation, transmission, mapping, and fail-closed defense
  console.log('TEST 12: Broker symbol specifications validation, mapping, and fail-closed protection');
  // 12.1: Invalid specs rejected
  const badSpecsValidation = mt5Bridge.validateBrokerSpecs({
    symbol: 'XAUUSD',
    contractSize: 0, // Invalid!
    point: 0.01,
  });
  assert.strictEqual(badSpecsValidation.isValid, false, 'Invalid contractSize must fail validation');
  assert(badSpecsValidation.error?.includes('حجم العقد غير صالح'), 'Error must specify invalid contract size');

  // 12.2: Valid specs accepted and mapped into BrokerContractSpecs
  const validSpecs = {
    symbol: 'XAUUSD',
    contractSize: 100.0,
    point: 0.01,
    digits: 2,
    volumeMin: 0.01,
    volumeMax: 50.0,
    volumeStep: 0.01,
    tickSize: 0.01,
    tickValue: 1.0,
    stopsLevel: 30,
    spread: 15,
  };
  const setSpecsRes = mt5Bridge.setBrokerSpecs(validSpecs);
  assert.strictEqual(setSpecsRes.success, true, 'Valid broker specs must be accepted');
  assert.strictEqual(mt5Bridge.isBrokerSpecsValid(), true, 'Broker specs must be valid');

  const mappedBrokerSpecs = mt5Bridge.getBrokerSpecs();
  assert(mappedBrokerSpecs !== null, 'Mapped broker specs must not be null');
  assert.strictEqual(mappedBrokerSpecs?.contractSizeOz, 100.0, 'contractSizeOz must match');
  assert.strictEqual(mappedBrokerSpecs?.minimumLot, 0.01, 'minimumLot must match');
  assert.strictEqual(mappedBrokerSpecs?.maximumLot, 50.0, 'maximumLot must match');
  assert.strictEqual(mappedBrokerSpecs?.lotStep, 0.01, 'lotStep must match');
  assert.strictEqual(mappedBrokerSpecs?.stopsLevel, 30, 'stopsLevel must match');
  console.log('✅ [PASS] TEST 12: Broker symbol specifications mapped and verified.\n');

  // TEST 13: Deal history reconciliation with the persistent trade ledger and realized PnL
  console.log('TEST 13: Deal history reconciliation, realized PnL, idempotency, and ledger persistence');
  const initialBalance = storage.getSettings().manualCapital;
  const initialTradesCount = storage.getTrades().length;

  const deal1 = {
    ticket: 990011,
    order: 880011,
    positionId: 770011,
    time: Math.floor(Date.now() / 1000),
    type: 1, // SELL (closing BUY)
    entry: 1, // DEAL_ENTRY_OUT
    magic: 240726,
    volume: 0.02,
    price: 2515.50,
    profit: 25.50,
    commission: -0.50,
    swap: -0.10,
    symbol: 'XAUUSD',
    comment: 'TP1 Hit Close',
  };

  const dealReportRes = mt5Bridge.handleDealsReport([deal1]);
  assert.strictEqual(dealReportRes.success, true, 'Deals report must succeed');
  assert.strictEqual(dealReportRes.processedCount, 1, 'One deal must be processed');
  assert.strictEqual(dealReportRes.duplicateCount, 0, 'No duplicates on initial report');

  // Verify trade in ledger
  const updatedTrades = storage.getTrades(500);
  const recordedTrade = updatedTrades.find((t) => t.id === 'mt5_770011' || t.notes?.includes('990011'));
  assert(recordedTrade !== undefined, 'Recorded trade must be present in ledger');
  assert.strictEqual(recordedTrade?.result, 'WIN', 'Outcome must be WIN for positive PnL');
  assert.strictEqual(recordedTrade?.pl, 24.90, 'Realized PnL must account for profit + commission + swap ($24.90)');

  // Verify outcome record
  const outcomeRec = storage.getTradeOutcome(recordedTrade!.id) || storage.getTradeOutcome(recordedTrade!.signalId || '');
  assert(outcomeRec !== undefined, 'Outcome record must exist in storage');
  assert.strictEqual(outcomeRec?.brokerDealId, '990011', 'Broker deal ticket must match');

  // Verify idempotency: re-reporting deal1 must not re-process or double-count PnL
  const duplicateDealReportRes = mt5Bridge.handleDealsReport([deal1]);
  assert.strictEqual(duplicateDealReportRes.processedCount, 0, 'Re-reported deal must not be re-processed');
  assert.strictEqual(duplicateDealReportRes.duplicateCount, 1, 'Re-reported deal must be flagged as duplicate');
  console.log('✅ [PASS] TEST 13: Deal reconciliation and idempotency verified.\n');

  // TEST 14: Risk limits reconciliation - Respect configured SL bounds & broker lot bounds
  console.log('TEST 14: Risk limits reconciliation - Dynamic SL bounds and lot volume');
  mt5Bridge.enableDemoAutoTrading();
  // Order within configured 35-85 points SL range
  const validSlOrder = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD',
    volume: 0.02,
    price: 2500.0,
    sl: 2494.0, // 60 points
    tp: 2515.0,
  });
  assert.strictEqual(validSlOrder.success, true, 'Order with 60 points SL must be accepted');

  // Order below broker volumeMin (0.01)
  const tinyLotOrder = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD',
    volume: 0.005,
    price: 2500.0,
    sl: 2494.0,
    tp: 2515.0,
  });
  assert.strictEqual(tinyLotOrder.success, false, 'Order below broker volumeMin must be rejected');
  assert(tinyLotOrder.reason?.includes('أقل من الحد الأدنى'), 'Rejection reason must mention minimum lot');
  console.log('✅ [PASS] TEST 14: Dynamic SL bounds and broker lot bounds verified.\n');

  // TEST 15: Historical M1 candles ingestion in Backtesting dataset
  console.log('TEST 15: Historical M1 candles ingestion in Backtesting dataset');
  const datasetResult = await fetchHistoricalBacktestDataset({
    symbol: 'XAUUSD',
    timeRange: '1D',
    requestedStartTime: Date.now() - 24 * 3600 * 1000,
    requestedEndTime: Date.now(),
  });
  assert.strictEqual(datasetResult.provider, 'MT5_BRIDGE', 'Provider should be MT5_BRIDGE');
  assert(Array.isArray(datasetResult.candles1m), 'candles1m array must be present');
  assert(datasetResult.candles1m!.length >= 30, 'candles1m must contain historical M1 candles');
  assert(Array.isArray(datasetResult.candles5m), 'candles5m array must be present');
  assert(Array.isArray(datasetResult.candles15m), 'candles15m array must be present');
  assert(Array.isArray(datasetResult.candles1h), 'candles1h array must be present');
  console.log('✅ [PASS] TEST 15: Historical M1 candles verified in backtest data pipeline.\n');

  console.log('========================================================================');
  console.log('🎉 ALL 15 MT5 BRIDGE & DEMO AUTO-TRADING REGRESSION TESTS PASSED (15/15)!');
  console.log('========================================================================');
}

runMT5BridgeRegressionTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
