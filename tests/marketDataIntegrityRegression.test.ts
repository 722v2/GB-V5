import assert from 'assert';
import { Candle, TechnicalIndicators } from '../src/types.js';
import { analyzeTechnicals } from '../server/indicators.js';
import {
  extractPriceActionEvidence,
  extractLiquidityEvidence,
  extractMacdEvidence,
  extractRsiEvidence,
  extractStructureEvidence,
  buildCompleteEvidenceBundle,
} from '../server/evidenceEngine.js';
import { discoverGbv5Candidates, executeGbv5Brain } from '../server/gbv5Brain.js';
import { partition1hCandles, partition5mCandles } from '../server/candleUtils.js';
import { normalizeMarketTimestamp, scanner } from '../server/scanner.js';

async function runMarketDataIntegrityTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING GB-V5 PHASE 2 MARKET DATA INTEGRITY REGRESSION TESTS');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Scanner Candle Partition Semantics & No Raw Candle Fallback
  // -------------------------------------------------------------------------
  console.log('TEST 1: Partitioning semantics - invalid or 0 closed candles must fail closed');
  const emptyCandles: Candle[] = [];
  const partEmpty = partition1hCandles(emptyCandles);
  assert.strictEqual(partEmpty.isValid, false, 'TEST 1: Empty candles must yield isValid: false');
  assert.strictEqual(partEmpty.closedCandles.length, 0, 'TEST 1: Empty candles must have 0 closed candles');

  // Single unclosed forming candle
  const singleForming: Candle[] = [{
    timestamp: Date.now(),
    open: 2500,
    high: 2505,
    low: 2495,
    close: 2502,
    volume: 100,
    isClosed: false,
  }];
  const partForming = partition5mCandles(singleForming, Date.now());
  assert.strictEqual(partForming.isValid, false, 'TEST 1: Single forming candle has no closed candles -> isValid: false');
  assert.strictEqual(partForming.closedCandles.length, 0, 'TEST 1: closedCandles must be empty');
  console.log('✅ [PASS] TEST 1: Partitioning correctly flags invalid and 0-closed candle conditions.\n');

  // -------------------------------------------------------------------------
  // TEST 2: Indicator Insufficient-Data Semantics
  // -------------------------------------------------------------------------
  console.log('TEST 2: analyzeTechnicals flags isDataSufficient=false on empty or insufficient data');
  const indEmpty = analyzeTechnicals([]);
  assert.strictEqual(indEmpty.isDataSufficient, false, 'TEST 2: Empty candles must have isDataSufficient = false');

  // 3 candles is insufficient for 14-period indicators
  const fewCandles: Candle[] = [
    { timestamp: 1000, open: 2500, high: 2502, low: 2499, close: 2501, volume: 100, isClosed: true },
    { timestamp: 2000, open: 2501, high: 2503, low: 2500, close: 2502, volume: 100, isClosed: true },
    { timestamp: 3000, open: 2502, high: 2504, low: 2501, close: 2503, volume: 100, isClosed: true },
  ];
  const indFew = analyzeTechnicals(fewCandles);
  assert.strictEqual(indFew.isDataSufficient, false, 'TEST 2: <10 candles must have isDataSufficient = false');

  // 30 valid closed candles
  const adequateCandles: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    adequateCandles.push({
      timestamp: 10000 + i * 300000,
      open: 2500 + i * 0.2,
      high: 2501 + i * 0.2,
      low: 2499 + i * 0.2,
      close: 2500.5 + i * 0.2,
      volume: 100,
      isClosed: true,
    });
  }
  const indAdequate = analyzeTechnicals(adequateCandles);
  assert.strictEqual(indAdequate.isDataSufficient, true, 'TEST 2: 30 closed candles must have isDataSufficient = true');
  console.log('✅ [PASS] TEST 2: Indicator data sufficiency flags verified.\n');

  // -------------------------------------------------------------------------
  // TEST 3: Evidence Engine Data Integrity & Zero Scores on Missing Data
  // -------------------------------------------------------------------------
  console.log('TEST 3: Evidence extractors do not award baseline scores to missing data');
  const paEmpty = extractPriceActionEvidence([], 1.5);
  assert.strictEqual(paEmpty.rejectionQualityScore, 0, 'TEST 3: PA score must be 0 when candles are missing');
  assert.match(paEmpty.description, /No candles|unavailable/i, 'TEST 3: Description must state data unavailable');

  const liqEmpty = extractLiquidityEvidence(2500, [], indAdequate);
  assert.strictEqual(liqEmpty.evidenceScore, 0, 'TEST 3: Liquidity score must be 0 when 5M candles are missing');

  const macdEmpty = extractMacdEvidence(indEmpty);
  assert.strictEqual(macdEmpty.evidenceScore, 0, 'TEST 3: MACD score must be 0 when indicators have insufficient data');

  const rsiEmpty = extractRsiEvidence(indEmpty);
  assert.strictEqual(rsiEmpty.evidenceScore, 0, 'TEST 3: RSI score must be 0 when indicators have insufficient data');

  const structEmpty = extractStructureEvidence(2500, indEmpty, indEmpty, 1.5);
  assert.strictEqual(structEmpty.evidenceScore, 0, 'TEST 3: Structure score must be 0 when indicators have insufficient data');
  console.log('✅ [PASS] TEST 3: All evidence extractors return score=0 on absent/insufficient data.\n');

  // -------------------------------------------------------------------------
  // TEST 4: No Timeframe Substitution in Evidence Bundle
  // -------------------------------------------------------------------------
  console.log('TEST 4: buildCompleteEvidenceBundle does not substitute 5M for 1M candles');
  const bundleWithout1m = buildCompleteEvidenceBundle({
    currentPrice: 2500,
    candles1m: [], // NO 1M candles
    candles5m: adequateCandles,
    candles15m: adequateCandles,
    candles1h: adequateCandles,
    indicators5m: indAdequate,
    indicators15m: indAdequate,
    indicators1h: indAdequate,
  });
  assert.strictEqual(bundleWithout1m.priceActionM1.rejectionQualityScore, 0, 'TEST 4: priceActionM1 must have score 0 when candles1m is empty (no substitution)');
  assert(bundleWithout1m.priceActionM5.rejectionQualityScore > 0, 'TEST 4: priceActionM5 should evaluate candles5m properly');
  console.log('✅ [PASS] TEST 4: 1M price action cleanly isolated without timeframe substitution.\n');

  // -------------------------------------------------------------------------
  // TEST 5: GB-V5 Brain Missing 5M Candles Does NOT Create Synthetic Candles
  // -------------------------------------------------------------------------
  console.log('TEST 5: GB-V5 Brain fails safely on missing 5M candles (DATA_UNAVAILABLE)');
  const resEmpty5m = discoverGbv5Candidates({
    currentPrice: 2500,
    candles1m: [],
    candles5m: [], // MISSING
    candles15m: [],
    candles1h: [],
    indicators5m: indEmpty,
    indicators15m: indEmpty,
    indicators1h: indEmpty,
  });
  assert.strictEqual(resEmpty5m.candidates.length, 0, 'TEST 5: No candidates generated when 5M candles missing');

  const brainRes = await executeGbv5Brain({
    currentPrice: 2500,
    candles1m: [],
    candles5m: [], // MISSING
    candles15m: [],
    candles1h: [],
    indicators5m: indEmpty,
    indicators15m: indEmpty,
    indicators1h: indEmpty,
  });
  assert.strictEqual(brainRes.hasOpportunity, false, 'TEST 5: hasOpportunity must be false');
  assert.strictEqual(brainRes.selectedCandidate, null, 'TEST 5: selectedCandidate must be null');
  assert.strictEqual(brainRes.finalSignal.signal, 'NO TRADE', 'TEST 5: finalSignal must be NO TRADE');
  assert.strictEqual(brainRes.finalSignal.confidence, 0, 'TEST 5: confidence must be 0');
  assert.strictEqual(brainRes.finalSignal.setup, 'MARKET_DATA_UNAVAILABLE', 'TEST 5: setup must distinguish DATA_UNAVAILABLE from neutral market');
  assert.match(brainRes.finalSignal.noTradeReason || '', /5M|بيانات السوق/i, 'TEST 5: Reason must explain missing 5M data');
  console.log('✅ [PASS] TEST 5: Missing 5M data safely returned MARKET_DATA_UNAVAILABLE without synthetic candles.\n');

  // -------------------------------------------------------------------------
  // TEST 6: Strict Fail-Closed Market Timestamp Normalization (Phase 2A)
  // -------------------------------------------------------------------------
  console.log('TEST 6: Market timestamp normalization accepts valid formats and strictly fails closed');

  // 1. Valid numeric timestamp -> accepted
  const validNum = 1712574000000;
  assert.strictEqual(normalizeMarketTimestamp(validNum), 1712574000000, 'TEST 6.1: Valid numeric timestamp must be accepted');

  // 2. Valid numeric-string timestamp -> accepted
  const validNumStr = '1712574000000';
  assert.strictEqual(normalizeMarketTimestamp(validNumStr), 1712574000000, 'TEST 6.2: Valid numeric string timestamp must be accepted');

  // 3. Valid ISO timestamp -> accepted and normalized correctly
  const isoStr = '2026-10-08T11:00:00.000Z';
  const expectedEpoch = Date.parse(isoStr);
  assert.strictEqual(normalizeMarketTimestamp(isoStr), expectedEpoch, 'TEST 6.3: Valid ISO string timestamp must be parsed to epoch ms');

  // 4. Missing timestamp (undefined or empty object property) -> fail closed (null)
  assert.strictEqual(normalizeMarketTimestamp(undefined), null, 'TEST 6.4: Missing timestamp must fail closed (return null)');

  // 5. null timestamp -> fail closed (null)
  assert.strictEqual(normalizeMarketTimestamp(null), null, 'TEST 6.5: null timestamp must fail closed (return null)');

  // 6. undefined timestamp -> fail closed (null)
  const emptyObj: Record<string, unknown> = {};
  assert.strictEqual(normalizeMarketTimestamp(emptyObj.timestamp), null, 'TEST 6.6: undefined quote.timestamp must fail closed (return null)');

  // 7. invalid/unparseable timestamp string -> fail closed (null)
  assert.strictEqual(normalizeMarketTimestamp('invalid-date-string'), null, 'TEST 6.7: Unparseable timestamp string must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp(''), null, 'TEST 6.7: Empty string timestamp must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp('   '), null, 'TEST 6.7: Whitespace timestamp string must fail closed (return null)');

  // 8. NaN -> fail closed (null)
  assert.strictEqual(normalizeMarketTimestamp(NaN), null, 'TEST 6.8: Numeric NaN timestamp must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp('NaN'), null, 'TEST 6.8: String "NaN" timestamp must fail closed (return null)');

  // 9. Infinity / -Infinity -> fail closed (null)
  assert.strictEqual(normalizeMarketTimestamp(Infinity), null, 'TEST 6.9: Positive Infinity must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp(-Infinity), null, 'TEST 6.9: Negative Infinity must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp('Infinity'), null, 'TEST 6.9: String "Infinity" must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp('-Infinity'), null, 'TEST 6.9: String "-Infinity" must fail closed (return null)');
  assert.strictEqual(normalizeMarketTimestamp(-5000), null, 'TEST 6.9: Negative numeric timestamp must fail closed (return null)');
  console.log('✅ [PASS] TEST 6: All 9 timestamp validation and fail-closed conditions passed.\n');

  console.log('========================================================================');
  console.log('🎉 ALL 6 MARKET DATA INTEGRITY REGRESSION TESTS PASSED (6/6)');
  console.log('========================================================================');
}

runMarketDataIntegrityTests()
  .then(() => {
    scanner.stop();
    process.exit(0);
  })
  .catch((err) => {
    scanner.stop();
    console.error('❌ Market Data Integrity Tests Failed:', err);
    process.exit(1);
  });
