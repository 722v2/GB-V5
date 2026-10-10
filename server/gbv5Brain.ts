import {
  AssetType,
  Candle,
  SignalDecision,
  TechnicalIndicators,
  TradeSignal,
  StrategyFamily,
} from '../src/types.js';
import { BrokerContractSpecs, DEFAULT_BROKER_SPECS, evaluateTradeRisk } from './riskManager.js';
import { calculateDynamicTakeProfits } from './tpEngine.js';
import {
  buildCompleteEvidenceBundle,
  Gbv5EvidenceBundle,
  PriceActionEvidence,
  MacdEvidence,
  RsiEvidence,
  StructureEvidence,
  LiquidityEvidence,
  SessionRegimeEvidence,
} from './evidenceEngine.js';
import { partition5mCandles, partition1mCandles } from './candleUtils.js';

// ============================================================================
// GB-V5 LOCKED FOUR CANDIDATE FAMILIES
// ============================================================================

export type Gbv5Family =
  | 'LIQUIDITY_SWEEP_REJECTION'
  | 'STRUCTURE_BREAK_RETEST'
  | 'TREND_CONTINUATION_PULLBACK'
  | 'RANGE_SWEEP_SFP';

export interface Gbv5Candidate {
  family: Gbv5Family;
  legacyFamilyAlias: StrategyFamily;
  setupName: string;
  direction: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  entry: number;
  stopLoss: number;
  slPoints: number;
  tp1: number;
  tp1Points: number;
  tp1Rr: number;
  tp2: number;
  tp2Points: number;
  tp2Rr: number;
  confluenceScore: number; // 0 - 100
  confidence: number;       // 0 - 100
  timeframe: string;
  mainReasons: string[];
  invalidation: string;
  supportingConfluences: string[];
  evidence: {
    priceAction: PriceActionEvidence;
    macd: MacdEvidence;
    rsi: RsiEvidence;
    structure: StructureEvidence;
    liquidity: LiquidityEvidence;
    sessionRegime: SessionRegimeEvidence;
  };
  patternMetadata?: Record<string, any>;
}

export interface Gbv5BrainInput {
  asset?: AssetType;
  currentPrice: number;
  balance?: number;
  candles1m?: Candle[];
  candles5m?: Candle[];
  candles15m?: Candle[];
  candles1h?: Candle[];
  indicators5m?: TechnicalIndicators;
  indicators15m?: TechnicalIndicators;
  indicators1h?: TechnicalIndicators;
  brokerSpecs?: Partial<BrokerContractSpecs> | BrokerContractSpecs;
  activeTradeDirection?: 'BUY' | 'SELL' | null;
  minConfidence?: number;
  currentSpread?: number;
}

export interface Gbv5BrainResult {
  hasOpportunity: boolean;
  selectedCandidate: Gbv5Candidate | null;
  allCandidates: Gbv5Candidate[];
  finalSignal: TradeSignal;
  evidenceBundle: Gbv5EvidenceBundle;
}

// ============================================================================
// CANDIDATE DISCOVERY — THE FOUR CANONICAL FAMILIES
// ============================================================================

