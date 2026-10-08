import { Candle, TechnicalIndicators } from '../src/types.js';

// ============================================================================
// GB-V5 EVIDENCE ENGINE
// Extracts multidimensional, non-blocking evidence across Price Action,
// MACD, RSI, Structure, Liquidity, and Session/Regime context.
// ============================================================================

export interface PriceActionEvidence {
  hasRejectionWick: boolean;
  rejectionWickPercent: number;
  rejectionDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  isEngulfing: boolean;
  engulfingDirection: 'BULLISH' | 'BEARISH' | 'NONE';
  isStrongCandle: boolean;
  bodyToRangeRatio: number;
  bodySizeRelativeAtr: number;
  closeLocationPercent: number; // 0 = low, 100 = high
  hasDisplacement: boolean;
  displacementAtr: number;
  consecutiveMomentumCandles: number;
  relationshipToPrevious: 'HIGHER_HIGH_LOW' | 'LOWER_HIGH_LOW' | 'INSIDE_BAR' | 'OUTSIDE_BAR' | 'NEUTRAL';
  rejectionQualityScore: number; // 0 - 25
  description: string;
}

export interface MacdEvidence {
  macdLine: number;
  signalLine: number;
  histogram: number;
  prevHistogram: number;
  macdVsSignal: 'ABOVE' | 'BELOW' | 'CROSSOVER_BULL' | 'CROSSOVER_BEAR';
  histogramDirection: 'EXPANDING_POSITIVE' | 'CONTRACTING_POSITIVE' | 'EXPANDING_NEGATIVE' | 'CONTRACTING_NEGATIVE';
  histogramAcceleration: 'ACCELERATING' | 'DECELERATING' | 'STEADY';
  zeroLinePosition: 'ABOVE_ZERO' | 'BELOW_ZERO' | 'AT_ZERO';
  zeroLineTransition: 'CROSSED_ABOVE' | 'CROSSED_BELOW' | 'NONE';
  recentCrossoverBarsAgo: number;
  momentumState: 'STRONG_BULLISH' | 'MODERATE_BULLISH' | 'NEUTRAL' | 'MODERATE_BEARISH' | 'STRONG_BEARISH';
  evidenceScore: number; // 0 - 15
  description: string;
}

export interface RsiEvidence {
  rsiValue: number;
  momentumState: 'OVERBOUGHT' | 'BULLISH_MOMENTUM' | 'NEUTRAL' | 'BEARISH_MOMENTUM' | 'OVERSOLD';
  isExhausted: boolean;
  isOverextended: boolean;
  divergence: 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE' | 'NONE';
  evidenceScore: number; // 0 - 10
  description: string;
}

export interface StructureEvidence {
  swingHigh: number;
  swingLow: number;
  structureTrend: 'BULLISH' | 'BEARISH' | 'RANGING';
  hasBos: boolean;
  bosDirection: 'BULLISH' | 'BEARISH' | 'NONE';
  hasChoch: boolean;
  chochDirection: 'BULLISH' | 'BEARISH' | 'NONE';
  isRetestingBreak: boolean;
  retestLevel: number | null;
  hasDisplacement: boolean;
  structuralInvalidationPrice: number;
  evidenceScore: number; // 0 - 25
  description: string;
}

export interface LiquidityEvidence {
  equalHighs: { price: number; touches: number }[];
  equalLows: { price: number; touches: number }[];
  sweptLevel: number | null;
  sweepDirection: 'BUY_SIDE_SWEPT' | 'SELL_SIDE_SWEPT' | 'NONE';
  isSfp: boolean;
  hasReclaimedLevel: boolean;
  reclaimedPrice: number | null;
  internalTarget: number;
  externalTarget: number;
  evidenceScore: number; // 0 - 25
  description: string;
}

export interface SessionRegimeEvidence {
  session: 'ASIAN' | 'LONDON' | 'NY' | 'OVERLAP_LONDON_NY' | 'OFF_HOURS';
  volatilityRegime: 'LOW_COMPRESSION' | 'NORMAL_EXPANSION' | 'HIGH_VOLATILITY' | 'EXTREME_EXPANSION';
  spreadQuality: 'TIGHT' | 'NORMAL' | 'WIDENED' | 'EXCESSIVE';
  evidenceScore: number; // 0 - 10
  description: string;
}

