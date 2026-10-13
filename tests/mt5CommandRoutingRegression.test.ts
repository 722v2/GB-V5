import assert from 'assert';
import { MT5BridgeService } from '../server/mt5Bridge.js';

async function runMt5CommandRoutingTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING MT5 COMMAND ROUTING & SAFETY REGRESSION TESTS');
  console.log('========================================================================\n');

  const bridge = new MT5BridgeService({ isIsolatedTest: true });

  // Mock bridge availability and specs
  (bridge as any).lastStatus = {
    connected: true,
    status: 'CONNECTED',
    balance: 10000,
    equity: 10000,
    freeMargin: 10000,
    currency: 'USD',
    accountMode: 'DEMO',
    tradeMode: 0,
    lastUpdated: Date.now(),
    statusMessage: 'Connected',
    brokerSpecsValid: true,
  };

  (bridge as any).symbolSpecs = {
    symbol: 'XAUUSD',
    volumeMin: 0.01,
    volumeMax: 50.0,
    volumeStep: 0.01,
    stopsLevel: 10,
    isValid: true,
  };

  // Test 1: MODIFY creates MODIFY action with ticket, never BUY/SELL
  console.log('TEST 1: MODIFY creates explicit MODIFY command targeting ticket');
  const modRes = await bridge.modifyOrder({
    ticket: 10001,
    stopLoss: 2490.0,
    takeProfit: 2520.0,
    accountMode: 'DEMO',
  });
  assert.strictEqual(modRes.success, true);
  assert.ok(modRes.commandId);
  const modCmd = (bridge as any).commands.get(modRes.commandId);
  assert.strictEqual(modCmd.action, 'MODIFY');
  assert.strictEqual(modCmd.ticket, 10001);
  assert.strictEqual(modCmd.sl, 2490.0);
  assert.strictEqual(modCmd.tp, 2520.0);
  assert.strictEqual(modCmd.volume, 0); // No volume/direction deal!
  console.log('  ✅ [PASS] TEST 1: MODIFY command created cleanly without market deal parameters.\n');

  // Test 2: CLOSE creates explicit CLOSE command targeting ticket
  console.log('TEST 2: CLOSE creates explicit CLOSE command targeting ticket');
  const clsRes = await bridge.closeOrder({
    ticket: 10002,
    lot: 0.05,
    accountMode: 'DEMO',
  });
  assert.strictEqual(clsRes.success, true);
  assert.ok(clsRes.commandId);
  const clsCmd = (bridge as any).commands.get(clsRes.commandId);
  assert.strictEqual(clsCmd.action, 'CLOSE');
  assert.strictEqual(clsCmd.ticket, 10002);
  assert.strictEqual(clsCmd.volume, 0.05);
  console.log('  ✅ [PASS] TEST 2: CLOSE command created cleanly with specified partial lot volume.\n');

  // Test 3: Invalid ticket <= 0 fails closed
  console.log('TEST 3: Invalid ticket <= 0 fails closed');
  const invalidMod = await bridge.modifyOrder({ ticket: 0, stopLoss: 2490.0 });
  assert.strictEqual(invalidMod.success, false);
  assert.ok(invalidMod.reason?.includes('غير صالحة'));

  const invalidCls = await bridge.closeOrder({ ticket: -5 });
  assert.strictEqual(invalidCls.success, false);
  assert.ok(invalidCls.reason?.includes('غير صالحة'));
  console.log('  ✅ [PASS] TEST 3: Invalid tickets rejected safely.\n');

  // Test 4: Idempotency check prevents duplicate command queueing
  console.log('TEST 4: Idempotent duplicate commandId returns existing result without duplicate queue');
  const customId = 'cmd_idem_123';
  const firstRes = await bridge.closeOrder({ ticket: 10003, lot: 0.01, commandId: customId });
  assert.strictEqual(firstRes.success, true);
  assert.strictEqual(firstRes.commandId, customId);

  const duplicateRes = await bridge.closeOrder({ ticket: 10003, lot: 0.01, commandId: customId });
  assert.strictEqual(duplicateRes.success, true);
  assert.strictEqual(duplicateRes.commandId, customId);
  assert.strictEqual(duplicateRes.message, 'Command already queued or executed');
  console.log('  ✅ [PASS] TEST 4: Idempotency verified.\n');

  // Test 5: Volume validation for partial close
  console.log('TEST 5: Partial close volume validation against broker specs');
  const invalidVol = await bridge.closeOrder({ ticket: 10004, lot: 0.001 }); // Below min 0.01
  assert.strictEqual(invalidVol.success, false);
  assert.ok(invalidVol.reason?.includes('أقل من الحد الأدنى'));
  console.log('  ✅ [PASS] TEST 5: Volume validation rejects volume below broker min.\n');

  // Test 6: Kill switch guard rejects modification & closing
  console.log('TEST 6: Kill-Switch blocks MODIFY and CLOSE');
  (bridge as any).activateKillSwitch('Manual test emergency stop');
  const ksMod = await bridge.modifyOrder({ ticket: 10005, stopLoss: 2490.0 });
  assert.strictEqual(ksMod.success, false);
  assert.ok(ksMod.reason?.includes('Kill-Switch'));

  const ksCls = await bridge.closeOrder({ ticket: 10005 });
  assert.strictEqual(ksCls.success, false);
  assert.ok(ksCls.reason?.includes('Kill-Switch'));
  console.log('  ✅ [PASS] TEST 6: Kill switch successfully blocks modify & close operations.\n');

  // Test 7: Status query for position and command
  console.log('TEST 7: Status query returns accurate position/command state');
  (bridge as any).killSwitchActivated = false; // Reset kill switch
  const statRes = await bridge.getOrderStatus(10001);
  assert.strictEqual(statRes.success, true);
  assert.strictEqual(statRes.status, 'PENDING');
  assert.strictEqual(statRes.command?.action, 'MODIFY');

  const missingStat = await bridge.getOrderStatus(999999);
  assert.strictEqual(missingStat.success, false);
  console.log('  ✅ [PASS] TEST 7: Status query verified.\n');

  console.log('========================================================================');
  console.log('🎉 ALL MT5 COMMAND ROUTING & SAFETY REGRESSION TESTS PASSED (7/7)!');
  console.log('========================================================================\n');
}

runMt5CommandRoutingTests().catch((err) => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