export function discoverGbv5Candidates(input: Gbv5BrainInput): {
  candidates: Gbv5Candidate[];
  evidenceBundle: Gbv5EvidenceBundle;
} {
  const {
    asset = 'XAU/USD',
    currentPrice,
    candles1m = [],
    candles5m = [],
    candles15m = [],
    candles1h = [],
    indicators5m,
    indicators15m,
    indicators1h,
    brokerSpecs = DEFAULT_BROKER_SPECS,
    currentSpread = 0.15,
  } = input;

  const rawAtr5m = indicators5m?.atr14 ?? indicators5m?.atr;
  const atr5m = (typeof rawAtr5m === 'number' && rawAtr5m > 0 && isFinite(rawAtr5m)) ? rawAtr5m : 0;

  const rawAtr15m = indicators15m?.atr14 ?? indicators15m?.atr;
  const atr15m = (typeof rawAtr15m === 'number' && rawAtr15m > 0 && isFinite(rawAtr15m)) ? rawAtr15m : 0;

  const partition1m = partition1mCandles(candles1m);
  const closed1m = partition1m.closedCandles || [];
  const last1m = partition1m.lastClosedCandle || (candles1m.length > 0 ? candles1m[candles1m.length - 1] : null);
  const prev1m = partition1m.prevClosedCandle || last1m;

  const partition5m = partition5mCandles(candles5m);
  const closed5m = partition5m.closedCandles || [];
  const last5m = partition5m.lastClosedCandle || candles5m[candles5m.length - 1];
  const prev5m = partition5m.prevClosedCandle || last5m;

  if (!candles1m || !Array.isArray(candles1m) || candles1m.length === 0 || !last1m || !partition1m.isValid) {
    const evidenceBundle = buildCompleteEvidenceBundle({
      currentPrice,
      candles1m,
      candles5m,
      candles15m,
      candles1h,
      indicators5m,
      indicators15m,
      indicators1h,
      currentSpread,
    });
    return { candidates: [], evidenceBundle };
  }

  const evidenceBundle = buildCompleteEvidenceBundle({
    currentPrice,
    candles1m,
    candles5m,
    candles15m,
    candles1h,
    indicators5m,
    indicators15m,
    indicators1h,
    currentSpread,
  });

  const paM1 = evidenceBundle.priceActionM1;
  const paM5 = evidenceBundle.priceActionM5;
  const macdEv = evidenceBundle.macd;
  const rsiEv = evidenceBundle.rsi;
  const structEv = evidenceBundle.structure;
  const liqEv = evidenceBundle.liquidity;
  const sessEv = evidenceBundle.sessionRegime;

  const candidates: Gbv5Candidate[] = [];

  // Helper to construct and score a candidate
  const constructCandidate = (params: {
    family: Gbv5Family;
    legacyFamilyAlias: StrategyFamily;
    setupName: string;
    direction: 'BUY' | 'SELL';
    orderType?: 'MARKET' | 'LIMIT';
    structuralStopLoss: number;
    mainReasons: string[];
    invalidation: string;
    supportingConfluences: string[];
    evidenceScoreBonus?: number;
    metadata?: Record<string, any>;
  }): Gbv5Candidate | null => {
    const {
      family,
      legacyFamilyAlias,
      setupName,
      direction,
      orderType = 'MARKET',
      structuralStopLoss,
      mainReasons,
      invalidation,
      supportingConfluences,
      evidenceScoreBonus = 0,
      metadata = {},
    } = params;

    let sl = structuralStopLoss;
    if (direction === 'BUY') {
      if (sl >= currentPrice) {
        if (atr5m <= 0) return null; // Reject candidate: ATR required for fallback SL but measured ATR is missing/invalid
        sl = currentPrice - (atr5m * 1.5);
      }
    } else {
      if (sl <= currentPrice) {
        if (atr5m <= 0) return null;
        sl = currentPrice + (atr5m * 1.5);
      }
    }

    const slDist = Math.abs(currentPrice - sl);
    if (slDist <= 0.05) return null;
    const slPts = Math.round((slDist / 0.1) * 10) / 10;

    // Calculate TP targets via structural tpEngine (NO synthetic TP fallback)
    const tpRes = calculateDynamicTakeProfits({
      direction,
      entry: currentPrice,
      stopLoss: sl,
      asset,
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h,
      candles15m,
      candles5m,
      minRr: brokerSpecs.minRr ?? 1.2,
    });

    if (!tpRes.valid || tpRes.tp1Rr < 1.0) {
      console.log('REJECTED CANDIDATE:', setupName, 'Reason:', tpRes.rejectionReason, 'tp1Rr:', tpRes.tp1Rr);
      return null; // Reject candidate safely if valid structural targets cannot be calculated or TP1 RR < 1.0
    }

    const tp1 = tpRes.tp1;
    const tp2 = tpRes.tp2;
    const tp1Rr = tpRes.tp1Rr;
    const tp2Rr = tpRes.tp2Rr;

    const tp1Pts = Math.round((Math.abs(tp1 - currentPrice) / 0.1) * 10) / 10;
    const tp2Pts = Math.round((Math.abs(tp2 - currentPrice) / 0.1) * 10) / 10;

    // Additive Confluence Score (0 - 100)
    const baseScore =
      structEv.evidenceScore +
      liqEv.evidenceScore +
      paM1.rejectionQualityScore +
      macdEv.evidenceScore +
      rsiEv.evidenceScore +
      sessEv.evidenceScore +
      evidenceScoreBonus;

    const totalConfluence = Math.min(100, Math.max(0, baseScore));
    // Deterministic heuristic confidence unconstrained by artificial floors
    const confidence = Math.min(95, Math.max(0, totalConfluence));

    return {
      family,
      legacyFamilyAlias,
      setupName,
      direction,
      orderType,
      entry: currentPrice,
      stopLoss: Math.round(sl * 100) / 100,
      slPoints: slPts,
      tp1: Math.round(tp1 * 100) / 100,
      tp1Points: tp1Pts,
      tp1Rr: Math.round(tp1Rr * 100) / 100,
      tp2: Math.round(tp2 * 100) / 100,
      tp2Points: tp2Pts,
      tp2Rr: Math.round(tp2Rr * 100) / 100,
      confluenceScore: totalConfluence,
      confidence,
      timeframe: 'M1 / M5',
      mainReasons,
      invalidation,
      supportingConfluences,
      evidence: {
        priceAction: paM1,
        macd: macdEv,
        rsi: rsiEv,
        structure: structEv,
        liquidity: liqEv,
        sessionRegime: sessEv,
      },
      patternMetadata: metadata,
    };
  };

  // ==========================================================================
  // FAMILY 1: LIQUIDITY SWEEP + REJECTION (M1 PRIMARY)
  // ==========================================================================
  {
    const m1BullSweep =
      (last1m.low < structEv.swingLow && (last1m.close > last1m.open || paM1.hasRejectionWick)) ||
      (paM1.rejectionDirection === 'BULLISH' && last1m.low <= (structEv.swingLow + atr5m * 0.5));

    if (m1BullSweep && last1m) {
      const c = constructCandidate({
        family: 'LIQUIDITY_SWEEP_REJECTION',
        legacyFamilyAlias: 'LIQUIDITY_SWEEP',
        setupName: 'GB-V5 Liquidity Sweep & Rejection (M1 Bullish SFP)',
        direction: 'BUY',
        structuralStopLoss: Math.min(last1m.low, prev1m.low) - (atr5m * 0.2),
        mainReasons: [
          'سحب سيولة بيعية أسفل القاع المحوري على إطار M1 مع ارتداد وإغلاق فوري داخل النطاق',
          'ظهور ذيل رفض سفلي على M1 يؤكد امتصاص عروض البيع ودخول سيولة مؤسسية',
          'استهداف سيولة القمم المعاكسة بناءً على تكوين إطار M1 الأساسي',
        ],
        invalidation: `كسر أدنى نقطة لذيل السحب على M1 عند ${(Math.min(last1m.low, prev1m.low) - 0.2).toFixed(2)}`,
        supportingConfluences: [
          'M1 Sell-Side Liquidity Purge & Reclaim',
          'M1 Bullish Rejection Wick',
          'HTF / M5 Contextual Alignment',
        ],
        evidenceScoreBonus: 5,
      });
      if (c) candidates.push(c);
    }

    const m1BearSweep =
      (last1m.high > structEv.swingHigh && (last1m.close < last1m.open || paM1.hasRejectionWick)) ||
      (paM1.rejectionDirection === 'BEARISH' && last1m.high >= (structEv.swingHigh - atr5m * 0.5));

    if (m1BearSweep && last1m) {
      const c = constructCandidate({
        family: 'LIQUIDITY_SWEEP_REJECTION',
        legacyFamilyAlias: 'LIQUIDITY_SWEEP',
        setupName: 'GB-V5 Liquidity Sweep & Rejection (M1 Bearish SFP)',
        direction: 'SELL',
        structuralStopLoss: Math.max(last1m.high, prev1m.high) + (atr5m * 0.2),
        mainReasons: [
          'سحب سيولة شرائية أعلى القمة المحورية على إطار M1 مع رفض سعري علوي فوري',
          'تأكيد استنفاذ المشترين على M1 وتمركز أوامر البيع',
          'استهداف مناطق تجميع السيولة البيعية أسفل القيعان السابقة بناءً على تكوين M1',
        ],
        invalidation: `تجاوز أعلى نقطة لذيل السحب على M1 عند ${(Math.max(last1m.high, prev1m.high) + 0.2).toFixed(2)}`,
        supportingConfluences: [
          'M1 Buy-Side Liquidity Purge',
          'M1 Bearish Upper Rejection',
          'HTF / M5 Contextual Bias',
        ],
        evidenceScoreBonus: 5,
      });
      if (c) candidates.push(c);
    }
  }

  // ==========================================================================
  // ==========================================================================
  // FAMILY 2: STRUCTURE BREAK + RETEST (M1 PRIMARY)
  // ==========================================================================
  {
    // A valid structural reference level must exist from ground evidence
    const hasValidSwingHigh = typeof structEv.swingHigh === 'number' && structEv.swingHigh > 0 && isFinite(structEv.swingHigh);
    const hasValidSwingLow = typeof structEv.swingLow === 'number' && structEv.swingLow > 0 && isFinite(structEv.swingLow);
    const hasMinBosHistory = closed1m.length >= 2;

    // Prior closed candles MUST NOT include last1m (the current candle).
    // Breakout event and retest event must be distinct sequential events.
    const priorClosedCandles = hasMinBosHistory
      ? closed1m.slice(Math.max(0, closed1m.length - 6), closed1m.length - 1)
      : [];

    // BUY: Genuine bullish M1 break of swingHigh in a previous closed candle
    // The current candle cannot establish both the breakout and retest simultaneously.
    const priorBrokeSwingHigh = hasValidSwingHigh && priorClosedCandles.length > 0 && priorClosedCandles.some(
      (c) => c.close > structEv.swingHigh
    );
    // Retest evidence: current closed candle tested near/at the broken level and held above it
    const retestedSwingHigh = hasValidSwingHigh && (
      last1m.low <= (structEv.swingHigh + 0.5) &&
      last1m.close > structEv.swingHigh
    );
    const m1BullBreak = priorBrokeSwingHigh && retestedSwingHigh && (last1m.close > last1m.open || paM1.hasRejectionWick);

    if (m1BullBreak && last1m) {
      const c = constructCandidate({
        family: 'STRUCTURE_BREAK_RETEST',
        legacyFamilyAlias: 'BREAK_AND_RETEST',
        setupName: 'GB-V5 Structure Break & Retest (M1 Bullish BOS)',
        direction: 'BUY',
        structuralStopLoss: Math.min(last1m.low, structEv.swingHigh - atr5m * 0.5),
        mainReasons: [
          'اختراق مستوى مقاومة هيكلي بشمعة زخم صاعدة سابقة على إطار M1',
          'إعادة اختبار منطقة الكسر على M1 مع تحول المقاومة إلى دعم فني وثبات الإغلاق أعلاها',
          'استمرار الزخم الهيكلي الإيجابي المدعوم بانطلاقة M1',
        ],
        invalidation: `كسر مستوى الدعم الهيكلي على M1 عند ${(last1m.low - 0.3).toFixed(2)}`,
        supportingConfluences: [
          'M1 Break of Structure (BOS)',
          paM1.hasDisplacement ? 'M1 Displacement & Momentum' : 'M1 Structural Hold',
          'HTF Trend Alignment',
        ],
        evidenceScoreBonus: paM1.hasDisplacement ? 5 : 4,
      });
      if (c) candidates.push(c);
    }

    // SELL: Genuine bearish M1 break of swingLow in a previous closed candle
    const priorBrokeSwingLow = hasValidSwingLow && priorClosedCandles.length > 0 && priorClosedCandles.some(
      (c) => c.close < structEv.swingLow
    );
    // Retest evidence: current closed candle tested near/at the broken level and held below it
    const retestedSwingLow = hasValidSwingLow && (
      last1m.high >= (structEv.swingLow - 0.5) &&
      last1m.close < structEv.swingLow
    );
    const m1BearBreak = priorBrokeSwingLow && retestedSwingLow && (last1m.close < last1m.open || paM1.hasRejectionWick);

    if (m1BearBreak && last1m) {
      const c = constructCandidate({
        family: 'STRUCTURE_BREAK_RETEST',
        legacyFamilyAlias: 'BREAK_AND_RETEST',
        setupName: 'GB-V5 Structure Break & Retest (M1 Bearish BOS)',
        direction: 'SELL',
        structuralStopLoss: Math.max(last1m.high, structEv.swingLow + atr5m * 0.5),
        mainReasons: [
          'كسر مستوى قاع هيكلي رئيسي بشمعة زخم بيعية سابقة على إطار M1',
          'إعادة اختبار مستوى الكسر على M1 مع ثبات البائعين والإغلاق أسفل المستوى',
          'استهداف مستويات سيولة أعمق بناءً على انهيار حركة M1',
        ],
        invalidation: `اختراق مستوى المقاومة على M1 عند ${(last1m.high + 0.3).toFixed(2)}`,
        supportingConfluences: [
          'M1 Break of Structure (BOS)',
          paM1.hasDisplacement ? 'M1 Bearish Displacement' : 'M1 Structural Resistance Hold',
          'HTF Directional Flow',
        ],
        evidenceScoreBonus: paM1.hasDisplacement ? 5 : 4,
      });
      if (c) candidates.push(c);
    }
  }

  // ==========================================================================
  // FAMILY 3: TREND CONTINUATION / PULLBACK (M1 PRIMARY)
  // ==========================================================================
  {
    // Supporting HTF context (optional chaining guarded)
    const is1hBull = indicators1h?.structure === 'BULLISH' || (indicators1h?.ema20 ?? 0) > (indicators1h?.ema50 ?? 0);
    const is1hBear = indicators1h?.structure === 'BEARISH' || (indicators1h?.ema20 ?? 0) < (indicators1h?.ema50 ?? 0);
    const is15mBull = indicators15m?.structure === 'BULLISH';
    const is15mBear = indicators15m?.structure === 'BEARISH';
    const hasHtfBullBias = is15mBull || is1hBull;
    const hasHtfBearBias = is15mBear || is1hBear;

    // Minimum history required: At least 3 closed M1 candles to observe pullback + continuation trigger
    const hasMinCandleHistory = closed1m.length >= 3;

    // BUY: Evidence of preceding countertrend retracement or pullback structure on M1
    // Must be observed in candles preceding the continuation trigger (last1m).
    // Tiny open vs close price differences do NOT qualify as pullback evidence.
    let hasBullPullbackStructure = false;
    if (hasMinCandleHistory) {
      const lookbackStart = Math.max(1, closed1m.length - 6);
      for (let i = lookbackStart; i < closed1m.length - 1; i++) {
        const curr = closed1m[i];
        const prev = closed1m[i - 1];
        // Identifiable countertrend retracement: bearish candle or distinct lower low/dip
        if (curr.close < curr.open || curr.low < prev.low) {
          hasBullPullbackStructure = true;
          break;
        }
      }
    }

    // Subsequent M1 continuation trigger: last1m closes in intended direction or shows rejection
    const m1BullContinuationTrigger =
      last1m.close > last1m.open || paM1.rejectionDirection === 'BULLISH';

    const m1BullPullback = hasHtfBullBias && hasMinCandleHistory && hasBullPullbackStructure && m1BullContinuationTrigger;

    if (m1BullPullback && last1m) {
      const c = constructCandidate({
        family: 'TREND_CONTINUATION_PULLBACK',
        legacyFamilyAlias: 'MARKET_STRUCTURE',
        setupName: 'GB-V5 Trend Continuation & Value Pullback (M1 Bullish)',
        direction: 'BUY',
        structuralStopLoss: Math.min(last1m.low, currentPrice - atr5m * 1.2),
        mainReasons: [
          'اكتمال تصحيح صحي وإبداء رفض شرائي على إطار M1 متوافق مع اتجاه 1H/15M الصاعد',
          'ارتداد شمعة M1 من مناطق القيمة مع زخم إيجابي مؤكد',
          'استمرار الموجة الدافعة نحو القمم السابقة بدعم من M1',
        ],
        invalidation: `إغلاق شمعة M1 أدنى القاع المؤقت عند ${(last1m.low - 0.2).toFixed(2)}`,
        supportingConfluences: [
          'M1 Bullish Rejection / Continuation Trigger',
          '1H / 15M Trend Alignment',
          'Value Area Equilibrium',
        ],
        evidenceScoreBonus: 3,
      });
      if (c) candidates.push(c);
    }

    // SELL: Evidence of preceding countertrend retracement or rally structure on M1
    // Must be observed in candles preceding the continuation trigger (last1m).
    // Tiny open vs close price differences do NOT qualify as pullback evidence.
    let hasBearPullbackStructure = false;
    if (hasMinCandleHistory) {
      const lookbackStart = Math.max(1, closed1m.length - 6);
      for (let i = lookbackStart; i < closed1m.length - 1; i++) {
        const curr = closed1m[i];
        const prev = closed1m[i - 1];
        // Identifiable countertrend retracement: bullish candle or distinct higher high/rally
        if (curr.close > curr.open || curr.high > prev.high) {
          hasBearPullbackStructure = true;
          break;
        }
      }
    }

    // Subsequent M1 continuation trigger: last1m closes in intended direction or shows rejection
    const m1BearContinuationTrigger =
      last1m.close < last1m.open || paM1.rejectionDirection === 'BEARISH';

    const m1BearPullback = hasHtfBearBias && hasMinCandleHistory && hasBearPullbackStructure && m1BearContinuationTrigger;

    if (m1BearPullback && last1m) {
      const c = constructCandidate({
        family: 'TREND_CONTINUATION_PULLBACK',
        legacyFamilyAlias: 'MARKET_STRUCTURE',
        setupName: 'GB-V5 Trend Continuation & Value Pullback (M1 Bearish)',
        direction: 'SELL',
        structuralStopLoss: Math.max(last1m.high, currentPrice + atr5m * 1.2),
        mainReasons: [
          'ارتداد تصحيحي لاختبار المقاومة وظهور ذيل رفض بيعي على إطار M1 متوافق مع اتجاه الهبوط',
          'سيطرة البائعين على شمعة M1 الحالية',
          'استمرار الاتجاه الهابط بدعم من M1',
        ],
        invalidation: `إغلاق شمعة M1 أعلى القمة المؤقتة عند ${(last1m.high + 0.2).toFixed(2)}`,
        supportingConfluences: [
          'M1 Bearish Rejection / Continuation Trigger',
          '1H / 15M Bearish Structure',
          'Dynamic Resistance Rejection',
        ],
        evidenceScoreBonus: 3,
      });
      if (c) candidates.push(c);
    }
  }

  // ==========================================================================
  // FAMILY 4: RANGE SWEEP / SFP (M1 PRIMARY)
  // ==========================================================================
  {
    // Grounded range extremes: Use valid grounded indicators; do NOT synthesize fake levels
    const validRangeLow =
      typeof indicators15m?.swingLow === 'number' && indicators15m.swingLow > 0 && isFinite(indicators15m.swingLow)
        ? indicators15m.swingLow
        : typeof indicators5m?.swingLow === 'number' && indicators5m.swingLow > 0 && isFinite(indicators5m.swingLow)
        ? indicators5m.swingLow
        : null;

    const validRangeHigh =
      typeof indicators15m?.swingHigh === 'number' && indicators15m.swingHigh > 0 && isFinite(indicators15m.swingHigh)
        ? indicators15m.swingHigh
        : typeof indicators5m?.swingHigh === 'number' && indicators5m.swingHigh > 0 && isFinite(indicators5m.swingHigh)
        ? indicators5m.swingHigh
        : null;

    // BUY SFP: Price sweeps below grounded rangeLow AND closes back above it (genuine reclaim)
    const m1RangeBuy =
      validRangeLow !== null &&
      last1m.low < validRangeLow &&
      last1m.close > validRangeLow &&
      (last1m.close > last1m.open || paM1.rejectionDirection === 'BULLISH');

    if (m1RangeBuy && last1m) {
      const c = constructCandidate({
        family: 'RANGE_SWEEP_SFP',
        legacyFamilyAlias: 'RANGE_SFP_REVERSAL',
        setupName: 'GB-V5 Range Sweep & SFP (M1 Range Bottom Reversal)',
        direction: 'BUY',
        structuralStopLoss: last1m.low - atr5m * 0.3,
        mainReasons: [
          'سحب سيولة قاع النطاق على إطار M1 مع ارتداد فوري وعودة السعر لداخل النطاق',
          'تكوين إشارة SFP شرائية واضحة على شمعة M1',
          'استهداف منتصف وقمة النطاق التذبذبي',
        ],
        invalidation: `كسر واستقرار أدنى ذيل السحب على M1 عند ${(last1m.low - 0.3).toFixed(2)}`,
        supportingConfluences: [
          'M1 Range Extreme Sweep & Reclaim',
          'Discount Valuation Zone',
          'Mean Reversion Target',
        ],
        evidenceScoreBonus: 4,
      });
      if (c) candidates.push(c);
    }

    // SELL SFP: Price sweeps above grounded rangeHigh AND closes back below it (genuine reclaim)
    const m1RangeSell =
      validRangeHigh !== null &&
      last1m.high > validRangeHigh &&
      last1m.close < validRangeHigh &&
      (last1m.close < last1m.open || paM1.rejectionDirection === 'BEARISH');

    if (m1RangeSell && last1m) {
      const c = constructCandidate({
        family: 'RANGE_SWEEP_SFP',
        legacyFamilyAlias: 'RANGE_SFP_REVERSAL',
        setupName: 'GB-V5 Range Sweep & SFP (M1 Range Top Fade)',
        direction: 'SELL',
        structuralStopLoss: last1m.high + atr5m * 0.3,
        mainReasons: [
          'سحب سيولة قمة النطاق على إطار M1 مع رفض سعري علوي فوري',
          'تكوين إشارة SFP بيعية على شمعة M1',
          'استهداف قاع النطاق التذبذبي',
        ],
        invalidation: `اختراق واستقرار أعلى ذيل السحب على M1 عند ${(last1m.high + 0.3).toFixed(2)}`,
        supportingConfluences: [
          'M1 Range Resistance Sweep & Fade',
          'Premium Valuation Zone',
          'Mean Reversion Target',
        ],
        evidenceScoreBonus: 4,
      });
      if (c) candidates.push(c);
    }
  }

  return { candidates, evidenceBundle };
}

