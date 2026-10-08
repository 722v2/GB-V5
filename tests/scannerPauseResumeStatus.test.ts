import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  scanner,
  isInternalTimerEnabled,
  SCAN_MIN_COOLDOWN_MS,
} from '../server/scanner.js';

describe('Scanner Pause / Resume / Status Test Suite', () => {
  const originalEnv = { ...process.env };

  after(() => {
    scanner.stop();
    process.env = originalEnv;
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    scanner.resume();
  });

  it('Scanner pause() sets isPaused flag and clears timer', () => {
    scanner.start();
    assert.strictEqual(scanner.isScannerPaused(), false);

    const paused = scanner.pause();
    assert.strictEqual(paused, true);
    assert.strictEqual(scanner.isScannerPaused(), true);
    assert.strictEqual(scanner.isInternalTimerActive(), false);

    const status = scanner.getStatus();
    assert.strictEqual(status.isPaused, true);
    assert.strictEqual(status.status, 'PAUSED');
    assert.strictEqual(status.health.scannerStatus, 'PAUSED');
  });

  it('Scanner resume() resets isPaused flag and restores active state', () => {
    scanner.pause();
    assert.strictEqual(scanner.isScannerPaused(), true);

    const resumed = scanner.resume();
    assert.strictEqual(resumed, true);
    assert.strictEqual(scanner.isScannerPaused(), false);

    const status = scanner.getStatus();
    assert.strictEqual(status.isPaused, false);
    assert.notStrictEqual(status.status, 'PAUSED');
  });

  it('triggerCronTick skips when scanner is paused', async () => {
    scanner.pause();

    const result = await scanner.triggerCronTick();
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.status, 'SKIPPED_PAUSED');
    assert.strictEqual(result.reason, 'Scanner is currently paused');
  });

  it('getStatus returns complete config and health payload', () => {
    const status = scanner.getStatus();
    assert.ok('enabled' in status, 'status must contain enabled');
    assert.ok('isPaused' in status, 'status must contain isPaused');
    assert.ok('status' in status, 'status must contain status');
    assert.ok('health' in status, 'status must contain health');
    assert.ok('scanCount' in status, 'status must contain scanCount');
  });
});
