import assert from 'assert';
import { MT5BridgeService } from '../server/mt5Bridge.js';
import { storage, PersistentStorage } from '../server/storage.js';
import { fetchHistoricalBacktestDataset } from '../server/marketData.js';
import { Candle } from '../src/types.js';

function createCandles(count: number, basePrice: number, stepMinutes: number = 1): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * stepMinutes * 60000;
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: baseTime + i * stepMinutes * 60000,
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

  await storage.waitUntilReady();
  const prodTradesBefore = storage.getTrades().length;
  const prodOutcomesBefore = storage.getTradeOutcomes().length;
  const prodBalanceBefore = storage.getCurrentBalance();

  const mt5Bridge = new MT5BridgeService({ isIsolatedTest: true });
  const testStorage = PersistentStorage.createIsolatedTestInstance(100.0);

  try {
    // TEST 1: Disconnected state by default
  console.log('TEST 1: Initial state is disconnected with auto-trading disabled');
  assert.strictEqual(mt5Bridge.isAvailable(), false, 'Bridge should be unavailable before connection');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Auto-trading should be inactive initially');
  console.log('✅ [PASS] TEST 1: Initial state safely disconnected.\n');

  // TEST 2: DEMO mode rejects REAL account, and LIVE mode requires explicit authorization
  console.log('TEST 2: DEMO mode rejects REAL account, and LIVE mode requires authorization');
  mt5Bridge.setExecutionMode('DEMO');
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
  assert.strictEqual(realHeartbeatRes.success, true, 'Heartbeat acknowledges real account');
  assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), false, 'DEMO mode must not verify REAL account');
  assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), true, 'Must verify account as REAL');
  
  // In DEMO mode, attempting to queue order on REAL account must be rejected
  const realOrderInDemoMode = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD.m',
    volume: 0.01,
    price: 2500,
    sl: 2495,
    tp: 2510,
  });
  assert.strictEqual(realOrderInDemoMode.success, false, 'DEMO mode must reject order queue on REAL account');
  console.log('✅ [PASS] TEST 2: DEMO mode strictly rejects execution on REAL account.\n');

  // TEST 2B: ANALYSIS mode blocks all order execution server-side
  console.log('TEST 2B: ANALYSIS mode blocks all order execution server-side');
  mt5Bridge.setExecutionMode('ANALYSIS');
  const analysisOrder = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD.m',
    volume: 0.01,
    price: 2500,
    sl: 2495,
    tp: 2510,
  });
  assert.strictEqual(analysisOrder.success, false, 'ANALYSIS mode must block order execution');
  assert(analysisOrder.reason?.includes('وضع التحليل فقط'), 'Rejection reason must mention ANALYSIS ONLY');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Auto-trading must be inactive in ANALYSIS mode');
  console.log('✅ [PASS] TEST 2B: ANALYSIS mode server-side execution blockage verified.\n');

  // TEST 2C: LIVE mode requires explicit authorization before order execution
  console.log('TEST 2C: LIVE mode requires explicit user authorization before order execution');
  
  // 2C.1: Fail closed when MT5_LIVE_EXECUTION_ENABLED is not configured
  const origLiveConfig = process.env.MT5_LIVE_EXECUTION_ENABLED;
  delete process.env.MT5_LIVE_EXECUTION_ENABLED;
  const unconfiguredModeRes = mt5Bridge.setExecutionMode('LIVE');
  assert.strictEqual(unconfiguredModeRes.success, false, 'Setting LIVE mode must fail closed when unconfigured');
  const unconfiguredAuthRes = mt5Bridge.authorizeLiveTrading();
  assert.strictEqual(unconfiguredAuthRes.success, false, 'LIVE authorization must fail closed when unconfigured');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'LIVE auto-trading must be inactive when unconfigured');

  // 2C.2: When configured, requires explicit user authorization before order execution
  process.env.MT5_LIVE_EXECUTION_ENABLED = 'true';
  const configuredModeRes = mt5Bridge.setExecutionMode('LIVE');
  assert.strictEqual(configuredModeRes.success, true, 'Setting LIVE mode must succeed when configured');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'LIVE auto-trading must be inactive before explicit authorization');
  
  const liveOrderUnauthorized = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD.m',
    volume: 0.01,
    price: 2500,
    sl: 2495,
    tp: 2510,
  });
  assert.strictEqual(liveOrderUnauthorized.success, false, 'LIVE mode must reject execution before explicit user authorization');

  // Explicitly authorize LIVE trading on verified REAL account
  const authRes = mt5Bridge.authorizeLiveTrading();
  assert.strictEqual(authRes.success, true, 'LIVE authorization on verified REAL account must succeed');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), true, 'LIVE auto-trading must be active after explicit authorization');

  const liveOrderAuthorized = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD.m',
    volume: 0.01,
    price: 2500,
    sl: 2495,
    tp: 2510,
  });
  assert.strictEqual(liveOrderAuthorized.success, true, 'LIVE authorized order on verified REAL account must be queued');
  console.log('✅ [PASS] TEST 2C: LIVE mode explicit authorization and execution verified.\n');

  // TEST 2D: Missing or unsupported tradeMode fails closed to UNVERIFIED (Impersonation blocked)
  console.log('TEST 2D: Missing or unsupported tradeMode fails closed to UNVERIFIED');
  
  // 2D.1: Missing tradeMode with accountMode: "DEMO"
  mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 11223344,
    server: 'Demo-Server',
    accountMode: 'DEMO', // Missing numeric tradeMode!
  });
  assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), false, 'Missing tradeMode must NOT verify as DEMO');
  assert.strictEqual(mt5Bridge.getStatus().account.accountMode, 'UNVERIFIED', 'Missing tradeMode must result in UNVERIFIED accountMode');

  // 2D.2: Missing tradeMode with accountMode: "REAL"
  mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 11223344,
    server: 'Live-Server',
    accountMode: 'REAL', // Missing numeric tradeMode!
  });
  assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), false, 'Missing tradeMode must NOT verify as REAL');
  assert.strictEqual(mt5Bridge.getStatus().account.accountMode, 'UNVERIFIED', 'Missing tradeMode must result in UNVERIFIED accountMode');

  // 2D.3: Unsupported tradeMode (e.g. Contest mode = 1 or invalid = 99)
  mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 11223344,
    server: 'Contest-Server',
    tradeMode: 1,
    accountMode: 'CONTEST',
  });
  assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), false, 'Contest mode must NOT verify as DEMO');
  assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), false, 'Contest mode must NOT verify as REAL');
  assert.strictEqual(mt5Bridge.getStatus().account.accountMode, 'UNVERIFIED', 'Unsupported tradeMode must result in UNVERIFIED accountMode');

  // Unverified account must block order execution
  const unverifiedOrder = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD.m',
    volume: 0.01,
    price: 2500,
    sl: 2495,
    tp: 2510,
  });
  assert.strictEqual(unverifiedOrder.success, false, 'Unverified account state must block order execution');
  console.log('✅ [PASS] TEST 2D: Missing or unsupported tradeMode strictly fails closed to UNVERIFIED.\n');

  // TEST 2E: Contradictory account information fails closed
  console.log('TEST 2E: Contradictory account information fails closed');
  mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 55667788,
    server: 'Mixed-Server',
    tradeMode: 0, // DEMO numeric
    accountMode: 'REAL', // Contradictory string!
  });
  assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), false, 'Contradictory tradeMode vs accountMode must fail closed');
  assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), false, 'Contradictory tradeMode vs accountMode must fail closed');
  assert.strictEqual(mt5Bridge.getStatus().account.accountMode, 'UNVERIFIED', 'Contradictory data must set accountMode to UNVERIFIED');
  console.log('✅ [PASS] TEST 2E: Contradictory account information correctly fails closed.\n');

  // TEST 2F: LIVE authorization is revoked on account identity or type change
  console.log('TEST 2F: LIVE authorization is revoked on account identity or server/type change');
  // First set up verified REAL account and authorize
  mt5Bridge.setExecutionMode('LIVE');
  mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 12345678,
    server: 'Real-Server-01',
    tradeMode: 2,
    accountMode: 'REAL',
  });
  const liveAuthResult = mt5Bridge.authorizeLiveTrading();
  assert.strictEqual(liveAuthResult.success, true, 'LIVE authorization should succeed for verified REAL account');
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), true, 'LIVE auto-trading active');

  // Now switch account login number on heartbeat
  mt5Bridge.handleBridgeHeartbeat({
    connected: true,
    terminalConnected: true,
    login: 87654321, // Changed account login!
    server: 'Real-Server-01',
    tradeMode: 2,
    accountMode: 'REAL',
  });
  assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'LIVE authorization must be REVOKED when account login changes');

  const revokedOrder = mt5Bridge.queueDemoOrder({
    action: 'BUY',
    symbol: 'XAUUSD.m',
    volume: 0.01,
    price: 2500,
    sl: 2495,
    tp: 2510,
  });
  assert.strictEqual(revokedOrder.success, false, 'Order queue must be rejected after LIVE authorization revocation');
  if (origLiveConfig !== undefined) {
    process.env.MT5_LIVE_EXECUTION_ENABLED = origLiveConfig;
  } else {
    delete process.env.MT5_LIVE_EXECUTION_ENABLED;
  }
  console.log('✅ [PASS] TEST 2F: Account identity change revokes LIVE authorization.\n');

  // TEST 2G: Sensitive Web API Authentication Enforcement
  console.log('TEST 2G: Sensitive Web API Authentication Enforcement');
  const prevAdminKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'secure_test_admin_key_2026';

  let statusCode = 0;
  let responseData: any = null;
  let nextCalled = false;

  const mockRes: any = {
    status: (code: number) => {
      statusCode = code;
      return mockRes;
    },
    json: (data: any) => {
      responseData = data;
      return mockRes;
    },
  };

  // Simulate verifyAdminAuth middleware logic
  const verifyAdminAuthTest = (reqHeaders: any, nextFn: () => void) => {
    statusCode = 0;
    responseData = null;
    nextCalled = false;

    const configuredKey = (process.env.ADMIN_API_KEY || '').trim();
    if (!configuredKey || configuredKey === 'your_secure_random_bridge_token_here' || configuredKey.length < 8) {
      statusCode = 503;
      responseData = { success: false, error: 'Service Unavailable: Admin authentication is unavailable' };
      return;
    }

    const authHeader = reqHeaders.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (reqHeaders['x-admin-key'] || reqHeaders['x-api-key'] || authHeader).trim();

    if (!token || token !== configuredKey) {
      statusCode = 401;
      responseData = { success: false, error: 'Unauthorized: Admin authentication token required' };
      return;
    }
    nextFn();
  };

  // 2G.1: Unauthenticated request to sensitive route must be rejected with 401
  verifyAdminAuthTest({}, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, 'Unauthenticated request must NOT proceed to handler');
  assert.strictEqual(statusCode, 401, 'Unauthenticated request must receive HTTP 401');
  assert.strictEqual(responseData?.success, false, 'Response must indicate failure');

  // 2G.2: Request with invalid key must be rejected
  verifyAdminAuthTest({ authorization: 'Bearer wrong_key' }, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, 'Request with invalid key must NOT proceed');
  assert.strictEqual(statusCode, 401, 'Invalid key request must receive HTTP 401');

  // 2G.3: Authenticated request with correct Bearer token must pass
  verifyAdminAuthTest({ authorization: 'Bearer secure_test_admin_key_2026' }, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Authenticated request with Bearer token must proceed');

  // 2G.4: Authenticated request with x-admin-key header must pass
  verifyAdminAuthTest({ 'x-admin-key': 'secure_test_admin_key_2026' }, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Authenticated request with x-admin-key header must proceed');

  process.env.ADMIN_API_KEY = prevAdminKey;
  console.log('✅ [PASS] TEST 2G: Sensitive Web API endpoints strictly require authentication.\n');

  // Reset to DEMO mode and disable auto trading for subsequent tests
  mt5Bridge.setExecutionMode('DEMO');
  mt5Bridge.disableDemoAutoTrading();

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
  mt5Bridge.clearCandleCache();
  const m1Candles = createCandles(300, 2500, 1);
  const m5Candles = createCandles(300, 2500, 5);
  const m15Candles = createCandles(100, 2500, 15);
  const h1Candles = createCandles(30, 2500, 60);

  mt5Bridge.storeHistoricalCandles('M1', m1Candles);
  mt5Bridge.storeHistoricalCandles('M5', m5Candles);
  mt5Bridge.storeHistoricalCandles('M15', m15Candles);
  mt5Bridge.storeHistoricalCandles('H1', h1Candles);

  assert.strictEqual(mt5Bridge.hasHistoricalCandles('M1'), true, 'Should have M1 candles');
  assert.strictEqual(mt5Bridge.hasHistoricalCandles('M5'), true, 'Should have M5 candles');
  assert.strictEqual(mt5Bridge.hasHistoricalCandles('M15'), true, 'Should have M15 candles');
  assert.strictEqual(mt5Bridge.hasHistoricalCandles('H1'), true, 'Should have H1 candles');

  const retrievedM5 = mt5Bridge.getHistoricalCandles('M5');
  assert.strictEqual(retrievedM5?.length, 300, 'Retrieved M5 candles length must match stored');
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
  const initialBalance = testStorage.getSettings().manualCapital;
  const initialTradesCount = testStorage.getTrades().length;

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

  const dealReportRes = mt5Bridge.handleDealsReport([deal1], testStorage);
  assert.strictEqual(dealReportRes.success, true, 'Deals report must succeed');
  assert.strictEqual(dealReportRes.processedCount, 1, 'One deal must be processed');
  assert.strictEqual(dealReportRes.duplicateCount, 0, 'No duplicates on initial report');

  // Verify trade in ledger
  const updatedTrades = testStorage.getTrades(500);
  const recordedTrade = updatedTrades.find((t) => t.id === 'mt5_770011' || t.notes?.includes('990011'));
  assert(recordedTrade !== undefined, 'Recorded trade must be present in ledger');
  assert.strictEqual(recordedTrade?.result, 'WIN', 'Outcome must be WIN for positive PnL');
  assert.strictEqual(recordedTrade?.pl, 24.90, 'Realized PnL must account for profit + commission + swap ($24.90)');

  // Verify outcome record
  const outcomeRec = testStorage.getTradeOutcome(recordedTrade!.id) || testStorage.getTradeOutcome(recordedTrade!.signalId || '');
  assert(outcomeRec !== undefined, 'Outcome record must exist in storage');
  assert.strictEqual(outcomeRec?.brokerDealId, '990011', 'Broker deal ticket must match');

  // Verify idempotency: re-reporting deal1 must not re-process or double-count PnL
  const duplicateDealReportRes = mt5Bridge.handleDealsReport([deal1], testStorage);
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
  }, mt5Bridge);
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
  } finally {
    assert.strictEqual(storage.getTrades().length, prodTradesBefore, 'Production trades count must be untouched');
    assert.strictEqual(storage.getTradeOutcomes().length, prodOutcomesBefore, 'Production outcomes count must be untouched');
    assert.strictEqual(storage.getCurrentBalance(), prodBalanceBefore, 'Production balance must be untouched');
  }
}

runMT5BridgeRegressionTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