export interface Gbv5EvidenceBundle {
  priceActionM1: PriceActionEvidence;
  priceActionM5: PriceActionEvidence;
  macd: MacdEvidence;
  rsi: RsiEvidence;
  structure: StructureEvidence;
  liquidity: LiquidityEvidence;
  sessionRegime: SessionRegimeEvidence;
  htfContext15m: {
    structure: 'BULLISH' | 'BEARISH' | 'RANGING';
    vwapBias: 'ABOVE_VWAP' | 'BELOW_VWAP';
    emaBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  };
  htfContext1h: {
    structure: 'BULLISH' | 'BEARISH' | 'RANGING';
    trend: 'STRONG_UPTREND' | 'UPTREND' | 'RANGING' | 'DOWNTREND' | 'STRONG_DOWNTREND';
  };
}

// ============================================================================
// EXTRACTOR IMPLEMENTATIONS
// ============================================================================

export function extractPriceActionEvidence(candles: Candle[], atr: number): PriceActionEvidence {
  if (!candles || candles.length === 0) {
    return {
      hasRejectionWick: false,
      rejectionWickPercent: 0,
      rejectionDirection: 'NEUTRAL',
      isEngulfing: false,
      engulfingDirection: 'NONE',
      isStrongCandle: false,
      bodyToRangeRatio: 0,
      bodySizeRelativeAtr: 0,
      closeLocationPercent: 0,
      hasDisplacement: false,
      displacementAtr: 0,
      consecutiveMomentumCandles: 0,
      relationshipToPrevious: 'NEUTRAL',
      rejectionQualityScore: 0,
      description: 'Data unavailable: No candles provided',
    };
  }

  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : last;

  const range = Math.max(0.001, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  const upperWickPct = upperWick / range;
  const lowerWickPct = lowerWick / range;
  const bodyRatio = body / range;
  const bodyAtr = atr > 0 ? body / atr : 0.5;
  const closeLoc = ((last.close - last.low) / range) * 100;

  const hasLowerRejection = lowerWickPct >= 0.35 || (last.close > last.open && lowerWickPct >= 0.25);
  const hasUpperRejection = upperWickPct >= 0.35 || (last.close < last.open && upperWickPct >= 0.25);

  const isBull = last.close > last.open;
  const prevBull = prev.close > prev.open;

  const isEngulfingBull = isBull && !prevBull && last.close > prev.high && last.open <= prev.close;
  const isEngulfingBear = !isBull && prevBull && last.close < prev.low && last.open >= prev.close;

  const hasDisplacement = range >= atr * 1.2 && bodyRatio >= 0.6;
  const isStrong = bodyRatio >= 0.55 && bodyAtr >= 0.7;

  // Relationship to previous
  let rel: PriceActionEvidence['relationshipToPrevious'] = 'NEUTRAL';
  if (last.high > prev.high && last.low > prev.low) rel = 'HIGHER_HIGH_LOW';
  else if (last.high < prev.high && last.low < prev.low) rel = 'LOWER_HIGH_LOW';
  else if (last.high <= prev.high && last.low >= prev.low) rel = 'INSIDE_BAR';
  else if (last.high >= prev.high && last.low <= prev.low) rel = 'OUTSIDE_BAR';

  // Momentum streak
  let streak = 0;
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 5); i--) {
    const c = candles[i];
    if (isBull && c.close > c.open) streak++;
    else if (!isBull && c.close < c.open) streak++;
    else break;
  }

  let qualityScore = 12;
  if (hasLowerRejection || hasUpperRejection) qualityScore += 6;
  if (isEngulfingBull || isEngulfingBear) qualityScore += 5;
  if (hasDisplacement) qualityScore += 2;

  return {
    hasRejectionWick: hasLowerRejection || hasUpperRejection,
    rejectionWickPercent: hasLowerRejection ? lowerWickPct : upperWickPct,
    rejectionDirection: hasLowerRejection ? 'BULLISH' : hasUpperRejection ? 'BEARISH' : 'NEUTRAL',
    isEngulfing: isEngulfingBull || isEngulfingBear,
    engulfingDirection: isEngulfingBull ? 'BULLISH' : isEngulfingBear ? 'BEARISH' : 'NONE',
    isStrongCandle: isStrong,
    bodyToRangeRatio: Math.round(bodyRatio * 100) / 100,
    bodySizeRelativeAtr: Math.round(bodyAtr * 100) / 100,
    closeLocationPercent: Math.round(closeLoc),
    hasDisplacement,
    displacementAtr: Math.round((range / Math.max(0.1, atr)) * 10) / 10,
    consecutiveMomentumCandles: streak,
    relationshipToPrevious: rel,
    rejectionQualityScore: Math.min(25, qualityScore),
    description: `PA: ${isBull ? 'Bullish' : 'Bearish'} bar (body ${(bodyRatio * 100).toFixed(0)}%, close @ ${closeLoc.toFixed(0)}%, streak ${streak})`,
  };
}

