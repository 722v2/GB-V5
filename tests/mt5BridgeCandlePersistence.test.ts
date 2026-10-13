import fs from 'fs';
import path from 'path';
import { mt5Bridge } from '../server/mt5Bridge.js';
import { fetchHistoricalBacktestDataset } from '../server/marketData.js';
import { Candle } from '../src/types.js';

/**
 * REGRESSION TEST: MT5 Historical Candle Disk Persistence across Server Restarts
 */

async function runMT5CandlePersistenceTest() {
  console.log('========================================================================');
  console.log('🧪 RUNNING REGRESSION TEST: MT5 CANDLE PERSISTENCE ACROSS SERVER RESTARTS');
  console.log('========================================================================\n');

  let passedCount = 0;
  let totalTests = 0;

  // Reset in-memory candle cache for test isolation
  (mt5Bridge as any).candleCache.clear();

  // --------------------------------------------------------------------------
  // TEST 1: Storing MT5 candles persists dataset to disk backup
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    const now = Date.now();
    const mockM5Candles: Candle[] = [];
    const mockM15Candles: Candle[] = [];
    const mockH1Candles: Candle[] = [];

    // Generate 500 mock 5M candles (~1.7 days)
    for (let i = 0; i < 500; i++) {
      const ts = now - (500 - i) * 5 * 60 * 1000;
      mockM5Candles.push({
        timestamp: ts,
        open: 2650.0 + (i % 10),
        high: 2655.0 + (i % 10),
        low: 2645.0 + (i % 10),
        close: 2652.0 + (i % 10),
        volume: 100 + i,
      });
    }

    for (let i = 0; i < 200; i++) {
      const ts = now - (200 - i) * 15 * 60 * 1000;
      mockM15Candles.push({
        timestamp: ts,
        open: 2650.0,
        high: 2655.0,
        low: 2645.0,
        close: 2652.0,
        volume: 200,
      });
    }

    for (let i = 0; i < 100; i++) {
      const ts = now - (100 - i) * 60 * 60 * 1000;
      mockH1Candles.push({
        timestamp: ts,
        open: 2650.0,
        high: 2655.0,
        low: 2645.0,
        close: 2652.0,
        volume: 500,
      });
    }

    mt5Bridge.storeHistoricalCandles('M5', mockM5Candles);
    mt5Bridge.storeHistoricalCandles('M15', mockM15Candles);
    mt5Bridge.storeHistoricalCandles('H1', mockH1Candles);

    const candleFilePath = path.join(process.cwd(), 'server', 'data', 'mt5_candles.json');
    if (fs.existsSync(candleFilePath)) {
      const fileContents = JSON.parse(fs.readFileSync(candleFilePath, 'utf-8'));
      if (fileContents.M5 && fileContents.M5.length === 500) {
        console.log('✅ TEST 1: MT5 historical candles successfully persisted to server/data/mt5_candles.json.');
        passedCount++;
      } else {
        console.error('✖ TEST 1: File contents do not match stored candles count.');
      }
    } else {
      console.error('✖ TEST 1: Persistent file server/data/mt5_candles.json was not created.');
    }
  } catch (err: any) {
    console.error('✖ TEST 1 Exception:', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Re-reading disk file restores MT5 candle cache
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    // Force re-execution of loadCandleCacheFromDisk
    (mt5Bridge as any).candleCache.clear();
    (mt5Bridge as any).loadCandleCacheFromDisk();

    const restoredM5 = mt5Bridge.getHistoricalCandles('M5');
    if (restoredM5 && restoredM5.length === 500) {
      console.log('✅ TEST 2: Restored 500 M5 candles from disk into mt5Bridge.candleCache after simulated server reboot.');
      passedCount++;
    } else {
      console.error('✖ TEST 2: Failed to restore candles from disk.');
    }
  } catch (err: any) {
    console.error('✖ TEST 2 Exception:', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 3: Backtest Engine queries MT5 Bridge provider when candles are present
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    const requestedEndTime = Date.now();
    const requestedStartTime = requestedEndTime - 1 * 24 * 60 * 60 * 1000; // 1D

    const dataset = await fetchHistoricalBacktestDataset({
      symbol: 'XAUUSD',
      timeRange: '1D',
      requestedStartTime,
      requestedEndTime,
    });

    if (dataset.provider === 'MT5_BRIDGE' && dataset.candles5m.length > 0) {
      console.log(`✅ TEST 3: fetchHistoricalBacktestDataset correctly used MT5_BRIDGE provider (${dataset.candles5m.length} 5M candles).`);
      passedCount++;
    } else {
      console.error(`✖ TEST 3: Backtest dataset used provider ${dataset.provider} instead of MT5_BRIDGE.`);
    }
  } catch (err: any) {
    console.error('✖ TEST 3 Exception:', err.message);
  }

  console.log('\n========================================================================');
  console.log(`TEST RESULTS: ${passedCount}/${totalTests} PASSED`);
  console.log('========================================================================');

  if (passedCount !== totalTests) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runMT5CandlePersistenceTest().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
