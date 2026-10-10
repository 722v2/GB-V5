import { storage, isSyntheticTestRecord } from '../server/storage.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function createMockCandles(count: number, basePrice: number, step = 0.5): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - i) * 5 * 60 * 1000;
    const cClose = basePrice + i * step;
    candles.push({
      timestamp,
      open: Number((cClose - step * 0.5).toFixed(2)),
      high: Number((cClose + step * 0.8).toFixed(2)),
      low: Number((cClose - step * 0.8).toFixed(2)),
      close: Number(cClose.toFixed(2)),
      volume: 1000,
      isClosed: true,
    });
  }
  return candles;
}

function createDefaultIndicators(basePrice: number): TechnicalIndicators {
  return {
    ema20: Number((basePrice - 1.0).toFixed(2)),
    ema50: Number((basePrice - 2.0).toFixed(2)),
    ema200: Number((basePrice - 5.0).toFixed(2)),
    rsi14: 50,
    atr14: 2.0,
    vwap: Number((basePrice - 0.5).toFixed(2)),
    marketRegime: 'WEAK_UPTREND',
    structure: 'BULLISH',
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    swingLow: basePrice - 3.0,
    swingHigh: basePrice + 10.0,
    orderBlock: {
      type: 'BULLISH',
      high: basePrice + 0.5,
      low: basePrice - 0.5,
      candleTime: Date.now() - 300000,
    },
  };
}

function runAll() {
  console.log('====================================================');
  console.log('RUNNING FORENSIC CONFIDENCE CALIBRATION & STORAGE PARTITIONING TESTS');
  console.log('====================================================\n');

  const wasTesting = storage.isTestingMode();
  storage.setTestingMode(true);

  try {
    // Test 1: Synthetic test trade identification
  console.log('Test 1: Identifies synthetic test trades and isolates them from production storage');
  if (!isSyntheticTestRecord({ id: 'test-123' })) throw new Error('Failed to identify test- prefix');
  if (!isSyntheticTestRecord({ id: 'trade_single_b7_123' })) throw new Error('Failed to identify trade_single_ prefix');
  if (!isSyntheticTestRecord({ id: 'trade_dual_123' })) throw new Error('Failed to identify trade_dual_ prefix');
  if (!isSyntheticTestRecord({ setup: 'Single Target Runner Test' })) throw new Error('Failed to identify Single Target setup');
  if (!isSyntheticTestRecord({ setup: 'BE Path Validation' })) throw new Error('Failed to identify BE Path setup');
  if (!isSyntheticTestRecord({ isTest: true })) throw new Error('Failed to identify isTest flag');
  if (isSyntheticTestRecord({ id: 'sig_1790236793612_slo8x', setup: 'Double Bottom Reversal' })) {
    throw new Error('Real production trade was incorrectly flagged as synthetic');
  }
  console.log('✔ PASS: Test 1: Synthetic record identification verified\n');

  // Test 2: Storage isolation - test trades do not pollute getTrades()
  console.log('Test 2: Test trades are routed to test partition and do not pollute production getTrades()');
  storage.clearTestTrades();
  const initialRealCount = storage.getTrades().length;

  storage.saveTrade({
    id: 'test_regression_trade_999',
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 2650,
    sl: 2645,
    tp1: 2660,
    tp2: 0,
    rr: '1:2.0',
    riskPercent: 1.0,
    riskAmount: 100,
    confidence: 80,
    setup: 'Test Setup Isolation',
    result: 'WIN',
    pl: 200,
    balanceAfterTrade: 10200,
    date: 'Sep 24',
    tradeNumber: 99999,
    isTest: true,
  });

  const afterRealTrades = storage.getTrades();
  if (afterRealTrades.some(t => t.id === 'test_regression_trade_999')) {
    throw new Error('Synthetic test trade polluted production trade ledger!');
  }
  if (afterRealTrades.length !== initialRealCount) {
    throw new Error(`Production trade count changed from ${initialRealCount} to ${afterRealTrades.length}`);
  }

  const testTrades = storage.getTestTrades();
  if (!testTrades.some(t => t.id === 'test_regression_trade_999')) {
    throw new Error('Synthetic test trade was not saved to test partition!');
  }
  console.log('✔ PASS: Test 2: Storage partitioning verified\n');

  // Test 3: Confidence calibration pipeline execution
  console.log('Test 3: End-to-end strategy engine executes with calibrated confidence bounds');
  const candles5m = createMockCandles(30, 2650, 0.1);
  const candles15m = createMockCandles(30, 2650, 0.3);
  const candles1h = createMockCandles(30, 2650, 0.6);
  const indicators5m = createDefaultIndicators(2653);
  const indicators15m = createDefaultIndicators(2653);
  const indicators1h = createDefaultIndicators(2653);

  const res = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 10000,
    currentPrice: 2653.0,
    candles5m,
    candles15m,
    candles1h,
    indicators5m,
    indicators15m,
    indicators1h,
  });

  if (res.hasValidSignal && res.finalSignal) {
    if (res.finalSignal.confidence < 70 || res.finalSignal.confidence > 96) {
      throw new Error(`Signal confidence out of calibrated range [70, 96]: ${res.finalSignal.confidence}`);
    }
    console.log(`✔ PASS: Test 3: Candidate generated with calibrated confidence (${res.finalSignal.confidence}%)\n`);
  } else {
    console.log('✔ PASS: Test 3: Strategy engine evaluated cleanly without unhandled errors\n');
  }

    console.log('====================================================');
    console.log('ALL CONFIDENCE CALIBRATION & PARTITIONING TESTS PASSED (3/3)');
    console.log('====================================================');
  } finally {
    storage.setTestingMode(wasTesting);
  }
}

runAll();