export function extractMacdEvidence(ind: TechnicalIndicators): MacdEvidence {
  if (!ind || ind.isDataSufficient === false || !ind.macd) {
    return {
      macdLine: 0,
      signalLine: 0,
      histogram: 0,
      prevHistogram: 0,
      macdVsSignal: 'BELOW',
      histogramDirection: 'CONTRACTING_NEGATIVE',
      histogramAcceleration: 'STEADY',
      zeroLinePosition: 'AT_ZERO',
      zeroLineTransition: 'NONE',
      recentCrossoverBarsAgo: 0,
      momentumState: 'NEUTRAL',
      evidenceScore: 0,
      description: 'MACD: Data unavailable or insufficient',
    };
  }

  const macdObj = ind.macd || { macd: 0, signal: 0, histogram: 0 };
  const macdLine = Number((macdObj.macd ?? 0).toFixed(3));
  const signalLine = Number((macdObj.signal ?? 0).toFixed(3));
  const hist = Number((macdObj.histogram ?? (macdLine - signalLine)).toFixed(3));
  const prevHist = hist * 0.9; // estimate if historical series not provided

  const isAboveSignal = macdLine > signalLine;
  const isAboveZero = macdLine > 0;
  const isHistPositive = hist > 0;

  let histDir: MacdEvidence['histogramDirection'] = 'EXPANDING_POSITIVE';
  if (isHistPositive) {
    histDir = hist >= prevHist ? 'EXPANDING_POSITIVE' : 'CONTRACTING_POSITIVE';
  } else {
    histDir = hist <= prevHist ? 'EXPANDING_NEGATIVE' : 'CONTRACTING_NEGATIVE';
  }

  let momentum: MacdEvidence['momentumState'] = 'NEUTRAL';
  if (isAboveZero && isAboveSignal && isHistPositive) momentum = 'STRONG_BULLISH';
  else if (isAboveSignal || isHistPositive) momentum = 'MODERATE_BULLISH';
  else if (!isAboveZero && !isAboveSignal && !isHistPositive) momentum = 'STRONG_BEARISH';
  else if (!isAboveSignal || !isHistPositive) momentum = 'MODERATE_BEARISH';

  let score = 8;
  if (momentum === 'STRONG_BULLISH' || momentum === 'STRONG_BEARISH') score = 15;
  else if (momentum === 'MODERATE_BULLISH' || momentum === 'MODERATE_BEARISH') score = 12;

  return {
    macdLine,
    signalLine,
    histogram: hist,
    prevHistogram: prevHist,
    macdVsSignal: isAboveSignal ? 'ABOVE' : 'BELOW',
    histogramDirection: histDir,
    histogramAcceleration: Math.abs(hist) >= Math.abs(prevHist) ? 'ACCELERATING' : 'DECELERATING',
    zeroLinePosition: isAboveZero ? 'ABOVE_ZERO' : macdLine < 0 ? 'BELOW_ZERO' : 'AT_ZERO',
    zeroLineTransition: 'NONE',
    recentCrossoverBarsAgo: 2,
    momentumState: momentum,
    evidenceScore: score,
    description: `MACD: ${momentum} (MACD: ${macdLine}, Sig: ${signalLine}, Hist: ${hist})`,
  };
}

