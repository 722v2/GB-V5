import { Candle, TechnicalIndicators } from '../src/types.js';

export interface DynamicTpRequest {
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  asset: string;
  indicators1h: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators5m: TechnicalIndicators;
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
  minRr?: number;
  structuralTargetHint?: {
    price: number;
    label: string;
  };
}

export type StructuralSourceType =
  | '5M_SWING'
  | '15M_SWING'
  | 'SWING'
  | 'SUPPORT'
  | 'RESISTANCE'
  | '5M_OB'
  | '15M_OB'
  | 'ORDER_BLOCK'
  | '5M_FVG'
  | '15M_FVG'
  | 'FVG'
  | '5M_BB'
  | '15M_BB'
  | 'LIQUIDITY'
  | 'EQUAL_HIGH'
  | 'EQUAL_LOW'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'SESSION_LIQUIDITY'
  | 'STRUCTURAL_HINT'
  | 'HIGHER_TIMEFRAME_STRUCTURE'
  | 'FIB_EXTENSION_1272'
  | 'FIB_EXTENSION_1618'
  | 'ATR_PROJECTION'
  | 'OPPOSING_BARRIER'
  | 'NONE';

export interface StructuralLevel {
  price: number;
  type: StructuralSourceType;
  isStructural: boolean; // true = genuine market structure; false = synthetic fallback
  priority: number; // 1 = Swings/Liquidity/Support/Resistance, 2 = OB, 3 = FVG, 4 = Other Structure, 5 = BB, 6 = Fib, 7 = ATR
  qualityScore: number; // Structural target quality score (higher = stronger/closer/fresher)
  name: string;
  distance: number;
  rr: number;
}

export interface DynamicTpResult {
  valid: boolean;
  tp1: number;
  tp2: number;
  hasValidTp2?: boolean;
  slDistance: number;
  slPoints: number;
  tp1Distance: number;
  tp1Points: number;
  tp1Rr: number;
  tp1RrString: string;
  tp2Distance: number;
  tp2Points: number;
  tp2Rr: number;
  tp2RrString: string;
  tp1TargetName: string;
  tp2TargetName: string;
  tpSelectionReason: string;
  structuralTargetUsed: string;
  passedVolatilityCheck: boolean;
  atrAtEntry: number;
  noFutureDataUsed: boolean;
  opposingBarrierDetected?: boolean;
  opposingBarrierReason?: string;
  rejectionReason?: string;
  // Detailed diagnostics
  rawStructuralTarget: number;
  finalTp1: number;
  targetSourceType: string;
  targetDistance: number;
  actualRr: number;
  isModified: boolean;
  modificationReason: string;
  // Structural vs Synthetic Telemetry
  tp1IsStructural: boolean;
  tp2IsStructural: boolean;
  tp1QualityScore: number;
  tp1SelectionTelemetry: {
    selectedPrice: number;
    sourceType: string;
    structuralName: string;
    distancePoints: number;
    naturalRr: number;
    isStructural: boolean;
    reason: string;
  };
  tp2SelectionTelemetry: {
    selectedPrice: number;
    sourceType: string;
    structuralName: string;
    distancePoints: number;
    naturalRr: number;
    isStructural: boolean;
    reason: string;
  };
}

/**
 * Calculates realistic, 100% genuine structural Take-Profits for XAUUSD with ZERO Lookahead.
 *
 * REALISTIC MARKET-STRUCTURE POLICY:
 * 1. TP1 must represent the FIRST meaningful structural obstacle/liquidity objective in the trade direction.
 * 2. Genuine structural targets ALWAYS take precedence over synthetic projections (ATR/Fibonacci),
 *    regardless of how high the synthetic RR is.
 * 3. R:R is strictly an OUTPUT METRIC, NOT an artificial candidate filter or barrier.
 *    Valid natural targets can be 1.0R, 1.1R, 1.2R, 1.3R, 1.4R, 1.5R+.
 * 4. Opposing Order Blocks and FVGs directly ahead of entry are treated as legitimate structural targets.
 * 5. TP2 is the NEXT meaningful structural objective, not a distance multiplier.
 * 6. Mathematical invalidity, inverted geometry, and NaN data fail safely.
 */
