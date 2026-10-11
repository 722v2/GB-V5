import { scanner } from '../server/scanner.js';
import { storage } from '../server/storage.js';

/**
 * REGRESSION TEST SUITE: Manual Scanner Trigger & Cooldown Bypass
 * 
 * Target Bug: Manual "Scan Now" button failed to trigger scans because `triggerManualScan(force = false)`
 * checked `elapsed < 45s` against the 24/7 background worker, silently skipping execution.
 */

async function runManualScanTriggerRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING REGRESSION TEST SUITE: MANUAL SCAN TRIGGER & COOLDOWN BYPASS');
  console.log('========================================================================\n');

  let passedCount = 0;
  let totalTests = 0;

  // Initialize storage
  storage.getSettings();

  // --------------------------------------------------------------------------
  // TEST 1: Manual Scan Trigger Bypasses Background Cooldown (force = true)
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    // Simulate that a background scan finished 5 seconds ago (well within 45s cooldown)
    (scanner as any).lastScanCompletedTime = Date.now() - 5000;
    (scanner as any).isScanRunning = false;

    const initialScanCount = (scanner as any).config.scanCount;

    // Trigger manual scan (default force = true)
    const signal = await scanner.triggerManualScan(true);

    const newScanCount = (scanner as any).config.scanCount;

    if (newScanCount > initialScanCount && signal !== null) {
      console.log('✅ TEST 1: Manual scan trigger successfully bypassed 45s cooldown and executed scan.');
      console.log(`   Scan count incremented from ${initialScanCount} -> ${newScanCount}, Signal: ${signal.signal}`);
      passedCount++;
    } else {
      console.error(`✖ TEST 1: Manual scan failed to execute during active cooldown. Initial count: ${initialScanCount}, New count: ${newScanCount}`);
    }
  } catch (err: any) {
    console.error('✖ TEST 1 Exception:', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Duplicate Concurrent Scan In-Flight Protection
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    // Simulate an active scan in progress (less than 45s duration)
    (scanner as any).isScanRunning = true;
    (scanner as any).scanStartTime = Date.now() - 5000;

    const countBefore = (scanner as any).config.scanCount;

    // Second trigger attempt while scan is in flight
    await scanner.triggerManualScan(true);

    const countAfter = (scanner as any).config.scanCount;

    if (countBefore === countAfter) {
      console.log('✅ TEST 2: Duplicate concurrent manual scan correctly skipped while scan is in-flight.');
      passedCount++;
    } else {
      console.error('✖ TEST 2: Duplicate concurrent scan was allowed while scan was in-flight.');
    }
  } catch (err: any) {
    console.error('✖ TEST 2 Exception:', err.message);
  } finally {
    (scanner as any).isScanRunning = false;
  }

  // --------------------------------------------------------------------------
  // TEST 3: Clearing Stuck Scan Lock (> 45s duration)
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    // Simulate a stuck scan lock older than 45s (e.g. 50s ago)
    (scanner as any).isScanRunning = true;
    (scanner as any).scanStartTime = Date.now() - 50000;

    const countBefore = (scanner as any).config.scanCount;

    // Trigger manual scan which should clear stuck lock and run
    const signal = await scanner.triggerManualScan(true);

    const countAfter = (scanner as any).config.scanCount;

    if (countAfter > countBefore && signal !== null) {
      console.log('✅ TEST 3: Stuck scan lock (>45s) automatically cleared and fresh scan executed.');
      passedCount++;
    } else {
      console.error('✖ TEST 3: Failed to clear stuck scan lock.');
    }
  } catch (err: any) {
    console.error('✖ TEST 3 Exception:', err.message);
  } finally {
    (scanner as any).isScanRunning = false;
  }

  // --------------------------------------------------------------------------
  // TEST 4: Persistence Verification for NO TRADE / BUY / SELL Signals
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    (scanner as any).isScanRunning = false;
    (scanner as any).lastScanCompletedTime = 0;

    const scansBefore = storage.getScans().length;
    const signalsBefore = storage.getSignals().length;

    const signal = await scanner.triggerManualScan(true);

    const scansAfter = storage.getScans().length;
    const signalsAfter = storage.getSignals().length;
    const lastSignal = scanner.getConfig().lastSignal;

    if ((scansAfter > scansBefore || signalsAfter > signalsBefore || lastSignal !== null) && signal !== null) {
      console.log(`✅ TEST 4: Manual scan result properly persisted in storage. Signal: ${signal.signal}, LastSignal in config: ${lastSignal?.signal}`);
      passedCount++;
    } else {
      console.error('✖ TEST 4: Manual scan failed to persist in storage.');
    }
  } catch (err: any) {
    console.error('✖ TEST 4 Exception:', err.message);
  }

  console.log('\n========================================================================');
  console.log(`TEST RESULTS: ${passedCount}/${totalTests} PASSED`);
  console.log('========================================================================');

  // Stop background timer to exit process cleanly
  scanner.stop();

  if (passedCount !== totalTests) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runManualScanTriggerRegressionTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  scanner.stop();
  process.exit(1);
});