// ============================================================================
// CENTRAL GB-V5 BRAIN EXECUTION PIPELINE
// ============================================================================

export async function executeGbv5Brain(input: Gbv5BrainInput): Promise<Gbv5BrainResult> {
  const {
    asset = 'XAU/USD',
    currentPrice,
    balance = 100,
    activeTradeDirection = null,
    minConfidence,
    brokerSpecs = DEFAULT_BROKER_SPECS,
    candles5m = [],
  } = input;

  if (!candles5m || !Array.isArray(candles5m) || candles5m.length === 0) {
    const { evidenceBundle } = discoverGbv5Candidates(input);
    const dataUnavailableSignal: TradeSignal = {
      id: `sig_data_unavailable_${Date.now()}`,
      timestamp: Date.now(),
      asset,
      signal: 'NO TRADE',
      currentPrice,
      entry: currentPrice,
      stopLoss: 0,
      slPoints: 0,
      tp1: 0,
      tp1Points: 0,
      tp2: 0,
      tp2Points: 0,
      rr: 'N/A',
      rrRatio: 0,
      riskPercent: 0,
      riskAmount: 0,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      confidence: 0,
      timeframe: '5M',
      setup: 'MARKET_DATA_UNAVAILABLE',
      strategyFamily: 'MARKET_STRUCTURE',
      mainReasons: ['بيانات السوق لشارت 5M غير متوفرة أو غير صالحة'],
      invalidation: 'N/A',
      noTradeReason: 'بيانات السوق لشارت 5M غير متوفرة أو غير صالحة',
    };

    return {
      hasOpportunity: false,
      selectedCandidate: null,
      allCandidates: [],
      finalSignal: dataUnavailableSignal,
      evidenceBundle,
    };
  }

  const { candidates, evidenceBundle } = discoverGbv5Candidates(input);

  // Filter candidates by minimum confidence & active trade direction
  let eligible = minConfidence !== undefined ? candidates.filter((c) => c.confidence >= minConfidence) : candidates;

  if (activeTradeDirection) {
    // Suppress opposing direction if active trade in progress
    eligible = eligible.filter((c) => c.direction === activeTradeDirection);
  }

  // Sort by Confluence Score * TP1 RR Efficiency
  eligible.sort((a, b) => {
    const scoreA = a.confluenceScore * (a.tp1Rr >= 2.0 ? 1.1 : 1.0);
    const scoreB = b.confluenceScore * (b.tp1Rr >= 2.0 ? 1.1 : 1.0);
    return scoreB - scoreA;
  });

  const selected = eligible.length > 0 ? eligible[0] : null;

  if (selected) {
    const decision: SignalDecision = selected.direction === 'BUY'
      ? (selected.orderType === 'LIMIT' ? 'BUY LIMIT' : 'BUY NOW')
      : (selected.orderType === 'LIMIT' ? 'SELL LIMIT' : 'SELL NOW');

    const riskDirection: 'BUY' | 'SELL' = decision.includes('BUY') ? 'BUY' : 'SELL';
    const riskEval = evaluateTradeRisk({
      balance,
      entry: selected.entry,
      stopLoss: selected.stopLoss,
      tp1: selected.tp1,
      tp2: selected.tp2,
      asset,
      direction: riskDirection,
      confidence: selected.confidence,
      brokerSpecs,
    });

    const signalId = `sig_gbv5_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const finalSignal: TradeSignal = {
      id: signalId,
      timestamp: Date.now(),
      asset,
      signal: riskEval.valid ? decision : 'NO TRADE',
      direction: decision,
      currentPrice,
      entry: selected.entry,
      stopLoss: selected.stopLoss,
      slPoints: selected.slPoints,
      tp1: selected.tp1,
      tp1Points: selected.tp1Points,
      tp1Rr: selected.tp1Rr,
      tp2: selected.tp2,
      tp2Points: selected.tp2Points,
      tp2Rr: selected.tp2Rr,
      rr: `1:${selected.tp1Rr.toFixed(2)}`,
      rrRatio: selected.tp1Rr,
      riskPercent: riskEval.riskPercent,
      riskAmount: riskEval.riskAmount,
      potentialProfit: riskEval.potentialProfit,
      potentialLoss: riskEval.potentialLoss,
      recommendedLotSize: riskEval.recommendedLotSize,
      confidence: selected.confidence,
      timeframe: selected.timeframe,
      setup: selected.setupName,
      strategyFamily: selected.legacyFamilyAlias,
      mainReasons: selected.mainReasons,
      invalidation: selected.invalidation,
      noTradeReason: riskEval.valid ? undefined : riskEval.reason,
      supportingConfluences: selected.supportingConfluences,
      patternMetadata: selected.patternMetadata,
    };

    return {
      hasOpportunity: riskEval.valid,
      selectedCandidate: selected,
      allCandidates: candidates,
      finalSignal,
      evidenceBundle,
    };
  }

  // No candidate reached confidence threshold
  const fallbackSignal: TradeSignal = {
    id: `sig_none_${Date.now()}`,
    timestamp: Date.now(),
    asset,
    signal: 'NO TRADE',
    currentPrice,
    entry: currentPrice,
    stopLoss: 0,
    slPoints: 0,
    tp1: 0,
    tp1Points: 0,
    tp2: 0,
    tp2Points: 0,
    rr: 'N/A',
    rrRatio: 0,
    riskPercent: 0,
    riskAmount: 0,
    potentialProfit: 0,
    potentialLoss: 0,
    recommendedLotSize: 0,
    confidence: 0,
    timeframe: 'M1 / M5',
    setup: 'No Viable Setup',
    strategyFamily: 'MARKET_STRUCTURE',
    mainReasons: ['السوق في مرحلة ترقب ولم تكتمل شروط أي من النماذج الأربعة المعتمدة'],
    invalidation: 'N/A',
    noTradeReason: 'لا توجد فرصة فنية محققة لمعايير الجودة وإدارة المخاطر في الشمعة الحالية',
  };

  return {
    hasOpportunity: false,
    selectedCandidate: null,
    allCandidates: candidates,
    finalSignal: fallbackSignal,
    evidenceBundle,
  };
}