export function extractRsiEvidence(ind: TechnicalIndicators): RsiEvidence {
  if (!ind || ind.isDataSufficient === false || typeof ind.rsi14 !== 'number') {
    return {
      rsiValue: 50,
      momentumState: 'NEUTRAL',
      isExhausted: false,
      isOverextended: false,
      divergence: 'NONE',
      evidenceScore: 0,
      description: 'RSI(14): Data unavailable or insufficient',
    };
  }

  const rsi = Number((ind.rsi14 ?? 50).toFixed(1));
  let state: RsiEvidence['momentumState'] = 'NEUTRAL';
  let isExhausted = false;
  let isOverextended = false;

  if (rsi >= 70) {
    state = 'OVERBOUGHT';
    isOverextended = true;
    if (rsi >= 78) isExhausted = true;
  } else if (rsi >= 55) {
    state = 'BULLISH_MOMENTUM';
  } else if (rsi <= 30) {
    state = 'OVERSOLD';
    isOverextended = true;
    if (rsi <= 22) isExhausted = true;
  } else if (rsi <= 45) {
    state = 'BEARISH_MOMENTUM';
  }

  let score = 7;
  if (state === 'BULLISH_MOMENTUM' || state === 'BEARISH_MOMENTUM') score = 9;
  else if (isOverextended) score = 10;

  return {
    rsiValue: rsi,
    momentumState: state,
    isExhausted,
    isOverextended,
    divergence: 'NONE',
    evidenceScore: score,
    description: `RSI(14): ${rsi} [${state}]`,
  };
}

export function extractStructureEvidence(
  currentPrice: number,
  ind15m: TechnicalIndicators,
  ind5m: TechnicalIndicators,
  atr: number
): StructureEvidence {
  if (
    (!ind15m || ind15m.isDataSufficient === false) &&
    (!ind5m || ind5m.isDataSufficient === false)
  ) {
    return {
      swingHigh: currentPrice,
      swingLow: currentPrice,
      structureTrend: 'RANGING',
      hasBos: false,
      bosDirection: 'NONE',
      hasChoch: false,
      chochDirection: 'NONE',
      isRetestingBreak: false,
      retestLevel: null,
      hasDisplacement: false,
      structuralInvalidationPrice: currentPrice,
      evidenceScore: 0,
      description: 'Structure: Data unavailable or insufficient',
    };
  }

  const swingH = ind15m.swingHigh || ind5m.swingHigh || currentPrice + atr * 2;
  const swingL = ind15m.swingLow || ind5m.swingLow || currentPrice - atr * 2;
  const trend = ind15m.structure || 'RANGING';

  const isBreakingHigh = currentPrice >= swingH - 0.2;
  const isBreakingLow = currentPrice <= swingL + 0.2;

  let score = 18;
  if (trend === 'BULLISH' || trend === 'BEARISH') score += 4;
  if (isBreakingHigh || isBreakingLow) score += 3;

  return {
    swingHigh: swingH,
    swingLow: swingL,
    structureTrend: trend,
    hasBos: isBreakingHigh || isBreakingLow,
    bosDirection: isBreakingHigh ? 'BULLISH' : isBreakingLow ? 'BEARISH' : 'NONE',
    hasChoch: ind15m.chochDetected ?? false,
    chochDirection: ind15m.structure === 'BULLISH' ? 'BULLISH' : ind15m.structure === 'BEARISH' ? 'BEARISH' : 'NONE',
    isRetestingBreak: Math.abs(currentPrice - swingH) <= atr * 0.8 || Math.abs(currentPrice - swingL) <= atr * 0.8,
    retestLevel: Math.abs(currentPrice - swingH) <= atr * 0.8 ? swingH : Math.abs(currentPrice - swingL) <= atr * 0.8 ? swingL : null,
    hasDisplacement: true,
    structuralInvalidationPrice: trend === 'BULLISH' ? swingL : swingH,
    evidenceScore: Math.min(25, score),
    description: `Structure: ${trend} (H: ${swingH.toFixed(2)}, L: ${swingL.toFixed(2)})`,
  };
}

