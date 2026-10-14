import { analyzeTechnicals, hasConfirmedReversalStructure } from '../server/indicators.js';
import { extractSessionExtremes } from '../server/strategyEngine.js';
import { PoiFreshnessTracker } from '../server/tradeQualityEngine.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function generateBaseCandles(count: number = 50, startPrice: number = 2000, trend: number = 0): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - count * 300000;
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (i % 2 === 0 ? 0.8 : -0.6) + trend;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    price = close;

    candles.push({
      timestamp: baseTime + i * 300000,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1000,
      isClosed: true,
    });
  }
  return candles;
}

function runTests() {
  console.log('====================================================');
  console.log('RUNNING STRATEGY QUALITY PHASE 2-14 REGRESSION TESTS');
  console.log('====================================================\n');

  // Test 1: Structured structureEvent field population
  const candles = generateBaseCandles(40, 2000, 0.2);
  const indicators = analyzeTechnicals(candles);
  if (!indicators.structureEvent) {
    throw new Error('structureEvent should be populated on TechnicalIndicators');
  }
  const validEvents = ['NONE', 'BULLISH_BOS', 'BEARISH_BOS', 'BULLISH_CHOCH', 'BEARISH_CHOCH', 'BULLISH_MSS_SWEEP', 'BEARISH_MSS_SWEEP'];
  if (!validEvents.includes(indicators.structureEvent)) {
    throw new Error(`Invalid structureEvent value: ${indicators.structureEvent}`);
  }
  console.log(`✔ PASS: Test 1: Populates structured structureEvent field (${indicators.structureEvent})`);

  // Test 2: hasConfirmedReversalStructure uses structured structureEvent
  const mockIndicatorsBull: Partial<TechnicalIndicators> = {
    structureEvent: 'BULLISH_MSS_SWEEP',
    mssDetected: true,
    mssDirection: 'BULLISH',
  };
  const resultBull = hasConfirmedReversalStructure(
    'BUY',
    mockIndicatorsBull as TechnicalIndicators,
    mockIndicatorsBull as TechnicalIndicators,
    [],
    [],
    2.0
  );
  if (!resultBull) {
    throw new Error('hasConfirmedReversalStructure failed for BULLISH_MSS_SWEEP');
  }

  const mockIndicatorsBear: Partial<TechnicalIndicators> = {
    structureEvent: 'BEARISH_CHOCH',
    chochDetected: true,
  };
  const resultBear = hasConfirmedReversalStructure(
    'SELL',
    mockIndicatorsBear as TechnicalIndicators,
    mockIndicatorsBear as TechnicalIndicators,
    [],
    [],
    2.0
  );
  if (!resultBear) {
    throw new Error('hasConfirmedReversalStructure failed for BEARISH_CHOCH');
  }
  console.log('✔ PASS: Test 2: hasConfirmedReversalStructure checks structured structureEvent correctly');

  // Test 3: UTC-based Session Extremes
  const baseUtcTime = new Date('2026-03-30T00:00:00Z').getTime();
  const sessionCandles: Candle[] = [];

  for (let i = 0; i < 288; i++) {
    const time = baseUtcTime + i * 300000;
    const hour = new Date(time).getUTCHours();
    let high = 2000;
    let low = 1990;

    // Asian session (00:00 - 08:00 UTC)
    if (hour >= 0 && hour < 7) {
      high = 2010;
      low = 1980;
    }
    // London session (07:00 - 15:00 UTC)
    if (hour >= 8 && hour < 15) {
      high = 2030;
      low = 1970;
    }

    sessionCandles.push({
      timestamp: time,
      open: 1995,
      high,
      low,
      close: 1995,
      volume: 100,
      isClosed: true,
    });
  }

  const extremes = extractSessionExtremes(sessionCandles);
  if (extremes.sessionHigh !== 2030 || extremes.sessionLow !== 1970) {
    throw new Error(`Incorrect session overall extremes: ${extremes.sessionHigh}/${extremes.sessionLow}`);
  }
  if (extremes.asianHigh !== 2010 || extremes.asianLow !== 1980) {
    throw new Error(`Incorrect Asian session extremes: ${extremes.asianHigh}/${extremes.asianLow}`);
  }
  if (extremes.londonHigh !== 2030 || extremes.londonLow !== 1970) {
    throw new Error(`Incorrect London session extremes: ${extremes.londonHigh}/${extremes.londonLow}`);
  }
  console.log('✔ PASS: Test 3: extractSessionExtremes calculates exact UTC session boundaries');

  // Test 4: PoiFreshnessTracker POI mitigation lifecycle and tap limits
  const tracker = new PoiFreshnessTracker([]);
  const createdTime = Date.now() - 3600000;

  const poi = tracker.registerPoi(
    'ORDER_BLOCK',
    '15M',
    'BULLISH',
    2005,
    1995,
    createdTime
  );

  if (poi.state !== 'FRESH') throw new Error('New POI should be FRESH');

  const testCandle1: Candle = {
    timestamp: createdTime + 300000,
    open: 2010,
    high: 2012,
    low: 2000,
    close: 2008,
    volume: 500,
    isClosed: true,
  };

  const eval1 = tracker.evaluatePoiFreshness(poi.id, [testCandle1], 2008, 2.0);
  if (eval1.state !== 'TESTED_ONCE' || eval1.tapCount !== 1 || !eval1.isTradable) {
    throw new Error('First test failed in POI freshness evaluation');
  }

  const testCandle2: Candle = {
    timestamp: createdTime + 600000,
    open: 2008,
    high: 2009,
    low: 1998,
    close: 2006,
    volume: 500,
    isClosed: true,
  };

  const eval2 = tracker.evaluatePoiFreshness(poi.id, [testCandle1, testCandle2], 2006, 2.0);
  if (eval2.state !== 'TESTED_TWICE' || eval2.tapCount !== 2) {
    throw new Error('Second test failed in POI freshness evaluation');
  }

  const testCandle3: Candle = {
    timestamp: createdTime + 900000,
    open: 2006,
    high: 2007,
    low: 1996,
    close: 2004,
    volume: 500,
    isClosed: true,
  };

  const eval3 = tracker.evaluatePoiFreshness(poi.id, [testCandle1, testCandle2, testCandle3], 2004, 2.0);
  if (eval3.state !== 'EXHAUSTED' || eval3.isTradable !== false) {
    throw new Error('Third test failed to set state to EXHAUSTED');
  }
  console.log('✔ PASS: Test 4: PoiFreshnessTracker handles POI mitigation lifecycle and tap limits accurately');

  console.log('\n====================================================');
  console.log('ALL STRATEGY QUALITY PHASE 2-14 REGRESSION TESTS PASSED (4/4)');
  console.log('====================================================');
}

runTests();
