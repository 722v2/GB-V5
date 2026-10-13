import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { mt5Bridge } from '../server/mt5Bridge.js';
import { fetchHistoricalBacktestDataset, validateHistoricalBacktestDataset } from '../server/marketData.js';
import { runXauusdBacktest } from '../server/backtestEngine.js';
import { Candle } from '../src/types.js';

function computeFileHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function generateMockCandles(count: number, intervalMinutes: number, startTime: number, basePrice = 2500): Candle[] {
  const candles: Candle[] = [];
  const stepMs = intervalMinutes * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const ts = startTime + i * stepMs;
    candles.push({
      timestamp: ts,
      open: basePrice + (i % 5) * 0.1,
      high: basePrice + (i % 5) * 0.1 + 0.5,
      low: basePrice + (i % 5) * 0.1 - 0.5,
      close: basePrice + (i % 5) * 0.1 + 0.2,
      volume: 100 + i,
      isClosed: true,
    });
  }
  return candles;
}

function toBiquoteBar(candle: Candle) {
  return {
    openTime: new Date(candle.timestamp).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    tickVolume: candle.volume,
  };
}

async function runHistoricalDataValidationRegressionTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 5 HISTORICAL DATA VALIDATION REGRESSION TESTS');
  console.log('========================================================================\n');

  let passedCount = 0;
  let totalTests = 0;

  // Snapshot sensitive files before test suite
  const candleFilePath = path.join(process.cwd(), 'server', 'data', 'mt5_candles.json');
  const telegramRetryPath = path.join(process.cwd(), 'data', 'telegram_retry_queue.json');
  const telegramDispatchPath = path.join(process.cwd(), 'data', 'telegram_dispatches.json');

  const candleHashBefore = computeFileHash(candleFilePath);
  const telegramRetryHashBefore = computeFileHash(telegramRetryPath);
  const telegramDispatchHashBefore = computeFileHash(telegramDispatchPath);

  // Preserve original methods
  const originalHasHistoricalCandles = mt5Bridge.hasHistoricalCandles.bind(mt5Bridge);
  const originalGetHistoricalCandles = mt5Bridge.getHistoricalCandles.bind(mt5Bridge);
  const originalFetch = globalThis.fetch;

  let externalFetchCalls = 0;

  try {
    const now = Date.now();
    const oneDayMs = 24 * 3600 * 1000;
    const reqStart = now - oneDayMs;
    const reqEnd = now;

    // -------------------------------------------------------------------------
    // TEST 1: Insufficient MT5 Cache (50 candles ~3.4%) with Sufficient Biquote History
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 1: Insufficient MT5 cache gracefully falls back to full-coverage Biquote');
    {
      // Mock MT5 to return 50 candles spanning only 49 minutes (the exact reported issue)
      const mt55m = generateMockCandles(50, 1, reqEnd - 49 * 60 * 1000); // 49 min span
      mt5Bridge.hasHistoricalCandles = (tf: string) => tf.toUpperCase() === 'M5';
      mt5Bridge.getHistoricalCandles = (tf: string) => {
        if (tf.toUpperCase() === 'M5') return mt55m;
        return [];
      };

      // Mock Biquote fetch to return 288 full candles covering the entire 24h
      const biquote5m = generateMockCandles(289, 5, reqStart - 5 * 60 * 1000);
      const biquote15m = generateMockCandles(97, 15, reqStart - 15 * 60 * 1000);
      const biquote1h = generateMockCandles(25, 60, reqStart - 60 * 60 * 1000);

      globalThis.fetch = async (input: any) => {
        externalFetchCalls++;
        const url = String(input);
        if (url.includes('interval=5m')) {
          return new Response(JSON.stringify({ bars: biquote5m.map(toBiquoteBar).reverse() }), { status: 200 });
        }
        if (url.includes('interval=15m')) {
          return new Response(JSON.stringify({ bars: biquote15m.map(toBiquoteBar).reverse() }), { status: 200 });
        }
        if (url.includes('interval=1h')) {
          return new Response(JSON.stringify({ bars: biquote1h.map(toBiquoteBar).reverse() }), { status: 200 });
        }
        return new Response(JSON.stringify({ bars: [] }), { status: 200 });
      };

      const dataset = await fetchHistoricalBacktestDataset({
        symbol: 'XAUUSD',
        timeRange: '1D',
        requestedStartTime: reqStart,
        requestedEndTime: reqEnd,
      });

      assert.strictEqual(dataset.provider, 'BIQUOTE', 'TEST 1: Provider must fall back to BIQUOTE when MT5 is insufficient');
      assert.strictEqual(dataset.validation.isFullCoverage, true, 'TEST 1: Biquote dataset must satisfy full coverage');
      assert.strictEqual(dataset.validation.status, 'VALID', 'TEST 1: Validation status must be VALID');
      assert(dataset.candles5m.length >= 288, `TEST 1: Expected >= 288 candles, got ${dataset.candles5m.length}`);
      assert(dataset.validation.coverageRatio >= 0.95, `TEST 1: Expected coverage >= 95%, got ${dataset.validation.coverageRatio}`);
      console.log(`✅ [PASS] TEST 1: Fallback succeeded with provider ${dataset.provider} (${dataset.candles5m.length} 5M candles, ${(dataset.validation.coverageRatio * 100).toFixed(1)}% coverage).\n`);
      passedCount++;
    }

    // -------------------------------------------------------------------------
    // TEST 2: Both Providers Insufficient -> Returns Best Coverage & INSUFFICIENT_DATA
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 2: Both providers insufficient -> Preserves INSUFFICIENT_DATA status and accurate coverage');
    {
      // MT5: 50 candles spanning 49m (~3.4% coverage)
      const mt55m = generateMockCandles(50, 1, reqEnd - 49 * 60 * 1000);
      mt5Bridge.hasHistoricalCandles = (tf: string) => tf.toUpperCase() === 'M5';
      mt5Bridge.getHistoricalCandles = (tf: string) => (tf.toUpperCase() === 'M5' ? mt55m : []);

      // Biquote: only 20 candles spanning 100m (~6.9% coverage)
      const biquote5m = generateMockCandles(20, 5, reqEnd - 100 * 60 * 1000);
      globalThis.fetch = async (input: any) => {
        const url = String(input);
        if (url.includes('interval=5m')) {
          return new Response(JSON.stringify({ bars: biquote5m.map(toBiquoteBar).reverse() }), { status: 200 });
        }
        return new Response(JSON.stringify({ bars: [] }), { status: 200 });
      };

      const dataset = await fetchHistoricalBacktestDataset({
        symbol: 'XAUUSD',
        timeRange: '1D',
        requestedStartTime: reqStart,
        requestedEndTime: reqEnd,
      });

      assert.strictEqual(dataset.validation.isFullCoverage, false, 'TEST 2: isFullCoverage must be false');
      assert.strictEqual(dataset.validation.status, 'INSUFFICIENT_DATA', 'TEST 2: status must be INSUFFICIENT_DATA');
      assert(dataset.validation.coverageRatio < 0.20, 'TEST 2: coverage ratio must accurately reflect partial data');
      // Biquote had ~6.9% vs MT5's ~3.4%, so Biquote was chosen as higher coverage candidate
      assert.strictEqual(dataset.provider, 'BIQUOTE', 'TEST 2: Provider with higher coverage selected');
      console.log(`✅ [PASS] TEST 2: Accurately flagged INSUFFICIENT_DATA (Coverage: ${(dataset.validation.coverageRatio * 100).toFixed(1)}%).\n`);
      passedCount++;
    }

    // -------------------------------------------------------------------------
    // TEST 3: MT5 Sufficient (100% coverage) -> Uses MT5 without Biquote Network Fallback
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 3: MT5 sufficient -> Selects MT5_BRIDGE and does not query Biquote');
    {
      const fullMt55m = generateMockCandles(300, 5, reqStart - 10 * 60 * 1000);
      const fullMt51m = generateMockCandles(100, 1, reqEnd - 100 * 60 * 1000);
      mt5Bridge.hasHistoricalCandles = (tf: string) => true;
      mt5Bridge.getHistoricalCandles = (tf: string) => {
        if (tf.toUpperCase() === 'M5') return fullMt55m;
        if (tf.toUpperCase() === 'M1') return fullMt51m;
        return [];
      };

      let biquoteCalled = false;
      globalThis.fetch = async () => {
        biquoteCalled = true;
        return new Response(JSON.stringify({ bars: [] }), { status: 200 });
      };

      const dataset = await fetchHistoricalBacktestDataset({
        symbol: 'XAUUSD',
        timeRange: '1D',
        requestedStartTime: reqStart,
        requestedEndTime: reqEnd,
      });

      assert.strictEqual(dataset.provider, 'MT5_BRIDGE', 'TEST 3: Provider must be MT5_BRIDGE');
      assert.strictEqual(dataset.validation.isFullCoverage, true, 'TEST 3: MT5 dataset must be marked full coverage');
      assert.strictEqual(dataset.validation.status, 'VALID', 'TEST 3: Status must be VALID');
      assert.strictEqual(biquoteCalled, false, 'TEST 3: Biquote should not be queried when MT5 has full coverage');
      console.log(`✅ [PASS] TEST 3: MT5_BRIDGE selected with full coverage without unnecessary network calls.\n`);
      passedCount++;
    }

    // -------------------------------------------------------------------------
    // TEST 4: Empty Provider Responses and Provider Errors -> Fails Closed Cleanly
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 4: Empty provider responses and network errors -> Fails closed without crash');
    {
      mt5Bridge.hasHistoricalCandles = () => false;
      mt5Bridge.getHistoricalCandles = () => null;

      globalThis.fetch = async () => {
        throw new Error('ETIMEDOUT: Connection dropped');
      };

      const dataset = await fetchHistoricalBacktestDataset({
        symbol: 'XAUUSD',
        timeRange: '1D',
        requestedStartTime: reqStart,
        requestedEndTime: reqEnd,
      });

      assert.strictEqual(dataset.validation.isFullCoverage, false, 'TEST 4: isFullCoverage must be false');
      assert.strictEqual(dataset.validation.status, 'INSUFFICIENT_DATA', 'TEST 4: status must be INSUFFICIENT_DATA');
      assert.strictEqual(dataset.validation.coverageRatio, 0, 'TEST 4: coverageRatio must be 0');
      assert.strictEqual(dataset.candles5m.length, 0, 'TEST 4: candles5m must be empty');
      console.log('✅ [PASS] TEST 4: Gracefully returned fail-closed validation dataset on network/provider failure.\n');
      passedCount++;
    }

    // -------------------------------------------------------------------------
    // TEST 5: Accurate Coverage Calculations and Provider Attribution
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 5: Accurate coverage calculations (50% coverage window)');
    {
      mt5Bridge.hasHistoricalCandles = () => false;
      mt5Bridge.getHistoricalCandles = () => null;

      // 12 hours out of 24 hours = 50% coverage
      const halfDayCandles = generateMockCandles(144, 5, reqStart + 12 * 3600 * 1000);
      globalThis.fetch = async (input: any) => {
        const url = String(input);
        if (url.includes('interval=5m')) {
          return new Response(JSON.stringify({ bars: halfDayCandles.map(toBiquoteBar).reverse() }), { status: 200 });
        }
        return new Response(JSON.stringify({ bars: [] }), { status: 200 });
      };

      const dataset = await fetchHistoricalBacktestDataset({
        symbol: 'XAUUSD',
        timeRange: '1D',
        requestedStartTime: reqStart,
        requestedEndTime: reqEnd,
      });

      assert.strictEqual(dataset.provider, 'BIQUOTE', 'TEST 5: Attribution must be BIQUOTE');
      assert.strictEqual(dataset.validation.isFullCoverage, false, 'TEST 5: 50% is not full coverage');
      assert.strictEqual(dataset.validation.status, 'INSUFFICIENT_DATA', 'TEST 5: status is INSUFFICIENT_DATA');
      assert(
        Math.abs(dataset.validation.coverageRatio - 0.5) < 0.05,
        `TEST 5: Expected coverage ~0.50, got ${dataset.validation.coverageRatio}`
      );
      console.log(`✅ [PASS] TEST 5: Accurate coverage math: ${(dataset.validation.coverageRatio * 100).toFixed(1)}%.\n`);
      passedCount++;
    }

    // -------------------------------------------------------------------------
    // TEST 6: Explicit Partial-Slice Behavior with Backtest Engine
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 6: Backtest engine enforces fail-closed by default and allows explicit partial slice');
    {
      // 6A: allowAvailableSlice: false -> Must throw DataValidationError
      let caughtError: any = null;
      try {
        await runXauusdBacktest({
          initialCapital: 10,
          timeRange: '1D',
          allowAvailableSlice: false,
        });
      } catch (err: any) {
        caughtError = err;
      }

      assert(caughtError, 'TEST 6A: Backtest must throw when data is insufficient and allowAvailableSlice is false');
      assert(
        caughtError.message.includes('INSUFFICIENT_HISTORICAL_DATA') || caughtError.validationReport,
        'TEST 6A: Error must be INSUFFICIENT_HISTORICAL_DATA'
      );
      assert.strictEqual(caughtError.validationReport?.isFullCoverage, false, 'TEST 6A: validationReport must show not full coverage');
      console.log('✅ [PASS] TEST 6A: Strict fail-closed confirmed when allowAvailableSlice=false.');

      // 6B: allowAvailableSlice: true -> Proceeds safely without throwing
      const summary = await runXauusdBacktest({
        initialCapital: 10,
        timeRange: '1D',
        allowAvailableSlice: true,
      });

      assert(summary && typeof summary.totalTrades === 'number', 'TEST 6B: Backtest completed with explicit allowAvailableSlice');
      console.log(`✅ [PASS] TEST 6B: Completed partial slice backtest (${summary.totalTrades} trades, win rate: ${summary.winRate}%).\n`);
      passedCount++;
    }

    // -------------------------------------------------------------------------
    // TEST 7: File & Queue Immutability Verification
    // -------------------------------------------------------------------------
    totalTests++;
    console.log('TEST 7: Assert production files and queues remained byte-for-byte unchanged');
    {
      const candleHashAfter = computeFileHash(candleFilePath);
      const telegramRetryHashAfter = computeFileHash(telegramRetryPath);
      const telegramDispatchHashAfter = computeFileHash(telegramDispatchPath);

      assert.strictEqual(candleHashBefore, candleHashAfter, 'TEST 7: server/data/mt5_candles.json must NOT be modified');
      assert.strictEqual(telegramRetryHashBefore, telegramRetryHashAfter, 'TEST 7: telegram_retry_queue.json must NOT be modified');
      assert.strictEqual(telegramDispatchHashBefore, telegramDispatchHashAfter, 'TEST 7: telegram_dispatches.json must NOT be modified');
      console.log('✅ [PASS] TEST 7: Byte-for-byte SHA-256 match confirmed across all persistent files.\n');
      passedCount++;
    }

  } finally {
    // Guaranteed restoration of mocked dependencies
    mt5Bridge.hasHistoricalCandles = originalHasHistoricalCandles;
    mt5Bridge.getHistoricalCandles = originalGetHistoricalCandles;
    globalThis.fetch = originalFetch;
  }

  console.log('========================================================================');
  console.log(`🎉 ALL ${passedCount}/${totalTests} PHASE 5 HISTORICAL DATA VALIDATION TESTS PASSED!`);
  console.log('========================================================================\n');

  if (passedCount !== totalTests) {
    process.exit(1);
  }
}

runHistoricalDataValidationRegressionTests().catch((err) => {
  console.error('❌ Phase 5 Regression Tests Failed:', err);
  process.exit(1);
});
