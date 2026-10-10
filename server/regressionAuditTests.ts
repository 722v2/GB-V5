import { resolveAiProviderConfig } from './geminiTrader.js';
import { detectDoubleTopBottom } from './indicators.js';
import { tradeManagementEngine } from './tradeManagementEngine.js';
import { Candle, TradeLedgerItem, DEFAULT_APP_SETTINGS, TechnicalIndicators } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

console.log('================================================================');
console.log('RUNNING REGRESSION SUITE: AI PROVIDER, DOUBLE TOP, REVERSAL DEFENSE');
console.log('================================================================\n');

// ----------------------------------------------------------------------------
// TEST GROUP 1: AI Provider Routing Determinism
// ----------------------------------------------------------------------------
console.log('[Group 1] AI Provider Tuple Resolution & Isolation');
{
  const origEnv = { ...process.env };

  // Case 1: Custom AI Provider configured
  process.env.AI_PROVIDER = 'custom';
  process.env.AI_API_KEY = 'sk-custom-1234567890abcdef';
  process.env.AI_BASE_URL = 'https://custom-ai.example.com/v1';
  process.env.AI_MODEL = 'custom-model-v1';
  process.env.NVIDIA_API_KEY = 'nvapi-98765432109876543210';

  let config = resolveAiProviderConfig();
  assert(config.provider === 'custom', 'Selects custom provider when AI_API_KEY, AI_BASE_URL, and AI_MODEL are present');
  assert(config.baseURL === 'https://custom-ai.example.com/v1', 'Uses custom baseURL');
  assert(config.model === 'custom-model-v1', 'Uses custom model');
  assert(config.apiKey === 'sk-custom-1234567890abcdef', 'Uses custom API key');

  // Case 2: Only NVIDIA Key present
  delete process.env.AI_API_KEY;
  delete process.env.AI_PROVIDER;
  config = resolveAiProviderConfig();
  assert(config.provider === 'nvidia', 'Selects NVIDIA when only NVIDIA_API_KEY is present');
  assert(config.baseURL === 'https://integrate.api.nvidia.com/v1', 'Uses NVIDIA baseURL with NVIDIA key');
  assert(config.model === 'deepseek-ai/deepseek-v4-flash-0731', 'Uses NVIDIA model with NVIDIA key');
  assert(config.apiKey === 'nvapi-98765432109876543210', 'Uses NVIDIA key');

  // Case 3: No keys or placeholder keys
  delete process.env.NVIDIA_API_KEY;
  config = resolveAiProviderConfig();
  assert(config.provider === 'none', 'Returns none when no valid API keys are declared');

  // Restore env
  process.env = origEnv;
}