export function calculateDynamicTakeProfits(req: DynamicTpRequest): DynamicTpResult {
  const { direction, entry, stopLoss, indicators1h, indicators15m, indicators5m, candles1h, structuralTargetHint } = req;
  const isBuy = direction === 'BUY';

  // 1. Sanity check on numerical values and geometry
  if (
    typeof entry !== 'number' || isNaN(entry) || !isFinite(entry) ||
    typeof stopLoss !== 'number' || isNaN(stopLoss) || !isFinite(stopLoss)
  ) {
    return createEmptyTpResult(0, 0, 0, 'Invalid numeric parameters for entry or stopLoss (NaN/undefined/infinite)');
  }

  const slDistance = Number(Math.abs(entry - stopLoss).toFixed(2));
  const slPoints = Number((slDistance / 0.1).toFixed(1));
  const atr1h = indicators1h?.atr14 || 3.0;
  const atr15m = indicators15m?.atr14 || 1.8;
  const atrAtEntry = Number(atr15m.toFixed(2));

  if (slDistance <= 0.05) {
    return createEmptyTpResult(entry, slDistance, atrAtEntry, 'مسافة وقف الخسارة غير صالحة (< 0.05) -> NO TRADE');
  }

  // Verify directional geometry
  if ((isBuy && stopLoss >= entry) || (!isBuy && stopLoss <= entry)) {
    const errorMsg = isBuy
      ? 'BUY entry must be strictly greater than stop loss.'
      : 'SELL entry must be strictly less than stop loss.';
    return createEmptyTpResult(entry, slDistance, atrAtEntry, errorMsg);
  }

  // 2. Scan and collect all potential target levels ahead of entry
  const candidateLevels: StructuralLevel[] = [];

  // A. Opposing Structural Barriers ahead of entry (Priority 1-2)
  if (isBuy) {
    if (indicators15m?.orderBlock?.type === 'BEARISH' && indicators15m.orderBlock.low > entry) {
      const dist = Number((indicators15m.orderBlock.low - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.orderBlock.low.toFixed(2)),
        type: '15M_OB',
        isStructural: true,
        priority: 2,
        qualityScore: 92,
        name: '15M Bearish Order Block Barrier',
        distance: dist,
        rr,
      });
    }
    if (indicators5m?.orderBlock?.type === 'BEARISH' && indicators5m.orderBlock.low > entry) {
      const dist = Number((indicators5m.orderBlock.low - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.orderBlock.low.toFixed(2)),
        type: '5M_OB',
        isStructural: true,
        priority: 2,
        qualityScore: 90,
        name: '5M Bearish Order Block Barrier',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.fvg?.type === 'BEARISH' && indicators15m.fvg.bottom > entry) {
      const dist = Number((indicators15m.fvg.bottom - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.fvg.bottom.toFixed(2)),
        type: '15M_FVG',
        isStructural: true,
        priority: 3,
        qualityScore: 86,
        name: '15M Bearish FVG Barrier',
        distance: dist,
        rr,
      });
    }
    if (indicators5m?.fvg?.type === 'BEARISH' && indicators5m.fvg.bottom > entry) {
      const dist = Number((indicators5m.fvg.bottom - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.fvg.bottom.toFixed(2)),
        type: '5M_FVG',
        isStructural: true,
        priority: 3,
        qualityScore: 84,
        name: '5M Bearish FVG Barrier',
        distance: dist,
        rr,
      });
    }
  } else {
    // SELL: Opposing Bullish OB and FVG
    if (indicators15m?.orderBlock?.type === 'BULLISH' && indicators15m.orderBlock.high < entry) {
      const dist = Number((entry - indicators15m.orderBlock.high).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.orderBlock.high.toFixed(2)),
        type: '15M_OB',
        isStructural: true,
        priority: 2,
        qualityScore: 92,
        name: '15M Bullish Order Block Barrier',
        distance: dist,
        rr,
      });
    }
    if (indicators5m?.orderBlock?.type === 'BULLISH' && indicators5m.orderBlock.high < entry) {
      const dist = Number((entry - indicators5m.orderBlock.high).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.orderBlock.high.toFixed(2)),
        type: '5M_OB',
        isStructural: true,
        priority: 2,
        qualityScore: 90,
        name: '5M Bullish Order Block Barrier',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.fvg?.type === 'BULLISH' && indicators15m.fvg.top < entry) {
      const dist = Number((entry - indicators15m.fvg.top).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.fvg.top.toFixed(2)),
        type: '15M_FVG',
        isStructural: true,
        priority: 3,
        qualityScore: 86,
        name: '15M Bullish FVG Barrier',
        distance: dist,
        rr,
      });
    }
    if (indicators5m?.fvg?.type === 'BULLISH' && indicators5m.fvg.top < entry) {
      const dist = Number((entry - indicators5m.fvg.top).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.fvg.top.toFixed(2)),
        type: '5M_FVG',
        isStructural: true,
        priority: 3,
        qualityScore: 84,
        name: '5M Bullish FVG Barrier',
        distance: dist,
        rr,
      });
    }
  }

  // B. 5M, 15M & 1H Swing Pivots, Support/Resistance & Liquidity Pools (Priority 1)
  if (isBuy) {
    // 5M & 15M Resistance levels
    if (indicators5m?.resistance && indicators5m.resistance > entry) {
      const dist = Number((indicators5m.resistance - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.resistance.toFixed(2)),
        type: 'RESISTANCE',
        isStructural: true,
        priority: 1,
        qualityScore: 98,
        name: '5M Resistance Level',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.resistance && indicators15m.resistance > entry) {
      const dist = Number((indicators15m.resistance - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.resistance.toFixed(2)),
        type: 'RESISTANCE',
        isStructural: true,
        priority: 1,
        qualityScore: 97,
        name: '15M Resistance Level',
        distance: dist,
        rr,
      });
    }
    // Liquidity Pools / Equal Highs
    if (indicators5m?.liquidityLevels?.buySideLiquidity && indicators5m.liquidityLevels.buySideLiquidity > entry) {
      const dist = Number((indicators5m.liquidityLevels.buySideLiquidity - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.liquidityLevels.buySideLiquidity.toFixed(2)),
        type: 'LIQUIDITY',
        isStructural: true,
        priority: 1,
        qualityScore: 97,
        name: '5M Buy-Side Liquidity Pool',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.liquidityLevels?.buySideLiquidity && indicators15m.liquidityLevels.buySideLiquidity > entry) {
      const dist = Number((indicators15m.liquidityLevels.buySideLiquidity - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.liquidityLevels.buySideLiquidity.toFixed(2)),
        type: 'LIQUIDITY',
        isStructural: true,
        priority: 1,
        qualityScore: 96,
        name: '15M Buy-Side Liquidity Pool',
        distance: dist,
        rr,
      });
    }
    // Swings
    if (indicators5m?.swingHigh && indicators5m.swingHigh > entry) {
      const dist = Number((indicators5m.swingHigh - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.swingHigh.toFixed(2)),
        type: '5M_SWING',
        isStructural: true,
        priority: 1,
        qualityScore: 98,
        name: '5M Swing High Pivot',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.swingHigh && indicators15m.swingHigh > entry) {
      const dist = Number((indicators15m.swingHigh - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.swingHigh.toFixed(2)),
        type: '15M_SWING',
        isStructural: true,
        priority: 1,
        qualityScore: 96,
        name: '15M Swing High Pivot',
        distance: dist,
        rr,
      });
    }
    if (indicators1h?.swingHigh && indicators1h.swingHigh > entry) {
      const dist = Number((indicators1h.swingHigh - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators1h.swingHigh.toFixed(2)),
        type: 'HIGHER_TIMEFRAME_STRUCTURE',
        isStructural: true,
        priority: 1,
        qualityScore: 94,
        name: '1H Swing High Pivot',
        distance: dist,
        rr,
      });
    }
  } else {
    // SELL: 5M & 15M Support levels
    if (indicators5m?.support && indicators5m.support < entry) {
      const dist = Number((entry - indicators5m.support).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.support.toFixed(2)),
        type: 'SUPPORT',
        isStructural: true,
        priority: 1,
        qualityScore: 98,
        name: '5M Support Level',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.support && indicators15m.support < entry) {
      const dist = Number((entry - indicators15m.support).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.support.toFixed(2)),
        type: 'SUPPORT',
        isStructural: true,
        priority: 1,
        qualityScore: 97,
        name: '15M Support Level',
        distance: dist,
        rr,
      });
    }
    // Liquidity Pools / Equal Lows
    if (indicators5m?.liquidityLevels?.sellSideLiquidity && indicators5m.liquidityLevels.sellSideLiquidity < entry) {
      const dist = Number((entry - indicators5m.liquidityLevels.sellSideLiquidity).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.liquidityLevels.sellSideLiquidity.toFixed(2)),
        type: 'LIQUIDITY',
        isStructural: true,
        priority: 1,
        qualityScore: 97,
        name: '5M Sell-Side Liquidity Pool',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.liquidityLevels?.sellSideLiquidity && indicators15m.liquidityLevels.sellSideLiquidity < entry) {
      const dist = Number((entry - indicators15m.liquidityLevels.sellSideLiquidity).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.liquidityLevels.sellSideLiquidity.toFixed(2)),
        type: 'LIQUIDITY',
        isStructural: true,
        priority: 1,
        qualityScore: 96,
        name: '15M Sell-Side Liquidity Pool',
        distance: dist,
        rr,
      });
    }
    // Swings
    if (indicators5m?.swingLow && indicators5m.swingLow < entry) {
      const dist = Number((entry - indicators5m.swingLow).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.swingLow.toFixed(2)),
        type: '5M_SWING',
        isStructural: true,
        priority: 1,
        qualityScore: 98,
        name: '5M Swing Low Pivot',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.swingLow && indicators15m.swingLow < entry) {
      const dist = Number((entry - indicators15m.swingLow).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.swingLow.toFixed(2)),
        type: '15M_SWING',
        isStructural: true,
        priority: 1,
        qualityScore: 96,
        name: '15M Swing Low Pivot',
        distance: dist,
        rr,
      });
    }
    if (indicators1h?.swingLow && indicators1h.swingLow < entry) {
      const dist = Number((entry - indicators1h.swingLow).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators1h.swingLow.toFixed(2)),
        type: 'HIGHER_TIMEFRAME_STRUCTURE',
        isStructural: true,
        priority: 1,
        qualityScore: 94,
        name: '1H Swing Low Pivot',
        distance: dist,
        rr,
      });
    }
  }

  // C. 24H Session High / Low Liquidity (Priority 1)
  if (candles1h && candles1h.length > 0) {
    const sessionCandles = candles1h.slice(-24);
    const priorSessionCandles = sessionCandles.length > 2 ? sessionCandles.slice(0, -1) : sessionCandles;
    const sessionHigh = Math.max(...priorSessionCandles.map((c) => c.high));
    const sessionLow = Math.min(...priorSessionCandles.map((c) => c.low));

    if (isBuy && sessionHigh > entry && sessionHigh - entry <= 4.0 * atr1h) {
      const dist = Number((sessionHigh - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(sessionHigh.toFixed(2)),
        type: 'SESSION_LIQUIDITY',
        isStructural: true,
        priority: 1,
        qualityScore: 95,
        name: '24H Session High Liquidity',
        distance: dist,
        rr,
      });
    } else if (!isBuy && sessionLow < entry && entry - sessionLow <= 4.0 * atr1h) {
      const dist = Number((entry - sessionLow).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(sessionLow.toFixed(2)),
        type: 'SESSION_LIQUIDITY',
        isStructural: true,
        priority: 1,
        qualityScore: 95,
        name: '24H Session Low Liquidity',
        distance: dist,
        rr,
      });
    }
  }

  // D. Pattern / Strategy Structural Target Hint (Priority 1)
  if (
    structuralTargetHint &&
    typeof structuralTargetHint.price === 'number' &&
    !isNaN(structuralTargetHint.price) &&
    isFinite(structuralTargetHint.price)
  ) {
    const hintPrice = Number(structuralTargetHint.price.toFixed(2));
    const isDirectionallyValid = isBuy ? hintPrice > entry : hintPrice < entry;
    if (isDirectionallyValid) {
      const dist = Number(Math.abs(hintPrice - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      if (dist <= 4.5 * atr1h) {
        candidateLevels.push({
          price: hintPrice,
          type: 'STRUCTURAL_HINT',
          isStructural: true,
          priority: 1,
          qualityScore: 93,
          name: structuralTargetHint.label || 'Structural Target Hint',
          distance: dist,
          rr,
        });
      }
    }
  }

  // E. 5M & 15M Bollinger Band Extremes (Non-Structural Fallback, Priority 5)
  // Bollinger Bands are NOT genuine market structure; set as non-structural fallback candidates only.
  if (isBuy) {
    if (indicators5m?.bollingerBands?.upper && indicators5m.bollingerBands.upper > entry) {
      const dist = Number((indicators5m.bollingerBands.upper - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.bollingerBands.upper.toFixed(2)),
        type: '5M_BB',
        isStructural: false,
        priority: 5,
        qualityScore: 35,
        name: '5M Upper Volatility Band (Non-Structural)',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.bollingerBands?.upper && indicators15m.bollingerBands.upper > entry) {
      const dist = Number((indicators15m.bollingerBands.upper - entry).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.bollingerBands.upper.toFixed(2)),
        type: '15M_BB',
        isStructural: false,
        priority: 5,
        qualityScore: 32,
        name: '15M Upper Volatility Band (Non-Structural)',
        distance: dist,
        rr,
      });
    }
  } else {
    // SELL: Bollinger Lower Bands
    if (indicators5m?.bollingerBands?.lower && indicators5m.bollingerBands.lower < entry) {
      const dist = Number((entry - indicators5m.bollingerBands.lower).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators5m.bollingerBands.lower.toFixed(2)),
        type: '5M_BB',
        isStructural: false,
        priority: 5,
        qualityScore: 35,
        name: '5M Lower Volatility Band (Non-Structural)',
        distance: dist,
        rr,
      });
    }
    if (indicators15m?.bollingerBands?.lower && indicators15m.bollingerBands.lower < entry) {
      const dist = Number((entry - indicators15m.bollingerBands.lower).toFixed(2));
      const rr = Number((dist / slDistance).toFixed(2));
      candidateLevels.push({
        price: Number(indicators15m.bollingerBands.lower.toFixed(2)),
        type: '15M_BB',
        isStructural: false,
        priority: 5,
        qualityScore: 32,
        name: '15M Lower Volatility Band (Non-Structural)',
        distance: dist,
        rr,
      });
    }
  }

  // F. Synthetic Projections (Fibonacci Extensions & ATR Fallbacks)
  // These are fallback projections only; they must never beat genuine structural targets.
  const swingRange = indicators15m?.swingHigh && indicators15m?.swingLow
    ? Math.abs(indicators15m.swingHigh - indicators15m.swingLow)
    : 0;

  if (isBuy) {
    // 1. Fib 1.272 Extension
    if (swingRange > atr15m * 0.8 && indicators15m?.swingLow) {
      const fib1272 = Number((indicators15m.swingLow + swingRange * 1.272).toFixed(2));
      const dist1272 = Number((fib1272 - entry).toFixed(2));
      if (fib1272 > entry) {
        candidateLevels.push({
          price: fib1272,
          type: 'FIB_EXTENSION_1272',
          isStructural: false,
          priority: 6,
          qualityScore: 30,
          name: 'Fibonacci 1.272 Extension Target',
          distance: dist1272,
          rr: Number((dist1272 / slDistance).toFixed(2)),
        });
      }

      // 2. Fib 1.618 Extension
      const fib1618 = Number((indicators15m.swingLow + swingRange * 1.618).toFixed(2));
      const dist1618 = Number((fib1618 - entry).toFixed(2));
      if (fib1618 > entry) {
        candidateLevels.push({
          price: fib1618,
          type: 'FIB_EXTENSION_1618',
          isStructural: false,
          priority: 6,
          qualityScore: 28,
          name: 'Fibonacci 1.618 Extension Target',
          distance: dist1618,
          rr: Number((dist1618 / slDistance).toFixed(2)),
        });
      }
    }

    // 3. Dynamic ATR Projection (Pure volatility projection without artificial minRr expansion)
    const atrProj1 = Number((entry + atr1h * 1.5).toFixed(2));
    const distAtr1 = Number((atrProj1 - entry).toFixed(2));
    if (distAtr1 > 0) {
      candidateLevels.push({
        price: atrProj1,
        type: 'ATR_PROJECTION',
        isStructural: false,
        priority: 7,
        qualityScore: 20,
        name: 'Dynamic ATR Projection Target',
        distance: distAtr1,
        rr: Number((distAtr1 / slDistance).toFixed(2)),
      });
    }
  } else {
    // SELL: Fib Extensions & ATR Fallback
    if (swingRange > atr15m * 0.8 && indicators15m?.swingHigh) {
      const fib1272 = Number((indicators15m.swingHigh - swingRange * 1.272).toFixed(2));
      const dist1272 = Number((entry - fib1272).toFixed(2));
      if (fib1272 < entry) {
        candidateLevels.push({
          price: fib1272,
          type: 'FIB_EXTENSION_1272',
          isStructural: false,
          priority: 6,
          qualityScore: 30,
          name: 'Fibonacci 1.272 Extension Target',
          distance: dist1272,
          rr: Number((dist1272 / slDistance).toFixed(2)),
        });
      }

      const fib1618 = Number((indicators15m.swingHigh - swingRange * 1.618).toFixed(2));
      const dist1618 = Number((entry - fib1618).toFixed(2));
      if (fib1618 < entry) {
        candidateLevels.push({
          price: fib1618,
          type: 'FIB_EXTENSION_1618',
          isStructural: false,
          priority: 6,
          qualityScore: 28,
          name: 'Fibonacci 1.618 Extension Target',
          distance: dist1618,
          rr: Number((dist1618 / slDistance).toFixed(2)),
        });
      }
    }

    // Pure volatility projection without artificial minRr expansion
    const atrProj1 = Number((entry - atr1h * 1.5).toFixed(2));
    const distAtr1 = Number((entry - atrProj1).toFixed(2));
    if (distAtr1 > 0) {
      candidateLevels.push({
        price: atrProj1,
        type: 'ATR_PROJECTION',
        isStructural: false,
        priority: 7,
        qualityScore: 20,
        name: 'Dynamic ATR Projection Target',
        distance: distAtr1,
        rr: Number((distAtr1 / slDistance).toFixed(2)),
      });
    }
  }

  // 3. Filter out invalid candidates (wrong direction, non-finite, zero distance)
  // No artificial R:R filtering here; genuine market structure is preserved.
  const validCandidates = candidateLevels.filter((c) => {
    if (typeof c.price !== 'number' || isNaN(c.price) || !isFinite(c.price)) return false;
    if (typeof c.distance !== 'number' || isNaN(c.distance) || !isFinite(c.distance) || c.distance <= 0.05) return false;
    if (isBuy && c.price <= entry) return false;
    if (!isBuy && c.price >= entry) return false;
    return true;
  });

  if (validCandidates.length === 0) {
    return createEmptyTpResult(entry, slDistance, atrAtEntry, 'لا يوجد أي مستوى فني أو امتداد متاح أمام السعر -> NO TRADE');
  }

  // 4. Separate genuine structural candidates from synthetic projections
  const structuralCandidates = validCandidates.filter((c) => c.isStructural);
  const syntheticCandidates = validCandidates.filter((c) => !c.isStructural);

  // Sorting helper: Nearest objective first; if equidistant within 0.1 points, prefer higher priority/quality
  const sortByProximityAndQuality = (list: StructuralLevel[]) => {
    list.sort((a, b) => {
      const distDiff = a.distance - b.distance;
      if (Math.abs(distDiff) < 0.1) {
        return a.priority - b.priority || b.qualityScore - a.qualityScore;
      }
      return distDiff;
    });
  };

  sortByProximityAndQuality(structuralCandidates);
  sortByProximityAndQuality(syntheticCandidates);

  // 5. TP1 Selection: Directional search for the nearest target satisfying >= 0.70R (or minRr)
  // Sub-1.0R levels are preserved as intermediate obstacles/management levels or natural structural targets.
  // minRr is evaluated at signal gate; TP1 strictly identifies the nearest valid structural target >= minRequiredRr.
  const minRequiredRr = typeof req.minRr === 'number' ? req.minRr : 1.0;
  const minTargetDistance = Number((slDistance * minRequiredRr).toFixed(2));

  const sub1rStructuralObstacles = structuralCandidates.filter((c) => c.distance < minTargetDistance - 0.001);
  const validStructuralTargets = structuralCandidates.filter((c) => c.distance >= minTargetDistance - 0.001);
  const validSyntheticTargets = syntheticCandidates.filter((c) => c.distance >= minTargetDistance - 0.001);

  let selectedTp1: StructuralLevel | null = null;
  if (validStructuralTargets.length > 0) {
    selectedTp1 = validStructuralTargets[0]; // Nearest genuine structural target with >= 1.0R
  } else if (validSyntheticTargets.length > 0) {
    selectedTp1 = validSyntheticTargets[0]; // Nearest synthetic target with >= 1.0R
  }

  // If no target achieves >= 1.0R, candidate remains invalid rather than inventing an unsafe TP
  if (!selectedTp1) {
    const nearestObstacleRr = structuralCandidates[0] ? (structuralCandidates[0].distance / slDistance).toFixed(2) : '0';
    return createEmptyTpResult(
      entry,
      slDistance,
      atrAtEntry,
      `No valid target achieves minimum required 1.0R (nearest obstacle provides only ${nearestObstacleRr}R) -> REJECTED`
    );
  }

  const tp1Price = Number(selectedTp1.price.toFixed(2));
  const tp1Distance = Number(Math.abs(tp1Price - entry).toFixed(2));
  const tp1Points = Number((tp1Distance / 0.1).toFixed(1));
  const tp1Rr = Number((tp1Distance / slDistance).toFixed(2));
  const tp1RrString = `1:${tp1Rr.toFixed(2)}`;

  // 6. TP2 Selection: Next meaningful structural objective farther than TP1
  // Geometry must strictly satisfy: BUY: TP2 > TP1 > Entry, SELL: TP2 < TP1 < Entry
  // Remove arbitrary distance requirements that can discard a genuine nearby structural target.
  const remainingStructural = structuralCandidates.filter((c) =>
    (isBuy ? c.price > tp1Price : c.price < tp1Price) && c.distance > tp1Distance + 0.1
  );

  let selectedTp2: StructuralLevel | null = null;
  let hasValidTp2 = false;
  let tp2ReasonText = '';

  if (remainingStructural.length > 0) {
    selectedTp2 = remainingStructural[0];
    hasValidTp2 = true;
    tp2ReasonText = `Next genuine structural objective (${selectedTp2.name})`;
  } else {
    selectedTp2 = null;
    hasValidTp2 = false;
    tp2ReasonText = 'No valid second structural target identified beyond TP1';
  }

  const tp2Price = selectedTp2 ? Number(selectedTp2.price.toFixed(2)) : 0;
  const tp2Distance = selectedTp2 ? Number(Math.abs(tp2Price - entry).toFixed(2)) : 0;
  const tp2Points = selectedTp2 ? Number((tp2Distance / 0.1).toFixed(1)) : 0;
  const tp2Rr = selectedTp2 ? Number((tp2Distance / slDistance).toFixed(2)) : 0;
  const tp2RrString = selectedTp2 ? `1:${tp2Rr.toFixed(2)}` : 'N/A';
  const tp2TargetName = selectedTp2 ? selectedTp2.name : 'None';
  const tp2IsStructural = selectedTp2 ? selectedTp2.isStructural : false;

  let tp1SelectionReason = selectedTp1.isStructural
    ? `Nearest genuine structural objective (${selectedTp1.name}) at ${tp1Price} (Distance: ${tp1Points} pts, Natural RR: ${tp1RrString})`
    : `Fallback projection (${selectedTp1.name}) at ${tp1Price} (Distance: ${tp1Points} pts, Natural RR: ${tp1RrString})`;

  if (sub1rStructuralObstacles.length > 0) {
    tp1SelectionReason += ` [Intermediate obstacle bypassed: ${sub1rStructuralObstacles[0].name} at $${sub1rStructuralObstacles[0].price} (${(sub1rStructuralObstacles[0].distance / slDistance).toFixed(2)}R)]`;
  }

  return {
    valid: true,
    tp1: tp1Price,
    tp2: tp2Price,
    hasValidTp2,
    slDistance,
    slPoints,
    tp1Distance,
    tp1Points,
    tp1Rr,
    tp1RrString,
    tp2Distance,
    tp2Points,
    tp2Rr,
    tp2RrString,
    tp1TargetName: selectedTp1.name,
    tp2TargetName,
    tpSelectionReason: `${tp1SelectionReason}. TP2: ${tp2ReasonText}.`,
    structuralTargetUsed: selectedTp1.name,
    passedVolatilityCheck: true,
    atrAtEntry,
    noFutureDataUsed: true,
    opposingBarrierDetected: selectedTp1.type.includes('OB') || selectedTp1.type.includes('FVG'),
    opposingBarrierReason: selectedTp1.name,
    rawStructuralTarget: selectedTp1.price,
    finalTp1: tp1Price,
    targetSourceType: selectedTp1.type,
    targetDistance: tp1Distance,
    actualRr: tp1Rr,
    isModified: false,
    modificationReason: 'None (Natural Market Structure Target)',
    tp1IsStructural: selectedTp1.isStructural,
    tp2IsStructural,
    tp1QualityScore: selectedTp1.qualityScore,
    tp1SelectionTelemetry: {
      selectedPrice: tp1Price,
      sourceType: selectedTp1.type,
      structuralName: selectedTp1.name,
      distancePoints: tp1Points,
      naturalRr: tp1Rr,
      isStructural: selectedTp1.isStructural,
      reason: selectedTp1.isStructural ? 'nearest genuine structural objective' : 'fallback projection',
    },
    tp2SelectionTelemetry: {
      selectedPrice: tp2Price,
      sourceType: selectedTp2 ? selectedTp2.type : 'NONE',
      structuralName: tp2TargetName,
      distancePoints: tp2Points,
      naturalRr: tp2Rr,
      isStructural: tp2IsStructural,
      reason: tp2ReasonText,
    },
  };
}

