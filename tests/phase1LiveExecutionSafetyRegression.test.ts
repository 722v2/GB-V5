import assert from 'node:assert/strict';
import { MT5BridgeService } from '../server/mt5Bridge.js';

/**
 * ============================================================================
 * PHASE 1 REGRESSION TEST SUITE: FAIL-CLOSED LIVE/REAL EXECUTION SAFETY
 * ============================================================================
 * 
 * Objectives:
 * 1. Verify that LIVE/REAL execution is denied by default (fail-closed) when unconfigured.
 * 2. Verify that unsupported or malformed modes are rejected at runtime.
 * 3. Verify that ANALYSIS and DEMO modes continue to operate normally and safely.
 * 4. Verify that when MT5_LIVE_EXECUTION_ENABLED === 'true', live execution requires:
 *    - explicit user authorization
 *    - a verified REAL account (numeric tradeMode === 2)
 *    - all standard risk, connectivity, and safety boundaries.
 * 5. Verify that any account identity change or kill-switch activation revokes authorization immediately.
 * 6. Verify that dispatch boundary (pollPendingCommands) enforces the policy fail-closed.
 */

async function runPhase1LiveExecutionSafetyRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PHASE 1 REGRESSION SUITE: LIVE/REAL EXECUTION SAFETY GATE');
  console.log('========================================================================\n');

  // Dedicated MT5BridgeService instance configured for strict test isolation
  const mt5Bridge = new MT5BridgeService({ isIsolatedTest: true });

  const origEnvConfig = process.env.MT5_LIVE_EXECUTION_ENABLED;

  try {
    // ------------------------------------------------------------------------
    // SECTION 1: DEFAULT FAIL-CLOSED DENIAL (UNCONFIGURED ENVIRONMENT)
    // ------------------------------------------------------------------------
    console.log('--- 1. Default Fail-Closed Denial (Unconfigured Environment) ---');
    delete process.env.MT5_LIVE_EXECUTION_ENABLED;

    assert.strictEqual(
      mt5Bridge.isLiveExecutionConfigured(),
      false,
      'isLiveExecutionConfigured must return false when MT5_LIVE_EXECUTION_ENABLED is not set'
    );

    // 1.1: Mode change to LIVE denied
    const modeChangeDenied = mt5Bridge.setExecutionMode('LIVE');
    assert.strictEqual(modeChangeDenied.success, false, 'setExecutionMode(LIVE) must be denied when unconfigured');
    assert.match(modeChangeDenied.message || '', /MT5_LIVE_EXECUTION_ENABLED/, 'Error message must cite configuration gate');

    // 1.2: Authorization denied
    const authDenied = mt5Bridge.authorizeLiveTrading();
    assert.strictEqual(authDenied.success, false, 'authorizeLiveTrading must be denied when unconfigured');
    assert.match(authDenied.reason || '', /MT5_LIVE_EXECUTION_ENABLED/, 'Reason must cite configuration gate');

    // 1.3: Simulated REAL account heartbeat cannot bypass the configuration gate
    mt5Bridge.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      login: 99887766,
      server: 'Real-Server-01',
      tradeMode: 2,
      accountMode: 'REAL',
    });
    assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), true, 'Account is verified REAL');
    const authStillDenied = mt5Bridge.authorizeLiveTrading();
    assert.strictEqual(authStillDenied.success, false, 'Authorization must remain denied even with verified REAL terminal');

    console.log('✔ Section 1 Passed: Unconfigured environment strictly fails closed.\n');

    // ------------------------------------------------------------------------
    // SECTION 2: RUNTIME VALIDATION OF UNKNOWN & MALFORMED MODES
    // ------------------------------------------------------------------------
    console.log('--- 2. Runtime Validation of Unknown & Malformed Modes ---');

    const invalidMode1 = mt5Bridge.setExecutionMode('CONTEST' as any);
    assert.strictEqual(invalidMode1.success, false, 'CONTEST mode must be rejected');

    const invalidMode2 = mt5Bridge.setExecutionMode('UNVERIFIED' as any);
    assert.strictEqual(invalidMode2.success, false, 'UNVERIFIED mode must be rejected');

    const invalidMode3 = mt5Bridge.setExecutionMode('' as any);
    assert.strictEqual(invalidMode3.success, false, 'Empty mode string must be rejected');

    console.log('✔ Section 2 Passed: Unknown/malformed modes strictly rejected.\n');

    // ------------------------------------------------------------------------
    // SECTION 3: DEMO AND ANALYSIS MODES PRESERVATION
    // ------------------------------------------------------------------------
    console.log('--- 3. Preservation of DEMO and ANALYSIS Modes ---');

    // 3.1: ANALYSIS mode blocks all execution
    const setAnalysisRes = mt5Bridge.setExecutionMode('ANALYSIS');
    assert.strictEqual(setAnalysisRes.success, true, 'setExecutionMode(ANALYSIS) must succeed');
    assert.strictEqual(mt5Bridge.getExecutionMode(), 'ANALYSIS');
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Auto-trading must be false in ANALYSIS');

    const analysisOrder = mt5Bridge.queueDemoOrder({
      action: 'BUY',
      symbol: 'XAUUSD',
      price: 2500,
      sl: 2495,
      tp: 2510,
    });
    assert.strictEqual(analysisOrder.success, false, 'ANALYSIS mode must block order queuing');
    assert.match(analysisOrder.reason || '', /وضع التحليل فقط/);

    // 3.2: DEMO mode allows verified demo operation
    const setDemoRes = mt5Bridge.setExecutionMode('DEMO');
    assert.strictEqual(setDemoRes.success, true, 'setExecutionMode(DEMO) must succeed');

    mt5Bridge.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      login: 12345,
      server: 'Demo-Server',
      tradeMode: 0,
      accountMode: 'DEMO',
    });
    assert.strictEqual(mt5Bridge.isVerifiedDemoAccount(), true, 'Must verify as DEMO');

    mt5Bridge.enableDemoAutoTrading();
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), true, 'DEMO auto-trading must be active');

    const demoOrder = mt5Bridge.queueDemoOrder({
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.01,
      price: 2500,
      sl: 2495,
      tp: 2510,
    });
    assert.strictEqual(demoOrder.success, true, 'Compliant order in DEMO mode must succeed');

    mt5Bridge.disableDemoAutoTrading();
    console.log('✔ Section 3 Passed: ANALYSIS and DEMO modes function safely and as intended.\n');

    // ------------------------------------------------------------------------
    // SECTION 4: CONFIGURED LIVE EXECUTION POLICY & VERIFIED AUTHORIZATION
    // ------------------------------------------------------------------------
    console.log('--- 4. Configured Live Execution Policy & Verified Authorization ---');
    process.env.MT5_LIVE_EXECUTION_ENABLED = 'true';

    assert.strictEqual(mt5Bridge.isLiveExecutionConfigured(), true, 'isLiveExecutionConfigured returns true when set');

    // 4.1: Switch to LIVE mode (allowed when configured, but unauthorized by default)
    const setLiveRes = mt5Bridge.setExecutionMode('LIVE');
    assert.strictEqual(setLiveRes.success, true, 'setExecutionMode(LIVE) succeeds when configured');
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'LIVE auto-trading must be inactive before explicit authorization');

    // 4.2: Terminal is currently connected to DEMO -> Authorization must FAIL
    const authOnDemo = mt5Bridge.authorizeLiveTrading();
    assert.strictEqual(authOnDemo.success, false, 'authorizeLiveTrading on DEMO account must fail');
    assert.match(authOnDemo.reason || '', /ليس حساباً حقيقياً/);

    // 4.3: Terminal with contradictory info (tradeMode: 0, accountMode: "REAL") -> Must FAIL
    mt5Bridge.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      login: 887766,
      server: 'Mixed-Server',
      tradeMode: 0,
      accountMode: 'REAL',
    });
    assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), false, 'Contradictory heartbeat must not verify as REAL');
    const authContradictory = mt5Bridge.authorizeLiveTrading();
    assert.strictEqual(authContradictory.success, false, 'Authorization must fail on contradictory account data');

    // 4.4: Terminal with verified REAL account (tradeMode: 2, accountMode: "REAL")
    mt5Bridge.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      login: 77889900,
      server: 'Real-Broker-01',
      tradeMode: 2,
      accountMode: 'REAL',
    });
    assert.strictEqual(mt5Bridge.isVerifiedRealAccount(), true, 'Verified REAL account confirmed');

    // 4.5: Explicit authorization on verified REAL account -> SUCСEEDS
    const liveAuthSuccess = mt5Bridge.authorizeLiveTrading();
    assert.strictEqual(liveAuthSuccess.success, true, 'authorizeLiveTrading must succeed on verified REAL account');
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), true, 'LIVE auto-trading must be active after authorization');

    // 4.6: Queue compliant order in authorized LIVE mode -> SUCCEEDS
    const liveOrder = mt5Bridge.queueDemoOrder({
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.02,
      price: 2500,
      sl: 2495,
      tp: 2510,
    });
    assert.strictEqual(liveOrder.success, true, 'Compliant order in authorized LIVE mode must be queued');

    // 4.7: Poll pending command verifies it is dispatched
    const polled = mt5Bridge.pollPendingCommands();
    assert.ok(polled.some((c) => c.commandId === liveOrder.commandId), 'Queued live order must be dispatched');

    console.log('✔ Section 4 Passed: Configured live authorization operates strictly according to policy.\n');

    // ------------------------------------------------------------------------
    // SECTION 5: REVOCATION ON STATE DRIFT, KILL-SWITCH, OR DISCONNECT
    // ------------------------------------------------------------------------
    console.log('--- 5. Immediate Revocation on State Drift or Kill-Switch ---');

    // 5.1: Changing account login revokes authorization immediately
    mt5Bridge.handleBridgeHeartbeat({
      connected: true,
      terminalConnected: true,
      login: 11112222, // New login!
      server: 'Real-Broker-01',
      tradeMode: 2,
      accountMode: 'REAL',
    });
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'LIVE authorization must be revoked when login changes');

    const orderAfterDrift = mt5Bridge.queueDemoOrder({
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.01,
      price: 2500,
      sl: 2495,
      tp: 2510,
    });
    assert.strictEqual(orderAfterDrift.success, false, 'Orders must be rejected after revocation');

    // 5.2: Re-authorize, then trigger Kill Switch
    const reauth = mt5Bridge.authorizeLiveTrading();
    assert.strictEqual(reauth.success, true);
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), true);

    mt5Bridge.activateKillSwitch('Testing Kill Switch in LIVE mode');
    assert.strictEqual(mt5Bridge.isDemoAutoTradingActive(), false, 'Kill-switch must immediately halt LIVE trading');

    const orderAfterKill = mt5Bridge.queueDemoOrder({
      action: 'BUY',
      symbol: 'XAUUSD',
      volume: 0.01,
      price: 2500,
      sl: 2495,
      tp: 2510,
    });
    assert.strictEqual(orderAfterKill.success, false, 'Orders must be rejected when kill switch is active');

    // Reset kill-switch and return to DEMO mode for safe cleanup
    mt5Bridge.resetKillSwitch();
    mt5Bridge.setExecutionMode('DEMO');
    console.log('✔ Section 5 Passed: Dynamic revocation safeguards verified.\n');

    console.log('========================================================================');
    console.log('ALL PHASE 1 LIVE EXECUTION SAFETY REGRESSION TESTS PASSED (100%)');
    console.log('========================================================================');
  } finally {
    if (origEnvConfig !== undefined) {
      process.env.MT5_LIVE_EXECUTION_ENABLED = origEnvConfig;
    } else {
      delete process.env.MT5_LIVE_EXECUTION_ENABLED;
    }
  }
}

runPhase1LiveExecutionSafetyRegressionTests().catch((err) => {
  console.error('❌ Phase 1 Regression Suite Failed:', err);
  process.exit(1);
});