// ----------------------------------------------------------------------------
// TEST GROUP 2: Double Top Confirmation & Invalidation
// ----------------------------------------------------------------------------
console.log('\n[Group 2] Double Top/Bottom Pattern Structural Confirmation');
{
  const now = Date.now();
  const createCandle = (i: number, open: number, high: number, low: number, close: number, isClosed: boolean = true): Candle => ({
    timestamp: now + i * 300000,
    open,
    high,
    low,
    close,
    volume: 1000,
    isClosed,
  });

  // Create baseline candles with 2 peaks at 2950.0 and neckline at 2942.0
  const candles: Candle[] = [];
  // 10 base candles
  for (let i = 0; i < 10; i++) {
    candles.push(createCandle(i, 2940, 2943, 2939, 2942));
  }
  // Peak 1 at index 12: high 2950.0
  candles.push(createCandle(10, 2942, 2946, 2941, 2945));
  candles.push(createCandle(11, 2945, 2948, 2944, 2947));
  candles.push(createCandle(12, 2947, 2950.0, 2946, 2949)); // Peak 1
  candles.push(createCandle(13, 2949, 2949, 2944, 2945));

  // Trough / Neckline at index 15: low 2942.0
  candles.push(createCandle(14, 2945, 2946, 2943, 2944));
  candles.push(createCandle(15, 2944, 2945, 2942.0, 2943)); // Neckline trough
  candles.push(createCandle(16, 2943, 2947, 2943, 2946));

  // Peak 2 at index 18: high 2949.8
  candles.push(createCandle(17, 2946, 2948, 2945, 2947));
  candles.push(createCandle(18, 2947, 2949.8, 2946, 2948)); // Peak 2

  // Rejection candle right after Peak 2 (close 2946.0, above neckline 2942.0)
  candles.push(createCandle(19, 2948, 2949, 2945, 2946.0));

  const unconfirmedPatterns = detectDoubleTopBottom(candles, 2.5);
  assert(unconfirmedPatterns.length > 0, 'Detects Double Top pattern');
  assert(unconfirmedPatterns[0].confirmationState === 'PRE_CONFIRMATION', 'Correctly labels initial rejection as PRE_CONFIRMATION');
  assert(unconfirmedPatterns[0].isConfirmed === false, 'isConfirmed is false prior to neckline break');
  assert(unconfirmedPatterns[0].hasNecklineBreak === false, 'hasNecklineBreak is false prior to neckline break');

  // Now append confirmed neckline break (closed candle at 2940.5 < 2942.0)
  candles.push(createCandle(20, 2946, 2946, 2940.0, 2940.5));
  const confirmedPatterns = detectDoubleTopBottom(candles, 2.5);
  assert(confirmedPatterns.length > 0, 'Detects Double Top after break');
  assert(confirmedPatterns[0].confirmationState === 'CONFIRMED_REVERSAL', 'Labels confirmed neckline break as CONFIRMED_REVERSAL');
  assert(confirmedPatterns[0].isConfirmed === true, 'isConfirmed is true on confirmed neckline break');
  assert(confirmedPatterns[0].hasNecklineBreak === true, 'hasNecklineBreak is true');

  // Test forming candle isolation (forming spike above peak should NOT invalidate or alter closed analysis)
  const candlesWithForming = [...candles, createCandle(21, 2940.5, 2955.0, 2940.0, 2954.0, false)];
  const patternsForming = detectDoubleTopBottom(candlesWithForming, 2.5);
  assert(patternsForming.length > 0 && patternsForming[0].confirmationState === 'CONFIRMED_REVERSAL', 'Ignores forming (isClosed=false) candle spikes');
}

