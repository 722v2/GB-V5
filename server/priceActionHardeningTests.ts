import { assessPriceActionTrigger, validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { generateMultiStrategyCandidates } from './strategyEngine.js';
import { Candle, TechnicalIndicators, StrategyFamily } from '../src/types.js';

console.log('================================================================');
console.log('      PRICE ACTION HARD-BLOCK REGRESSION TEST SUITE (16 TESTS)  ');
console.log('================================================================\n');

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`✗ FAIL: ${testName}`);
    if (detail) console.error(`  Details: ${detail}`);
    failedTests++;
  }
}

const now = Date.now() - 100 * 300000;
const createCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed: boolean = true
): Candle => ({
  timestamp: now + i * 300000,
  open,
  high,
  low,
  close,
  volume: 1000,
  isClosed,
});

function createCandleArray(count: number = 20, basePrice: number = 4345, lowPrice?: number, highPrice?: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    let p = basePrice + (i % 2 === 0 ? 0.2 : -0.2);
    let l = p - 0.8;
    let h = p + 0.8;
    if (i === 0 && lowPrice !== undefined) l = lowPrice;
    if (i === 0 && highPrice !== undefined) h = highPrice;
    return createCandle(i, p, h, l, p + 0.1, true);
  });
}

function createBaseIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    ema20: 4345.0,
    ema50: 4348.0,
    ema200: 4355.0,
    vwap: 4345.5,
    rsi14: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    atr14: 2.5,
    bollingerBands: { upper: 4370, middle: 4345, lower: 4320 },
    swingHigh: 4370.0,
    swingLow: 4320.0,
    support: 4320.0,
    resistance: 4370.0,
    structure: 'BEARISH',
    marketRegime: 'STRONG_DOWNTREND',
    premiumDiscountZone: 'PREMIUM',
    ...overrides,
  };
}

const defaultBrokerSpecs = {
  minRr: 1.0,
  minGoldSlPoints: 35,
  maxGoldSlPoints: 65,
  minSlPoints: 35,
  maxSlPoints: 65,
  spread: 0.2,
};