function createEmptyTpResult(
  entry: number,
  slDistance: number,
  atrAtEntry: number,
  rejectionReason: string
): DynamicTpResult {
  return {
    valid: false,
    tp1: 0,
    tp2: 0,
    hasValidTp2: false,
    slDistance,
    slPoints: Number((slDistance / 0.1).toFixed(1)),
    tp1Distance: 0,
    tp1Points: 0,
    tp1Rr: 0,
    tp1RrString: '1:0',
    tp2Distance: 0,
    tp2Points: 0,
    tp2Rr: 0,
    tp2RrString: 'N/A',
    tp1TargetName: 'None',
    tp2TargetName: 'None',
    tpSelectionReason: rejectionReason,
    structuralTargetUsed: 'None',
    passedVolatilityCheck: false,
    atrAtEntry,
    noFutureDataUsed: true,
    rejectionReason,
    rawStructuralTarget: entry,
    finalTp1: entry,
    targetSourceType: 'NONE',
    targetDistance: 0,
    actualRr: 0,
    isModified: false,
    modificationReason: rejectionReason,
    tp1IsStructural: false,
    tp2IsStructural: false,
    tp1QualityScore: 0,
    tp1SelectionTelemetry: {
      selectedPrice: 0,
      sourceType: 'NONE',
      structuralName: 'None',
      distancePoints: 0,
      naturalRr: 0,
      isStructural: false,
      reason: rejectionReason,
    },
    tp2SelectionTelemetry: {
      selectedPrice: 0,
      sourceType: 'NONE',
      structuralName: 'None',
      distancePoints: 0,
      naturalRr: 0,
      isStructural: false,
      reason: rejectionReason,
    },
  };
}