export function extractLiquidityEvidence(
  currentPrice: number,
  candles5m: Candle[],
  ind15m: TechnicalIndicators
): LiquidityEvidence {
  if (!candles5m || candles5m.length === 0) {
    return {
      equalHighs: [],
      equalLows: [],
      sweptLevel: null,
      sweepDirection: 'NONE',
      isSfp: false,
      hasReclaimedLevel: false,
      reclaimedPrice: null,
      internalTarget: currentPrice,
      externalTarget: currentPrice,
      evidenceScore: 0,
      description: 'Liquidity: No 5M candle data available',
    };
  }

  const recent = candles5m.slice(-30);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const maxH = highs.length > 0 ? Math.max(...highs) : currentPrice + 4;
  const minL = lows.length > 0 ? Math.min(...lows) : currentPrice - 4;

  const last = recent.length > 0 ? recent[recent.length - 1] : null;
  const isBuySweep = last ? last.low < minL && last.close > minL : false;
  const isSellSweep = last ? last.high > maxH && last.close < maxH : false;

  let score = 18;
  if (isBuySweep || isSellSweep) score = 24;

  return {
    equalHighs: [{ price: maxH, touches: 2 }],
    equalLows: [{ price: minL, touches: 2 }],
    sweptLevel: isBuySweep ? minL : isSellSweep ? maxH : null,
    sweepDirection: isBuySweep ? 'SELL_SIDE_SWEPT' : isSellSweep ? 'BUY_SIDE_SWEPT' : 'NONE',
    isSfp: isBuySweep || isSellSweep,
    hasReclaimedLevel: isBuySweep || isSellSweep,
    reclaimedPrice: isBuySweep ? minL : isSellSweep ? maxH : null,
    internalTarget: maxH,
    externalTarget: minL,
    evidenceScore: score,
    description: `Liquidity: ${isBuySweep ? 'Sell-side liquidity swept' : isSellSweep ? 'Buy-side liquidity swept' : 'Range liquidity resting'}`,
  };
}

export function extractSessionRegimeEvidence(currentSpread = 0.15): SessionRegimeEvidence {
  const now = new Date();
  const utcHour = now.getUTCHours();

  let session: SessionRegimeEvidence['session'] = 'LONDON';
  if (utcHour >= 0 && utcHour < 7) session = 'ASIAN';
  else if (utcHour >= 7 && utcHour < 12) session = 'LONDON';
  else if (utcHour >= 12 && utcHour < 17) session = 'OVERLAP_LONDON_NY';
  else if (utcHour >= 17 && utcHour < 21) session = 'NY';
  else session = 'OFF_HOURS';

  const spreadQuality: SessionRegimeEvidence['spreadQuality'] =
    currentSpread <= 0.2 ? 'TIGHT' : currentSpread <= 0.45 ? 'NORMAL' : currentSpread <= 0.65 ? 'WIDENED' : 'EXCESSIVE';

  return {
    session,
    volatilityRegime: session === 'OVERLAP_LONDON_NY' ? 'HIGH_VOLATILITY' : 'NORMAL_EXPANSION',
    spreadQuality,
    evidenceScore: spreadQuality === 'TIGHT' || spreadQuality === 'NORMAL' ? 10 : 6,
    description: `Session: ${session} | Spread: ${spreadQuality} (${currentSpread})`,
  };
}

export function buildCompleteEvidenceBundle(params: {
  currentPrice: number;
  candles1m: Candle[];
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  indicators5m: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators1h: TechnicalIndicators;
  currentSpread?: number;
}): Gbv5EvidenceBundle {
  const { currentPrice, candles1m = [], candles5m = [], indicators5m, indicators15m, indicators1h, currentSpread = 0.15 } = params;
  const atr5m = indicators5m?.atr14 || 1.5;
  const atr1m = atr5m * 0.45;

  return {
    priceActionM1: extractPriceActionEvidence(candles1m, atr1m),
    priceActionM5: extractPriceActionEvidence(candles5m, atr5m),
    macd: extractMacdEvidence(indicators5m),
    rsi: extractRsiEvidence(indicators5m),
    structure: extractStructureEvidence(currentPrice, indicators15m, indicators5m, atr5m),
    liquidity: extractLiquidityEvidence(currentPrice, candles5m, indicators15m),
    sessionRegime: extractSessionRegimeEvidence(currentSpread),
    htfContext15m: {
      structure: indicators15m?.structure || 'RANGING',
      vwapBias: currentPrice > (indicators15m?.vwap || currentPrice) ? 'ABOVE_VWAP' : 'BELOW_VWAP',
      emaBias: (indicators15m?.ema20 || 0) > (indicators15m?.ema50 || 0) ? 'BULLISH' : 'BEARISH',
    },
    htfContext1h: {
      structure: indicators1h?.structure || 'RANGING',
      trend: (indicators1h?.marketRegime as any) || 'RANGING',
    },
  };
}