async function runAll16RegressionTests() {
  // =========================================================================
  // TEST 1: SELL + "isBear=true" only + no strong rejection => BLOCKED
  // =========================================================================
  console.log('\n[TEST 1] SELL + "isBear=true" only + no strong rejection');
  {
    const c5m = createCandleArray(20, 4345);
    // Candle 19 is simply bearish (close < open) but has tiny upper wick and tiny body (no rejection/engulfing/displacement)
    c5m[18] = createCandle(18, 4345.5, 4346.0, 4345.0, 4345.3, true);
    c5m[19] = createCandle(19, 4345.5, 4345.7, 4344.6, 4344.8, true); // body=0.7, upperWick=0.2, lowerWick=0.2, totalRange=1.1
    const ind5m = createBaseIndicators({ atr14: 2.5 });

    const trigger = assessPriceActionTrigger('SELL', c5m, [], ind5m);
    assert(
      !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 1A: assessPriceActionTrigger MUST return hasHardPriceActionTrigger=false for weak isBear candle',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}, hasTrigger=${trigger.hasTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.8,
        stopLoss: 4348.5,
        tp1: 4339.0,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.8,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 1B: SELL + isBear only MUST be REJECTED with MISSING_PRICE_ACTION_TRIGGER',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 2: BUY + "isBull=true" only + no strong rejection => BLOCKED
  // =========================================================================
  console.log('\n[TEST 2] BUY + "isBull=true" only + no strong rejection');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 is simply bullish (close > open) but has tiny lower wick and modest body
    c5m[18] = createCandle(18, 4344.5, 4345.0, 4344.2, 4344.6, true);
    c5m[19] = createCandle(19, 4344.6, 4345.4, 4344.4, 4345.2, true); // body=0.6, lowerWick=0.2, upperWick=0.2
    const ind5m = createBaseIndicators({ atr14: 2.5, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' });

    const trigger = assessPriceActionTrigger('BUY', c5m, [], ind5m);
    assert(
      !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 2A: assessPriceActionTrigger MUST return hasHardPriceActionTrigger=false for weak isBull candle',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}, hasTrigger=${trigger.hasTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 4345.2,
        stopLoss: 4341.0,
        tp1: 4351.0,
        setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4344.0,
      },
      {
        currentPrice: 4345.2,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', premiumDiscountZone: 'DISCOUNT' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 2B: BUY + isBull only MUST be REJECTED with MISSING_PRICE_ACTION_TRIGGER',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 3: SELL + price below EMA20 + bullish/neutral candle + no bearish rejection => BLOCKED
  // =========================================================================
  console.log('\n[TEST 3] SELL + price below EMA20 + bullish/neutral candle + no bearish rejection');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Price below EMA20 (4350.0), but candle is small green candle (open 4344.0, close 4344.6)
    c5m[18] = createCandle(18, 4343.8, 4344.5, 4343.5, 4344.0, true);
    c5m[19] = createCandle(19, 4344.0, 4344.8, 4343.8, 4344.6, true);
    const ind5m = createBaseIndicators({ ema20: 4350.0, atr14: 2.5 });

    const trigger = assessPriceActionTrigger('SELL', c5m, [], ind5m);
    assert(
      !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 3A: price below EMA20 alone CANNOT satisfy hard price action trigger for SELL',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.6,
        stopLoss: 4349.0,
        tp1: 4338.0,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.6,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 3B: SELL + price below EMA20 + neutral candle MUST be REJECTED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 4: BUY + price above EMA20 + bearish/neutral candle + no bullish rejection => BLOCKED
  // =========================================================================
  console.log('\n[TEST 4] BUY + price above EMA20 + bearish/neutral candle + no bullish rejection');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Price above EMA20 (4340.0), but candle is small red candle
    c5m[18] = createCandle(18, 4345.5, 4346.0, 4345.0, 4345.8, true);
    c5m[19] = createCandle(19, 4345.8, 4346.0, 4345.0, 4345.2, true);
    const ind5m = createBaseIndicators({ ema20: 4340.0, atr14: 2.5, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' });

    const trigger = assessPriceActionTrigger('BUY', c5m, [], ind5m);
    assert(
      !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 4A: price above EMA20 alone CANNOT satisfy hard price action trigger for BUY',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 4345.2,
        stopLoss: 4341.0,
        tp1: 4351.0,
        setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4344.0,
      },
      {
        currentPrice: 4345.2,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', premiumDiscountZone: 'DISCOUNT' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 4B: BUY + price above EMA20 + neutral candle MUST be REJECTED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 5: SELL + MICRO_BOS only => BLOCKED
  // =========================================================================
  console.log('\n[TEST 5] SELL + MICRO_BOS only');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 is tiny neutral candle without rejection/engulfing/displacement (upper wick < 0.6)
    c5m[18] = createCandle(18, 4345.2, 4345.5, 4344.9, 4345.0, true);
    c5m[19] = createCandle(19, 4345.0, 4345.3, 4344.7, 4344.9, true);

    // 1M candles showing micro BOS (recent 1m breaks below previous 1m lows)
    const c1m: Candle[] = [
      createCandle(0, 4345.6, 4345.8, 4345.4, 4345.5, true),
      createCandle(1, 4345.5, 4345.6, 4345.2, 4345.3, true),
      createCandle(2, 4345.3, 4345.5, 4345.1, 4345.2, true),
      createCandle(3, 4345.2, 4345.3, 4345.0, 4345.1, true),
      createCandle(4, 4345.0, 4345.0, 4344.5, 4344.6, true), // breaks below prev low (4345.0)
    ];

    const ind5m = createBaseIndicators({ atr14: 2.5 });
    const trigger = assessPriceActionTrigger('SELL', c5m, c1m, ind5m);

    assert(
      trigger.allTriggers.includes('MICRO_BOS') && !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 5A: MICRO_BOS alone sets allTriggers=[MICRO_BOS] but hasHardPriceActionTrigger=false and hasTrigger=false',
      `allTriggers=${trigger.allTriggers.join(',')}, hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.6,
        stopLoss: 4348.6,
        tp1: 4339.0,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.6,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        candles1m: c1m,
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 5B: SELL with MICRO_BOS only MUST be BLOCKED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 6: BUY + MICRO_BOS only => BLOCKED
  // =========================================================================
  console.log('\n[TEST 6] BUY + MICRO_BOS only');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 is tiny neutral candle without rejection/engulfing/displacement
    c5m[18] = createCandle(18, 4344.8, 4345.1, 4344.5, 4345.0, true);
    c5m[19] = createCandle(19, 4345.0, 4345.3, 4344.7, 4345.1, true);

    // 1M candles showing micro BOS (recent 1m breaks above previous 1m highs)
    const c1m: Candle[] = [
      createCandle(0, 4344.5, 4344.8, 4344.4, 4344.6, true),
      createCandle(1, 4344.6, 4344.9, 4344.5, 4344.7, true),
      createCandle(2, 4344.7, 4345.0, 4344.6, 4344.8, true),
      createCandle(3, 4344.8, 4345.0, 4344.7, 4344.9, true),
      createCandle(4, 4345.0, 4345.6, 4344.9, 4345.5, true), // breaks above prev high (4345.0)
    ];

    const ind5m = createBaseIndicators({ atr14: 2.5, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' });
    const trigger = assessPriceActionTrigger('BUY', c5m, c1m, ind5m);

    assert(
      trigger.allTriggers.includes('MICRO_BOS') && !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 6A: MICRO_BOS alone sets allTriggers=[MICRO_BOS] but hasHardPriceActionTrigger=false and hasTrigger=false',
      `allTriggers=${trigger.allTriggers.join(',')}, hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 4345.5,
        stopLoss: 4341.0,
        tp1: 4352.0,
        setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4344.0,
      },
      {
        currentPrice: 4345.5,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        candles1m: c1m,
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', premiumDiscountZone: 'DISCOUNT' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 6B: BUY with MICRO_BOS only MUST be BLOCKED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 7: SELL + closed bearish top rejection => ALLOWED
  // =========================================================================
  console.log('\n[TEST 7] SELL + closed bearish top rejection');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 closed with dominant top rejection wick:
    // open=4346.0, high=4349.5, low=4344.8, close=4345.0. upperWick=3.5, body=1.0, lowerWick=0.2, totalRange=4.7
    c5m[18] = createCandle(18, 4345.0, 4347.0, 4344.5, 4346.0, true);
    c5m[19] = createCandle(19, 4346.0, 4349.5, 4344.8, 4345.0, true);
    const ind5m = createBaseIndicators({ atr14: 2.5 });

    const trigger = assessPriceActionTrigger('SELL', c5m, [], ind5m);
    assert(
      trigger.hasHardPriceActionTrigger && trigger.primaryTrigger === 'REJECTION_WICK',
      'Test 7A: assessPriceActionTrigger MUST identify REJECTION_WICK hard trigger',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}, primaryTrigger=${trigger.primaryTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4345.0,
        stopLoss: 4349.8,
        tp1: 4337.0,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 85,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4345.0,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH', premiumDiscountZone: 'PREMIUM' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      val.isValid,
      'Test 7B: SELL + closed bearish top rejection MUST be ALLOWED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 8: BUY + closed bullish bottom rejection => ALLOWED
  // =========================================================================
  console.log('\n[TEST 8] BUY + closed bullish bottom rejection');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 closed with dominant bottom rejection wick:
    // open=4344.0, high=4345.2, low=4340.5, close=4345.0. lowerWick=3.5, body=1.0, upperWick=0.2, totalRange=4.7
    c5m[18] = createCandle(18, 4345.0, 4345.5, 4343.0, 4344.0, true);
    c5m[19] = createCandle(19, 4344.0, 4345.2, 4340.5, 4345.0, true);
    const ind5m = createBaseIndicators({ atr14: 2.5, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' });

    const trigger = assessPriceActionTrigger('BUY', c5m, [], ind5m);
    assert(
      trigger.hasHardPriceActionTrigger && trigger.primaryTrigger === 'REJECTION_WICK',
      'Test 8A: assessPriceActionTrigger MUST identify REJECTION_WICK hard trigger for BUY',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}, primaryTrigger=${trigger.primaryTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 4345.0,
        stopLoss: 4340.2,
        tp1: 4353.0,
        setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 85,
        poiPrice: 4344.0,
      },
      {
        currentPrice: 4345.0,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', premiumDiscountZone: 'DISCOUNT' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      val.isValid,
      'Test 8B: BUY + closed bullish bottom rejection MUST be ALLOWED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 9: SELL + bearish engulfing + closed candle => ALLOWED
  // =========================================================================
  console.log('\n[TEST 9] SELL + bearish engulfing + closed candle');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 18 green, Candle 19 closed large red body engulfing previous
    c5m[18] = createCandle(18, 4345.0, 4347.0, 4344.8, 4346.5, true);
    c5m[19] = createCandle(19, 4347.0, 4347.2, 4343.8, 4344.0, true); // body=3.0, totalRange=3.4
    const ind5m = createBaseIndicators({ atr14: 2.5 });

    const trigger = assessPriceActionTrigger('SELL', c5m, [], ind5m);
    assert(
      trigger.hasHardPriceActionTrigger && (trigger.allTriggers.includes('ENGULFING') || trigger.allTriggers.includes('DISPLACEMENT_CANDLE')),
      'Test 9A: assessPriceActionTrigger MUST identify ENGULFING / DISPLACEMENT hard trigger for SELL',
      `allTriggers=${trigger.allTriggers.join(',')}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.0,
        stopLoss: 4348.5,
        tp1: 4337.0,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 85,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.0,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH', premiumDiscountZone: 'PREMIUM' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      val.isValid,
      'Test 9B: SELL + closed bearish engulfing MUST be ALLOWED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 10: BUY + bullish engulfing + closed candle => ALLOWED
  // =========================================================================
  console.log('\n[TEST 10] BUY + bullish engulfing + closed candle');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 18 red, Candle 19 closed large green body engulfing previous
    c5m[18] = createCandle(18, 4345.0, 4345.2, 4343.0, 4343.5, true);
    c5m[19] = createCandle(19, 4343.2, 4346.5, 4343.0, 4346.2, true); // body=3.0, totalRange=3.5
    const ind5m = createBaseIndicators({ atr14: 2.5, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' });

    const trigger = assessPriceActionTrigger('BUY', c5m, [], ind5m);
    assert(
      trigger.hasHardPriceActionTrigger && (trigger.allTriggers.includes('ENGULFING') || trigger.allTriggers.includes('DISPLACEMENT_CANDLE')),
      'Test 10A: assessPriceActionTrigger MUST identify ENGULFING / DISPLACEMENT hard trigger for BUY',
      `allTriggers=${trigger.allTriggers.join(',')}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 4346.2,
        stopLoss: 4341.5,
        tp1: 4353.5,
        setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 85,
        poiPrice: 4344.0,
      },
      {
        currentPrice: 4346.2,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', premiumDiscountZone: 'DISCOUNT' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      val.isValid,
      'Test 10B: BUY + closed bullish engulfing MUST be ALLOWED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 11: SELL + forming/unclosed rejection candle => BLOCKED
  // =========================================================================
  console.log('\n[TEST 11] SELL + forming/unclosed rejection candle');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 18 is closed normal candle with NO rejection
    c5m[18] = createCandle(18, 4345.0, 4345.5, 4344.5, 4345.0, true);
    // Candle 19 has a massive top wick BUT is UNCLOSED (forming)
    c5m[19] = createCandle(19, 4345.0, 4349.5, 4344.5, 4344.8, false);
    const ind5m = createBaseIndicators({ atr14: 2.5 });

    const trigger = assessPriceActionTrigger('SELL', c5m, [], ind5m);
    assert(
      !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 11A: Unclosed forming candle CANNOT trigger price action trigger (evaluated on candle 18 which has no rejection)',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.8,
        stopLoss: 4349.8,
        tp1: 4338.0,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.8,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 11B: Forming unclosed rejection candle MUST be REJECTED',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 12: BUY + forming/unclosed rejection candle => BLOCKED
  // =========================================================================
  console.log('\n[TEST 12] BUY + forming/unclosed rejection candle');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 18 is closed normal candle with NO rejection
    c5m[18] = createCandle(18, 4345.0, 4345.5, 4344.5, 4345.0, true);
    // Candle 19 has a massive bottom wick BUT is UNCLOSED (forming)
    c5m[19] = createCandle(19, 4345.0, 4345.5, 4340.5, 4345.2, false);
    const ind5m = createBaseIndicators({ atr14: 2.5, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND' });

    const trigger = assessPriceActionTrigger('BUY', c5m, [], ind5m);
    assert(
      !trigger.hasHardPriceActionTrigger && !trigger.hasTrigger,
      'Test 12A: Unclosed forming candle CANNOT trigger price action trigger for BUY',
      `hasHardPriceActionTrigger=${trigger.hasHardPriceActionTrigger}`
    );

    const val = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 4345.2,
        stopLoss: 4340.0,
        tp1: 4352.0,
        setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4344.0,
      },
      {
        currentPrice: 4345.2,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH', premiumDiscountZone: 'DISCOUNT' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );
    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 12B: Forming unclosed rejection candle MUST be REJECTED for BUY',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 13: Historical #10020 replay => BLOCKED
  // =========================================================================
  console.log('\n[TEST 13] Historical #10020 Replay');
  {
    // Direction: SELL, Entry: 4344.68, SL: 4349.19, TP1: 4340.00, R:R: 1.04
    // Setup: Bearish Trend Continuation (EMA/VWAP Pullback)
    // H1: RANGING, M15: BEARISH / STRONG_TREND, FVG: BULLISH_FVG, OB: BULLISH_OB, Zone: DISCOUNT
    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.68,
        stopLoss: 4349.19,
        tp1: 4340.00,
        setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 80,
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.68,
        candles5m: createCandleArray(20, 4344.68),
        candles15m: createCandleArray(20, 4344.68),
        candles1h: createCandleArray(20, 4344.68),
        indicators5m: createBaseIndicators({ atr14: 3.5 }),
        indicators15m: createBaseIndicators({
          marketRegime: 'STRONG_DOWNTREND',
          structure: 'BEARISH',
          premiumDiscountZone: 'DISCOUNT',
          orderBlock: { type: 'BULLISH', high: 4350, low: 4340 },
          fvg: { type: 'BULLISH', top: 4348, bottom: 4342 },
        }),
        indicators1h: createBaseIndicators({
          marketRegime: 'NORMAL_RANGE',
          structure: 'RANGING',
        }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );

    assert(
      !val.isValid,
      'Test 13: Historical #10020 MUST be BLOCKED by production pipeline',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 14: AI confidence 99% + no valid Price Action trigger => BLOCKED
  // =========================================================================
  console.log('\n[TEST 14] AI confidence 99% + no valid Price Action trigger');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 is tiny neutral candle
    c5m[18] = createCandle(18, 4345.1, 4345.4, 4344.8, 4345.0, true);
    c5m[19] = createCandle(19, 4345.0, 4345.3, 4344.7, 4344.9, true);
    const ind5m = createBaseIndicators({ atr14: 2.5 });

    const val = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 4344.9,
        stopLoss: 4348.9,
        tp1: 4338.0,
        setupName: 'AI Deep Market Structure Reversal',
        strategyFamily: 'MARKET_STRUCTURE',
        confidence: 99, // Super high AI confidence
        poiPrice: 4346.0,
      },
      {
        currentPrice: 4344.9,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH', premiumDiscountZone: 'PREMIUM' }),
        indicators1h: createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' }),
        brokerSpecs: defaultBrokerSpecs,
      }
    );

    assert(
      !val.isValid && (val.rejectionReason?.includes('MISSING_PRICE_ACTION_TRIGGER') ?? false),
      'Test 14: 99% AI confidence CANNOT bypass MISSING_PRICE_ACTION_TRIGGER hard block',
      `isValid=${val.isValid}, reason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 15: Valid H1/M15 aligned bearish continuation + strong closed bearish rejection + sufficient R:R => ALLOWED
  // =========================================================================
  console.log('\n[TEST 15] Valid H1/M15 aligned bearish continuation + strong closed bearish rejection + sufficient R:R');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 closed with dominant top rejection wick
    c5m[18] = createCandle(18, 4346.0, 4348.0, 4345.5, 4347.5, true);
    c5m[19] = createCandle(19, 4347.5, 4350.5, 4345.0, 4345.2, true); // upperWick=3.0, body=2.3, lowerWick=0.2

    const ind5m = createBaseIndicators({ atr14: 2.0, ema20: 4346.0, vwap: 4347.0, swingLow: 4300, swingHigh: 4370, support: 4300, resistance: 4370 });
    const ind15m = createBaseIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      premiumDiscountZone: 'PREMIUM',
      swingLow: 4300,
      swingHigh: 4370,
      support: 4300,
      resistance: 4370,
      orderBlock: { type: 'BEARISH', high: 4352, low: 4344 },
      fvg: { type: 'BEARISH', top: 4350, bottom: 4344 },
    });
    const ind1h = createBaseIndicators({
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
      swingLow: 4300,
      swingHigh: 4370,
      support: 4300,
      resistance: 4370,
    });

    const genResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 4345.2,
      candles5m: c5m,
      candles15m: createCandleArray(20, 4345, 4300, 4370),
      candles1h: createCandleArray(20, 4345, 4300, 4370),
      candles1m: c5m,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    const candidate = genResult.allCandidates.find(c => c.direction === 'SELL') || genResult.allCandidates[0];
    assert(!!candidate, 'Test 15A: Candidate generated for aligned bearish trend continuation');

    if (candidate) {
      if ((candidate as any).poiPrice === undefined) (candidate as any).poiPrice = 4346.0;
      const val = validateTradeSignalCandidate(candidate, {
        currentPrice: 4345.2,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: defaultBrokerSpecs,
      });

      assert(
        val.isValid,
        'Test 15B: Aligned bearish continuation + closed bearish rejection MUST be ALLOWED',
        `isValid=${val.isValid}, reason=${val.rejectionReason}`
      );
    }
  }

  // =========================================================================
  // TEST 16: Valid H1/M15 aligned bullish continuation + strong closed bullish rejection + sufficient R:R => ALLOWED
  // =========================================================================
  console.log('\n[TEST 16] Valid H1/M15 aligned bullish continuation + strong closed bullish rejection + sufficient R:R');
  {
    const c5m = createCandleArray(20, 4345, 4300, 4370);
    // Candle 19 closed with dominant bottom rejection wick
    c5m[18] = createCandle(18, 4344.0, 4344.5, 4342.0, 4342.5, true);
    c5m[19] = createCandle(19, 4342.5, 4345.0, 4339.5, 4344.8, true); // lowerWick=3.0, body=2.3, upperWick=0.2

    const ind5m = createBaseIndicators({ atr14: 2.0, ema20: 4344.0, ema200: 4330.0, vwap: 4343.0, structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', swingLow: 4300, swingHigh: 4370, support: 4300, resistance: 4370 });
    const ind15m = createBaseIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      premiumDiscountZone: 'DISCOUNT',
      ema20: 4344.0,
      ema50: 4338.0,
      ema200: 4330.0,
      swingLow: 4300,
      swingHigh: 4370,
      support: 4300,
      resistance: 4370,
      orderBlock: { type: 'BULLISH', high: 4346, low: 4338 },
      fvg: { type: 'BULLISH', top: 4346, bottom: 4340 },
    });
    const ind1h = createBaseIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      ema200: 4325.0,
      swingLow: 4300,
      swingHigh: 4370,
      support: 4300,
      resistance: 4370,
    });

    const genResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: 4344.8,
      candles5m: c5m,
      candles15m: createCandleArray(20, 4345, 4300, 4370),
      candles1h: createCandleArray(20, 4345, 4300, 4370),
      candles1m: c5m,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    const candidate = genResult.allCandidates.find(c => c.direction === 'BUY') || genResult.allCandidates[0];
    assert(!!candidate, 'Test 16A: Candidate generated for aligned bullish trend continuation');

    if (candidate) {
      if ((candidate as any).poiPrice === undefined) (candidate as any).poiPrice = 4344.0;
      const val = validateTradeSignalCandidate(candidate, {
        currentPrice: 4344.8,
        candles5m: c5m,
        candles15m: createCandleArray(20, 4345, 4300, 4370),
        candles1h: createCandleArray(20, 4345, 4300, 4370),
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: defaultBrokerSpecs,
      });

      assert(
        val.isValid,
        'Test 16B: Aligned bullish continuation + closed bullish rejection MUST be ALLOWED',
        `isValid=${val.isValid}, reason=${val.rejectionReason}`
      );
    }
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n================================================================');
  console.log(`FINAL PRICE ACTION HARDENING RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAll16RegressionTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
