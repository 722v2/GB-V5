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
import { partition5mCandles } from './candleUtils.js';

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

  const atr5m = Math.max(0.6, indicators5m?.atr14 || 1.8);
  const atr15m = Math.max(1.0, indicators15m?.atr14 || 2.5);

  if (!candles5m || !Array.isArray(candles5m) || candles5m.length === 0) {
    const evidenceBundle = buildCompleteEvidenceBundle({
      currentPrice,
      candles1m,
      candles5m: [],
      candles15m,
      candles1h,
      indicators5m,
      indicators15m,
      indicators1h,
      currentSpread,
    });
    return { candidates: [], evidenceBundle };
  }

  const partition5m = partition5mCandles(candles5m);
  const closed5m = partition5m.closedCandles || [];
  const last5m = partition5m.lastClosedCandle || candles5m[candles5m.length - 1];
  const prev5m = partition5m.prevClosedCandle || last5m;

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
  }): Gbv5Candidate => {
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
      if (sl >= currentPrice) sl = currentPrice - (atr5m * 1.5);
    } else {
      if (sl <= currentPrice) sl = currentPrice + (atr5m * 1.5);
    }

    const slDist = Math.abs(currentPrice - sl);
    const slPts = Math.round((slDist / 0.1) * 10) / 10;

    // Calculate TP targets via structural tpEngine
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

    let tp1 = tpRes.tp1;
    let tp2 = tpRes.tp2;
    let tp1Rr = tpRes.tp1Rr;
    let tp2Rr = tpRes.tp2Rr;

    if (!tpRes.valid || tp1Rr < 1.0) {
      if (direction === 'BUY') {
        tp1 = currentPrice + (slDist * 1.5);
        tp2 = currentPrice + (slDist * 2.8);
      } else {
        tp1 = currentPrice - (slDist * 1.5);
        tp2 = currentPrice - (slDist * 2.8);
      }
      tp1Rr = 1.5;
      tp2Rr = 2.8;
    }

    const tp1Pts = Math.round((Math.abs(tp1 - currentPrice) / 0.1) * 10) / 10;
    const tp2Pts = Math.round((Math.abs(tp2 - currentPrice) / 0.1) * 10) / 10;

    // Additive Confluence Score (0 - 100)
    const baseScore =
      structEv.evidenceScore +
      liqEv.evidenceScore +
      paM5.rejectionQualityScore +
      macdEv.evidenceScore +
      rsiEv.evidenceScore +
      sessEv.evidenceScore +
      evidenceScoreBonus;

    const totalConfluence = Math.min(100, Math.max(50, Math.round(baseScore * 0.95)));
    const confidence = Math.min(95, Math.max(70, totalConfluence));

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
        priceAction: paM1.hasRejectionWick ? paM1 : paM5,
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
  // FAMILY 1: LIQUIDITY SWEEP + REJECTION
  // ==========================================================================
  {
    // Bullish Liquidity Sweep (Swept swing low / session low and reclaimed)
    const isBullSweep =
      liqEv.sweepDirection === 'SELL_SIDE_SWEPT' ||
      paM5.rejectionDirection === 'BULLISH' ||
      (last5m.low < structEv.swingLow && last5m.close > structEv.swingLow);

    if (isBullSweep) {
      candidates.push(
        constructCandidate({
          family: 'LIQUIDITY_SWEEP_REJECTION',
          legacyFamilyAlias: 'LIQUIDITY_SWEEP',
          setupName: 'GB-V5 Liquidity Sweep & Rejection (Bullish SFP)',
          direction: 'BUY',
          structuralStopLoss: Math.min(last5m.low, prev5m.low) - atr5m * 0.3,
          mainReasons: [
            'سحب سيولة بيعية أسفل قاع محوري مع فشل الاستقرار وإغلاق فوري داخل النطاق',
            'ظهور ذيل رفض سفلي قوي يؤكد امتصاص عروض البيع ودخول صناع السوق',
            'استهداف سيولة القمم المعاكسة مع معدل عائد إلى مخاطرة متفوق',
          ],
          invalidation: `كسر أدنى نقطة لذيل السحب عند ${(Math.min(last5m.low, prev5m.low) - 0.5).toFixed(2)}`,
          supportingConfluences: [
            'Sell-Side Liquidity Purge',
            'Bullish Rejection Wick & Reclaim',
            'Asymmetric Risk-Reward Potential',
          ],
          evidenceScoreBonus: 5,
        })
      );
    }

    // Bearish Liquidity Sweep (Swept swing high / session high and rejected)
    const isBearSweep =
      liqEv.sweepDirection === 'BUY_SIDE_SWEPT' ||
      paM5.rejectionDirection === 'BEARISH' ||
      (last5m.high > structEv.swingHigh && last5m.close < structEv.swingHigh);

    if (isBearSweep) {
      candidates.push(
        constructCandidate({
          family: 'LIQUIDITY_SWEEP_REJECTION',
          legacyFamilyAlias: 'LIQUIDITY_SWEEP',
          setupName: 'GB-V5 Liquidity Sweep & Rejection (Bearish SFP)',
          direction: 'SELL',
          structuralStopLoss: Math.max(last5m.high, prev5m.high) + atr5m * 0.3,
          mainReasons: [
            'سحب سيولة شرائية أعلى قمة محورية مع رفض سعري علوي فوري',
            'تأكيد استنفاذ المشترين وتمركز أوامر البيع المؤسسية',
            'استهداف مناطق تجميع السيولة البيعية أسفل القيعان السابقة',
          ],
          invalidation: `تجاوز أعلى نقطة لذيل السحب عند ${(Math.max(last5m.high, prev5m.high) + 0.5).toFixed(2)}`,
          supportingConfluences: [
            'Buy-Side Liquidity Purge',
            'Bearish Upper Rejection Wick',
            'Displacement into Value Area',
          ],
          evidenceScoreBonus: 5,
        })
      );
    }
  }

  // ==========================================================================
  // FAMILY 2: STRUCTURE BREAK + RETEST
  // ==========================================================================
  {
    // Bullish BOS / Break & Retest
    const isBullBreak =
      structEv.bosDirection === 'BULLISH' ||
      currentPrice > structEv.swingHigh ||
      (currentPrice >= indicators15m.resistance && last5m.close > last5m.open);

    if (isBullBreak) {
      candidates.push(
        constructCandidate({
          family: 'STRUCTURE_BREAK_RETEST',
          legacyFamilyAlias: 'BREAK_AND_RETEST',
          setupName: 'GB-V5 Structure Break & Retest (Bullish BOS)',
          direction: 'BUY',
          structuralStopLoss: Math.min(last5m.low, structEv.swingHigh - atr5m * 0.8),
          mainReasons: [
            'اختراق مستوى مقاومة هيكلي بشمعة زخم صاعدة قوية وتأكيد كسر القمة',
            'إعادة اختبار منطقة الكسر بنجاح مع تحول المقاومة السابقة إلى دعم فني',
            'استمرار الزخم الهيكلي الإيجابي نحو الأهداف الامتدادية التالية',
          ],
          invalidation: `كسر مستوى الدعم الهيكلي المعاد اختباره عند ${(structEv.swingHigh - 0.8).toFixed(2)}`,
          supportingConfluences: [
            'Break of Structure (BOS)',
            'Support / Resistance Role Reversal',
            'Volume & Momentum Displacement',
          ],
          evidenceScoreBonus: 4,
        })
      );
    }

    // Bearish BOS / Break & Retest
    const isBearBreak =
      structEv.bosDirection === 'BEARISH' ||
      currentPrice < structEv.swingLow ||
      (currentPrice <= indicators15m.support && last5m.close < last5m.open);

    if (isBearBreak) {
      candidates.push(
        constructCandidate({
          family: 'STRUCTURE_BREAK_RETEST',
          legacyFamilyAlias: 'BREAK_AND_RETEST',
          setupName: 'GB-V5 Structure Break & Retest (Bearish BOS)',
          direction: 'SELL',
          structuralStopLoss: Math.max(last5m.high, structEv.swingLow + atr5m * 0.8),
          mainReasons: [
            'كسر مستوى قاع هيكلي رئيسي بشمعة زخم بيعية كاملة وتأكيد تغيير الهيكل',
            'إعادة اختبار مستوى الكسر مع ثبات البائعين وتحول الدعم إلى مقاومة',
            'استهداف مستويات سيولة أعمق مع استمرار الاتجاه الهابط',
          ],
          invalidation: `اختراق مستوى المقاومة الهيكلي المعاد اختباره عند ${(structEv.swingLow + 0.8).toFixed(2)}`,
          supportingConfluences: [
            'Break of Structure (BOS)',
            'Polarity Flip (Support to Resistance)',
            'Directional Bearish Flow',
          ],
          evidenceScoreBonus: 4,
        })
      );
    }
  }

  // ==========================================================================
  // FAMILY 3: TREND CONTINUATION / PULLBACK
  // ==========================================================================
  {
    const is1hBull = indicators1h?.structure === 'BULLISH' || (indicators1h?.ema20 ?? 0) > (indicators1h?.ema50 ?? 0);
    const is1hBear = indicators1h?.structure === 'BEARISH' || (indicators1h?.ema20 ?? 0) < (indicators1h?.ema50 ?? 0);

    // Bullish Pullback
    if (is1hBull || indicators15m.structure === 'BULLISH' || currentPrice > indicators15m.vwap) {
      candidates.push(
        constructCandidate({
          family: 'TREND_CONTINUATION_PULLBACK',
          legacyFamilyAlias: 'MARKET_STRUCTURE',
          setupName: 'GB-V5 Trend Continuation & Value Pullback (Bullish)',
          direction: 'BUY',
          structuralStopLoss: Math.min(indicators5m.swingLow || currentPrice - atr5m * 1.5, currentPrice - atr5m * 1.5),
          mainReasons: [
            'الاتجاه الهيكلي صاعد على الإطار الزمني 1H/15M مع تموضع السعر فوق متوسطات القيمة',
            'اكتمال تصحيح صحي نحو منطقة القيمة (VWAP / EMA Support) مع رفض سعري سفلي',
            'ظهور إشارة تأكيد زخم شرائي تدعم استمرار الموجة الدافعة نحو القمم السابقة',
          ],
          invalidation: `إغلاق شمعة 5M كاملة أسفل مستوى الدعم عند ${(currentPrice - atr5m * 2.0).toFixed(2)}`,
          supportingConfluences: [
            '1H / 15M Trend Alignment',
            'Value Area Equilibrium (VWAP / EMA)',
            'Healthy Corrective Pullback',
          ],
          evidenceScoreBonus: 3,
        })
      );
    }

    // Bearish Pullback
    if (is1hBear || indicators15m.structure === 'BEARISH' || currentPrice < indicators15m.vwap) {
      candidates.push(
        constructCandidate({
          family: 'TREND_CONTINUATION_PULLBACK',
          legacyFamilyAlias: 'MARKET_STRUCTURE',
          setupName: 'GB-V5 Trend Continuation & Value Pullback (Bearish)',
          direction: 'SELL',
          structuralStopLoss: Math.max(indicators5m.swingHigh || currentPrice + atr5m * 1.5, currentPrice + atr5m * 1.5),
          mainReasons: [
            'الاتجاه الهيكلي هابط على الإطار الزمني 1H/15M مع سيطرة بيعية واضحة',
            'ارتداد تصحيحي لاختبار مناطق المقاومة الحركية (VWAP / EMA Resistance)',
            'تأكيد فشل الصعود مع تكوين ذيل رفض علوي أو شمعة ابتلاعية هابطة',
          ],
          invalidation: `إغلاق شمعة 5M كاملة أعلى مستوى المقاومة عند ${(currentPrice + atr5m * 2.0).toFixed(2)}`,
          supportingConfluences: [
            '1H / 15M Bearish Structure Alignment',
            'Dynamic Resistance Rejection',
            'Momentum Continuation Flow',
          ],
          evidenceScoreBonus: 3,
        })
      );
    }
  }

  // ==========================================================================
  // FAMILY 4: RANGE SWEEP / SFP
  // ==========================================================================
  {
    const rangeDiff = indicators15m.swingHigh && indicators15m.swingLow
      ? indicators15m.swingHigh - indicators15m.swingLow
      : atr15m * 3;

    // Range Bottom Sweep & Reversal
    if (indicators15m.premiumDiscountZone === 'DISCOUNT' || currentPrice <= (indicators15m.swingLow || currentPrice - atr15m) + rangeDiff * 0.35) {
      candidates.push(
        constructCandidate({
          family: 'RANGE_SWEEP_SFP',
          legacyFamilyAlias: 'RANGE_SFP_REVERSAL',
          setupName: 'GB-V5 Range Sweep & SFP (Range Bottom Reversal)',
          direction: 'BUY',
          structuralStopLoss: (indicators15m.swingLow || currentPrice - atr15m * 1.5) - atr5m * 0.4,
          mainReasons: [
            'سحب سيولة قاع النطاق التذبذبي مع عودة السعر داخل حدود القيمة العادلة',
            'تموضع ممتاز في منطقة الخصم (Discount Valuation) مع عائد إلى مخاطرة كبير',
            'استهداف منتصف وقمة النطاق التذبذبي (Range High Target)',
          ],
          invalidation: `كسر واستقرار أسفل قاع النطاق عند ${((indicators15m.swingLow || currentPrice - atr15m) - 0.5).toFixed(2)}`,
          supportingConfluences: [
            'Range Extreme Sweep',
            'Mean Reversion Equilibrium',
            'Discount Valuation Zone',
          ],
          evidenceScoreBonus: 4,
        })
      );
    }

    // Range Top Sweep & Fade
    if (indicators15m.premiumDiscountZone === 'PREMIUM' || currentPrice >= (indicators15m.swingHigh || currentPrice + atr15m) - rangeDiff * 0.35) {
      candidates.push(
        constructCandidate({
          family: 'RANGE_SWEEP_SFP',
          legacyFamilyAlias: 'RANGE_SFP_REVERSAL',
          setupName: 'GB-V5 Range Sweep & SFP (Range Top Fade)',
          direction: 'SELL',
          structuralStopLoss: (indicators15m.swingHigh || currentPrice + atr15m * 1.5) + atr5m * 0.4,
          mainReasons: [
            'سحب سيولة قمة النطاق التذبذبي مع ظهور ذيول رفض علوية واضحة',
            'تموضع في منطقة العلاوة (Premium Valuation) مع تناقص الزخم الشرائي',
            'استهداف قاع النطاق التذبذبي مع حماية محكمة لرأس المال',
          ],
          invalidation: `اختراق واستقرار أعلى قمة النطاق عند ${((indicators15m.swingHigh || currentPrice + atr15m) + 0.5).toFixed(2)}`,
          supportingConfluences: [
            'Range Resistance Sweep',
            'Premium Valuation Zone',
            'Mean Reversion Target',
          ],
          evidenceScoreBonus: 4,
        })
      );
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
    minConfidence = 70,
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
  let eligible = candidates.filter((c) => c.confidence >= minConfidence);

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