// ----------------------------------------------------------------------------
// TEST GROUP 3: Reversal Management & Defense State
// ----------------------------------------------------------------------------
console.log('\n[Group 3] Trade Management Engine Reversal Defense & Safety');
{
  const mockTrade: TradeLedgerItem = {
    id: 'TRADE-TEST-1',
    tradeNumber: 1,
    date: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 2940.0,
    sl: 2935.0,
    tp1: 2950.0,
    tp2: 2960.0,
    lotSize: 0.1,
    result: 'OPEN',
    rr: '1:2',
    riskPercent: 1.0,
    riskAmount: 10,
    confidence: 85,
    setup: 'TEST',
    pl: 0,
    balanceAfterTrade: 10000,
  };

  const currentPrice = 2944.0;
  const mockInd15m: TechnicalIndicators = {
    rsi14: 40,
    ema20: 2945.0,
    ema50: 2946.0,
    ema200: 2940.0,
    atr14: 2.0,
    structure: 'BEARISH',
  } as TechnicalIndicators;

  const mockInd5m: TechnicalIndicators = {
    rsi14: 38,
    ema20: 2944.5,
    ema50: 2945.0,
    ema200: 2942.0,
    atr14: 1.5,
    structure: 'BEARISH',
  } as TechnicalIndicators;

  // Generate 5M candles showing swing low at 2942.5 and counter-pressure drop
  const now = Date.now();
  const candles5m: Candle[] = [];
  for (let i = 0; i < 12; i++) {
    candles5m.push({
      timestamp: now + i * 300000,
      open: 2944.0,
      high: 2946.0,
      low: 2942.5,
      close: 2945.0,
      volume: 100,
      isClosed: true,
    });
  }
  // Append 3 breakdown candles below swing low
  candles5m.push({
    timestamp: now + 12 * 300000,
    open: 2944.5,
    high: 2945.0,
    low: 2943.0,
    close: 2943.5,
    volume: 120,
    isClosed: true,
  });
  candles5m.push({
    timestamp: now + 13 * 300000,
    open: 2943.5,
    high: 2944.0,
    low: 2942.0,
    close: 2942.2,
    volume: 150,
    isClosed: true,
  });
  candles5m.push({
    timestamp: now + 14 * 300000,
    open: 2942.2,
    high: 2942.5,
    low: 2941.0,
    close: 2941.5,
    volume: 180,
    isClosed: true,
  });

  // 15M candles with counter-pressure and bearish BOS
  const candles15m: Candle[] = [];
  for (let i = 0; i < 14; i++) {
    candles15m.push({
      timestamp: now + i * 900000,
      open: 2945.0,
      high: 2947.0,
      low: 2943.0,
      close: 2945.5,
      volume: 200,
      isClosed: true,
    });
  }
  // Last 15M candle closes below lowest low (2943.0) -> 2941.5
  candles15m.push({
    timestamp: now + 14 * 900000,
    open: 2944.0,
    high: 2944.5,
    low: 2941.0,
    close: 2941.5,
    volume: 350,
    isClosed: true,
  });

  // Scenario A: Level 2+ Reversal Defense (Opposite pressure 50-70 or aligned higher timeframe)
  const mockInd1hNeutral: TechnicalIndicators = {
    rsi14: 52,
    ema20: 2940.0,
    ema50: 2940.0,
    ema200: 2935.0,
    atr14: 3.0,
    structure: 'RANGING',
  } as TechnicalIndicators;

  const healthDefense = tradeManagementEngine.assessTradeHealth(
    mockTrade,
    'BUY',
    currentPrice,
    2940.0,
    2935.0,
    2950.0,
    2960.0,
    0.1,
    0.15,
    0.8,
    9.0,
    6.0,
    16.0,
    40,
    15,
    [],
    candles15m,
    candles5m,
    mockInd1hNeutral,
    mockInd15m,
    mockInd5m
  );

  assert(healthDefense.reversalLevel === 2, 'Detects level 2 elevated reversal pressure');
  assert(healthDefense.notes.some(n => n.includes('REVERSAL_DEFENSE')), 'Tags note with REVERSAL_DEFENSE');

  const actionDefense = tradeManagementEngine.determineManagementAction(
    mockTrade,
    healthDefense,
    currentPrice,
    2940.0,
    2935.0,
    2950.0,
    2960.0,
    candles15m,
    candles5m,
    mockInd15m,
    mockInd5m,
    DEFAULT_APP_SETTINGS
  );

  assert(actionDefense.managementState === 'REVERSAL_DEFENSE', 'Sets managementState to REVERSAL_DEFENSE');
  if (actionDefense.actionType === 'UPDATE_SL' && actionDefense.newSL !== undefined) {
    assert(actionDefense.newSL > mockTrade.sl, 'Protective defense SL never widens initial SL');
    assert(actionDefense.newSL < currentPrice, 'Protective defense SL is below current price');
  }

  // Safety Validation Check on defense action
  const safetyCheck = tradeManagementEngine.validateManagementActionSafety(
    actionDefense,
    mockTrade,
    10000,
    DEFAULT_APP_SETTINGS
  );
  assert(safetyCheck.valid === true, 'Management action passes all deterministic safety rules');

  // Scenario B: Level 3 High-Conviction Structural Reversal -> EARLY_EXIT
  const healthL3 = tradeManagementEngine.assessTradeHealth(
    mockTrade,
    'BUY',
    currentPrice,
    2940.0,
    2935.0,
    2950.0,
    2960.0,
    0.1,
    0.15,
    0.8,
    9.0,
    6.0,
    16.0,
    40,
    15,
    [],
    candles15m,
    candles5m,
    mockInd15m, // Opposing 1H structure
    mockInd15m,
    mockInd5m
  );
  assert(healthL3.reversalLevel === 3, 'Detects Level 3 High-conviction structural reversal');
  const actionL3 = tradeManagementEngine.determineManagementAction(
    mockTrade,
    healthL3,
    currentPrice,
    2940.0,
    2935.0,
    2950.0,
    2960.0,
    candles15m,
    candles5m,
    mockInd15m,
    mockInd5m,
    DEFAULT_APP_SETTINGS
  );
  assert(actionL3.managementState === 'EARLY_EXIT', 'Executes EARLY_EXIT on confirmed Level 3 reversal');
}

console.log('\n================================================================');
if (failed === 0) {
  console.log(`ALL ${passed} REGRESSION AUDIT TESTS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');
  process.exit(0);
} else {
  console.error(`FAILED: ${failed} tests failed (${passed} passed).`);
  console.log('================================================================\n');
  process.exit(1);
}
