import { Candle, TechnicalIndicators } from '../src/types.js';

declare module '../src/types.js' {
  interface TechnicalIndicators {
    isDataSufficient?: boolean;
  }
}

// Calculate Exponential Moving Average (EMA) with standard SMA seeding
export function calculateEMA(prices: number[], period: number): number[] {
  if (!prices || prices.length < period || period <= 0) return [];
  
  // Find index of first valid finite price
  let validStart = -1;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] !== undefined && Number.isFinite(prices[i])) {
      validStart = i;
      break;
    }
  }

  if (validStart === -1 || (prices.length - validStart) < period) {
    return [];
  }

  // Check that initial seeding window of N prices are all finite
  let sum = 0;
  for (let i = validStart; i < validStart + period; i++) {
    if (prices[i] === undefined || !Number.isFinite(prices[i])) {
      return [];
    }
    sum += prices[i];
  }

  const emaArray: number[] = new Array(prices.length);
  const sma = sum / period;
  emaArray[validStart + period - 1] = sma;

  const k = 2 / (period + 1);
  for (let i = validStart + period; i < prices.length; i++) {
    const val = prices[i];
    const prevEma = emaArray[i - 1];
    if (val !== undefined && Number.isFinite(val) && prevEma !== undefined && Number.isFinite(prevEma)) {
      emaArray[i] = val * k + prevEma * (1 - k);
    }
  }

  return emaArray;
}

// Calculate Relative Strength Index (RSI 14)
export function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length <= period) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

// Calculate MACD (12, 26, 9)
export function calculateMACD(closes: number[]): {
  macd: number;
  signal: number;
  histogram: number;
  prevHistogram?: number;
  recentCrossoverBarsAgo?: number;
  zeroLineTransition?: 'CROSSED_ABOVE' | 'CROSSED_BELOW' | 'NONE';
} {
  if (!closes || closes.length < 26) {
    return { macd: 0, signal: 0, histogram: 0 };
  }
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  
  if (ema12.length === 0 || ema26.length === 0) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const macdLine: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] !== undefined && ema26[i] !== undefined) {
      macdLine[i] = ema12[i] - ema26[i];
    }
  }
  
  const signalLine = calculateEMA(macdLine, 9);
  const lastIdx = closes.length - 1;
  const latestMacd = macdLine[lastIdx];

  if (latestMacd === undefined || !Number.isFinite(latestMacd)) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const latestSignal = signalLine[lastIdx];
  if (latestSignal === undefined || !Number.isFinite(latestSignal)) {
    return {
      macd: Number(latestMacd.toFixed(3)),
      signal: 0,
      histogram: Number(latestMacd.toFixed(3)),
    };
  }

  const histogram = latestMacd - latestSignal;

  // Build historical series of valid MACD, Signal, and Histogram values across closed history
  const histPoints: { idx: number; macd: number; signal: number; histogram: number }[] = [];
  for (let i = 0; i < closes.length; i++) {
    const m = macdLine[i];
    const s = signalLine[i];
    if (m !== undefined && Number.isFinite(m) && s !== undefined && Number.isFinite(s)) {
      histPoints.push({
        idx: i,
        macd: Number(m.toFixed(3)),
        signal: Number(s.toFixed(3)),
        histogram: Number((m - s).toFixed(3)),
      });
    }
  }

  let prevHistogram: number | undefined = undefined;
  let recentCrossoverBarsAgo: number | undefined = undefined;
  let zeroLineTransition: 'CROSSED_ABOVE' | 'CROSSED_BELOW' | 'NONE' | undefined = undefined;

  if (histPoints.length >= 2) {
    const currPoint = histPoints[histPoints.length - 1];
    const prevPoint = histPoints[histPoints.length - 2];
    prevHistogram = prevPoint.histogram;

    // Detect real zeroLineTransition on latest closed candle relative to previous closed candle
    if (prevPoint.macd <= 0 && currPoint.macd > 0) {
      zeroLineTransition = 'CROSSED_ABOVE';
    } else if (prevPoint.macd >= 0 && currPoint.macd < 0) {
      zeroLineTransition = 'CROSSED_BELOW';
    } else {
      zeroLineTransition = 'NONE';
    }

    // Detect recent crossover between MACD line and Signal line looking back across history
    // A crossover at bar step i means (m[i-1] - s[i-1]) and (m[i] - s[i]) have opposite signs
    for (let k = histPoints.length - 1; k >= 1; k--) {
      const pCurr = histPoints[k];
      const pPrev = histPoints[k - 1];
      const diffCurr = pCurr.macd - pCurr.signal;
      const diffPrev = pPrev.macd - pPrev.signal;

      const isCrossover = (diffPrev <= 0 && diffCurr > 0) || (diffPrev >= 0 && diffCurr < 0);
      if (isCrossover) {
        recentCrossoverBarsAgo = (histPoints.length - 1) - k;
        break;
      }
    }
  }

  return {
    macd: Number(latestMacd.toFixed(3)),
    signal: Number(latestSignal.toFixed(3)),
    histogram: Number(histogram.toFixed(3)),
    ...(prevHistogram !== undefined ? { prevHistogram } : {}),
    ...(recentCrossoverBarsAgo !== undefined ? { recentCrossoverBarsAgo } : {}),
    ...(zeroLineTransition !== undefined ? { zeroLineTransition } : {}),
  };
}

// Calculate Average True Range (ATR 14)
export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 1.0;
  const trs: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  
  const initialPeriod = Math.min(period, trs.length);
  let atr = trs.slice(0, initialPeriod).reduce((a, b) => a + b, 0) / initialPeriod;
  
  for (let i = initialPeriod; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  
  return Number(atr.toFixed(2));
}

// Calculate Bollinger Bands (20, 2)
export function calculateBollingerBands(closes: number[], period: number = 20): { upper: number; middle: number; lower: number } {
  if (closes.length === 0) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  
  const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: Number((mean + 2 * stdDev).toFixed(2)),
    middle: Number(mean.toFixed(2)),
    lower: Number((mean - 2 * stdDev).toFixed(2)),
  };
}

// Calculate Volume Weighted Average Price (VWAP) anchored to UTC session start
export function getSessionAnchoredCandles(candles: Candle[]): Candle[] {
  if (!candles || candles.length === 0) return [];
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle || !lastCandle.timestamp) return candles;

  const lastTime = new Date(lastCandle.timestamp);
  const startOfDayUtc = Date.UTC(
    lastTime.getUTCFullYear(),
    lastTime.getUTCMonth(),
    lastTime.getUTCDate(),
    0, 0, 0, 0
  );

  const sessionCandles = candles.filter((c) => c.timestamp && c.timestamp >= startOfDayUtc);
  return sessionCandles.length > 0 ? sessionCandles : candles.slice(-50);
}

export function calculateVWAP(candles: Candle[]): number {
  if (!candles || candles.length === 0) return 0;
  
  const sessionCandles = getSessionAnchoredCandles(candles);
  let cumulativeTypicalPriceVolume = 0;
  let cumulativeVolume = 0;
  
  for (const c of sessionCandles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume && c.volume > 0 ? c.volume : 1;
    cumulativeTypicalPriceVolume += typicalPrice * vol;
    cumulativeVolume += vol;
  }
  
  if (cumulativeVolume === 0) return sessionCandles[sessionCandles.length - 1].close;
  return Number((cumulativeTypicalPriceVolume / cumulativeVolume).toFixed(2));
}

/**
 * Calibrated Equal High / Equal Low (EQH/EQL) Tolerance Model for Gold (XAUUSD)
 * - Floor: 0.20 pts ($0.20) to handle tick micro-fluctuations
 * - Scaling: 0.10 * ATR14
 * - Cap: 0.80 pts ($0.80) maximum tolerance to prevent overly wide pools during volatile periods
 */
export function calculateEqualTolerance(atr: number): number {
  if (!Number.isFinite(atr) || atr <= 0) return 0.20;
  return Math.min(0.80, Math.max(0.20, Number((atr * 0.10).toFixed(2))));
}

// Detect Price Action, SMC/ICT structure, Swing Points, OB, and FVG
export function analyzeTechnicals(candles: Candle[], referenceTime?: number): TechnicalIndicators {
  if (!candles || !Array.isArray(candles) || candles.length === 0) {
    return {
      isDataSufficient: false,
      ema20: 0,
      ema50: 0,
      ema200: 0,
      vwap: 0,
      rsi14: 50,
      macd: { macd: 0, signal: 0, histogram: 0 },
      atr14: 0,
      bollingerBands: { upper: 0, middle: 0, lower: 0 },
      swingHigh: 0,
      swingLow: 0,
      rollingHigh: 0,
      rollingLow: 0,
      structuralSwingHigh: 0,
      structuralSwingLow: 0,
      support: 0,
      resistance: 0,
      structure: 'RANGING',
      marketRegime: 'UNCLEAR',
    };
  }

  // Safety filter: Exclude currently forming candle from indicator calculation
  // so forming spikes cannot create false BOS/CHOCH/latestClose.
  let isLastForming = false;
  if (candles.length > 1) {
    const lastC = candles[candles.length - 1];
    const prevC = candles[candles.length - 2];
    if (lastC.isClosed === false) {
      isLastForming = true;
    } else if (lastC.isClosed !== true && typeof lastC.timestamp === 'number' && typeof prevC.timestamp === 'number') {
      const estimatedTfMs = lastC.timestamp - prevC.timestamp;
      const now = referenceTime !== undefined ? referenceTime : Date.now();
      if (estimatedTfMs > 0 && now < lastC.timestamp + estimatedTfMs) {
        isLastForming = true;
      }
    }
  }

  const effectiveCandles = isLastForming ? candles.slice(0, -1) : candles;
  if (effectiveCandles.length === 0) {
    return {
      isDataSufficient: false,
      ema20: 0,
      ema50: 0,
      ema200: 0,
      vwap: 0,
      rsi14: 50,
      macd: { macd: 0, signal: 0, histogram: 0 },
      atr14: 0,
      bollingerBands: { upper: 0, middle: 0, lower: 0 },
      swingHigh: 0,
      swingLow: 0,
      rollingHigh: 0,
      rollingLow: 0,
      structuralSwingHigh: 0,
      structuralSwingLow: 0,
      support: 0,
      resistance: 0,
      structure: 'RANGING',
      marketRegime: 'UNCLEAR',
    };
  }

  const closes = effectiveCandles.map((c) => c.close);
  const latestClose = closes[closes.length - 1] || 0;
  
  const ema20Arr = calculateEMA(closes, 20);
  const ema50Arr = calculateEMA(closes, 50);
  const ema200Arr = calculateEMA(closes, 200);
  
  const ema20 = Number(((ema20Arr.length > 0 ? ema20Arr[ema20Arr.length - 1] : latestClose) || latestClose).toFixed(2));
  const ema50 = Number(((ema50Arr.length > 0 ? ema50Arr[ema50Arr.length - 1] : latestClose) || latestClose).toFixed(2));
  const ema200 = Number(((ema200Arr.length > 0 ? ema200Arr[ema200Arr.length - 1] : latestClose) || latestClose).toFixed(2));
  
  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const atr14 = calculateATR(effectiveCandles, 14);
  const bollingerBands = calculateBollingerBands(closes, 20);
  const vwap = calculateVWAP(effectiveCandles); // Session-anchored intraday VWAP
  
  // Find Rolling Extremes and Structural Swing Highs/Lows in historical window excluding current candle
  const window = Math.min(30, effectiveCandles.length);
  const recent = effectiveCandles.slice(-window);
  
  // Rolling 30-candle extreme calculated using prior candles (excluding current formation candle)
  const priorCandles = recent.length > 2 ? recent.slice(0, -1) : recent;
  const rollingHigh = Math.max(...priorCandles.map((c) => c.high));
  const rollingLow = Math.min(...priorCandles.map((c) => c.low));

  // Preserve existing swingHigh / swingLow semantics as rolling extremes for backwards compatibility
  const swingHigh = rollingHigh;
  const swingLow = rollingLow;
  
  // Identify Support & Resistance from established swing levels
  const resistance = swingHigh;
  const support = swingLow;
  
  // Determine Market Structure
  let structure: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
  if (latestClose > ema50 && ema20 > ema50) {
    structure = 'BULLISH';
  } else if (latestClose < ema50 && ema20 < ema50) {
    structure = 'BEARISH';
  }
  
  // 5-bar Fractal Swings detection
  const fractalHighs: number[] = [];
  const fractalLows: number[] = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    const isHighPivot =
      c.high >= recent[i - 1].high &&
      c.high >= recent[i - 2].high &&
      c.high >= recent[i + 1].high &&
      c.high >= recent[i + 2].high &&
      (c.high > recent[i - 1].high || c.high > recent[i + 1].high);

    const isLowPivot =
      c.low <= recent[i - 1].low &&
      c.low <= recent[i - 2].low &&
      c.low <= recent[i + 1].low &&
      c.low <= recent[i + 2].low &&
      (c.low < recent[i - 1].low || c.low < recent[i + 1].low);

    if (isHighPivot) {
      fractalHighs.push(Number(c.high.toFixed(2)));
    }
    if (isLowPivot) {
      fractalLows.push(Number(c.low.toFixed(2)));
    }
  }

  // Confirmed Structural Swing High / Low (derived from confirmed 5-bar/3-bar pivot points)
  let structuralSwingHigh = fractalHighs.length > 0 ? fractalHighs[fractalHighs.length - 1] : undefined;
  let structuralSwingLow = fractalLows.length > 0 ? fractalLows[fractalLows.length - 1] : undefined;

  // 3-bar pivot fallback if no 5-bar pivot was formed in the recent window
  if (structuralSwingHigh === undefined) {
    for (let i = recent.length - 2; i >= 1; i--) {
      if (
        recent[i].high >= recent[i - 1].high &&
        recent[i].high >= recent[i + 1].high &&
        (recent[i].high > recent[i - 1].high || recent[i].high > recent[i + 1].high)
      ) {
        structuralSwingHigh = Number(recent[i].high.toFixed(2));
        break;
      }
    }
  }
  if (structuralSwingLow === undefined) {
    for (let i = recent.length - 2; i >= 1; i--) {
      if (
        recent[i].low <= recent[i - 1].low &&
        recent[i].low <= recent[i + 1].low &&
        (recent[i].low < recent[i - 1].low || recent[i].low < recent[i + 1].low)
      ) {
        structuralSwingLow = Number(recent[i].low.toFixed(2));
        break;
      }
    }
  }

  // Fallback to rolling extremes if no confirmed pivots exist
  if (structuralSwingHigh === undefined) structuralSwingHigh = rollingHigh;
  if (structuralSwingLow === undefined) structuralSwingLow = rollingLow;

  // Equal Highs / Lows pools using calibrated tolerance
  const equalHighs: number[] = [];
  const equalLows: number[] = [];
  const eqTolerance = calculateEqualTolerance(atr14);
  for (let i = 0; i < fractalHighs.length; i++) {
    for (let j = i + 1; j < fractalHighs.length; j++) {
      if (Math.abs(fractalHighs[i] - fractalHighs[j]) <= eqTolerance) {
        const avg = Number(((fractalHighs[i] + fractalHighs[j]) / 2).toFixed(2));
        if (!equalHighs.includes(avg)) equalHighs.push(avg);
      }
    }
  }
  for (let i = 0; i < fractalLows.length; i++) {
    for (let j = i + 1; j < fractalLows.length; j++) {
      if (Math.abs(fractalLows[i] - fractalLows[j]) <= eqTolerance) {
        const avg = Number(((fractalLows[i] + fractalLows[j]) / 2).toFixed(2));
        if (!equalLows.includes(avg)) equalLows.push(avg);
      }
    }
  }

  // Asian session High / Low
  let asianHigh: number | null = null;
  let asianLow: number | null = null;
  const asianCandles = recent.filter((c) => {
    if (!c.timestamp) return false;
    const d = new Date(c.timestamp);
    const h = d.getUTCHours();
    return h >= 0 && h < 8;
  });
  if (asianCandles.length >= 3) {
    asianHigh = Math.max(...asianCandles.map((c) => c.high));
    asianLow = Math.min(...asianCandles.map((c) => c.low));
  }

  // Multi-zone Order Block detection (cache of up to 5 unmitigated zones)
  const orderBlocks: NonNullable<TechnicalIndicators['orderBlocks']> = [];
  for (let i = recent.length - 2; i >= 3; i--) {
    const c = recent[i];
    const next = recent[i + 1];
    
    // Bullish OB: Bearish candle followed by strong bullish expansion
    if (c.close < c.open && next.close > c.open && (next.high - next.low) > atr14 * 0.8) {
      const high = Number(Math.max(c.open, c.close).toFixed(2));
      const low = Number(c.low.toFixed(2));
      // Historical candles between OB formation and current retest candle
      const historicalCandles = recent.slice(i + 2, -1);
      const isMitigated = historicalCandles.some((after) => after.low <= high);
      if (!isMitigated && orderBlocks.length < 5) {
        orderBlocks.push({
          type: 'BULLISH',
          high,
          low,
          mitigated: false,
          createdCandleIndex: i,
          strength: Number((next.high - next.low).toFixed(2)),
        });
      }
    }
    // Bearish OB: Bullish candle followed by strong bearish displacement
    if (c.close > c.open && next.close < c.low && (next.high - next.low) > atr14 * 0.8) {
      const high = Number(c.high.toFixed(2));
      const low = Number(Math.min(c.open, c.close).toFixed(2));
      // Historical candles between OB formation and current retest candle
      const historicalCandles = recent.slice(i + 2, -1);
      const isMitigated = historicalCandles.some((after) => after.high >= low);
      if (!isMitigated && orderBlocks.length < 5) {
        orderBlocks.push({
          type: 'BEARISH',
          high,
          low,
          mitigated: false,
          createdCandleIndex: i,
          strength: Number((next.high - next.low).toFixed(2)),
        });
      }
    }
  }
  const orderBlock = orderBlocks.length > 0 ? { type: orderBlocks[0].type, high: orderBlocks[0].high, low: orderBlocks[0].low } : undefined;
  
  // Multi-zone Fair Value Gap (FVG) detection (cache of up to 5 unmitigated zones)
  const fvgZones: NonNullable<TechnicalIndicators['fvgZones']> = [];
  for (let i = recent.length - 2; i >= 2; i--) {
    const c1 = recent[i - 2];
    const c3 = recent[i];
    
    // Bullish FVG: candle 1 high < candle 3 low
    if (c3.low > c1.high && c3.low - c1.high > atr14 * 0.2) {
      const top = Number(c3.low.toFixed(2));
      const bottom = Number(c1.high.toFixed(2));
      // Historical candles between FVG formation and current retest candle
      const historicalCandles = recent.slice(i + 1, -1);
      const isMitigated = historicalCandles.some((after) => after.low <= top);
      if (!isMitigated && fvgZones.length < 5) {
        fvgZones.push({
          type: 'BULLISH',
          top,
          bottom,
          mitigated: false,
          createdCandleIndex: i,
        });
      }
    }
    // Bearish FVG: candle 1 low > candle 3 high
    if (c1.low > c3.high && c1.low - c3.high > atr14 * 0.2) {
      const top = Number(c1.low.toFixed(2));
      const bottom = Number(c3.high.toFixed(2));
      // Historical candles between FVG formation and current retest candle
      const historicalCandles = recent.slice(i + 1, -1);
      const isMitigated = historicalCandles.some((after) => after.high >= bottom);
      if (!isMitigated && fvgZones.length < 5) {
        fvgZones.push({
          type: 'BEARISH',
          top,
          bottom,
          mitigated: false,
          createdCandleIndex: i,
        });
      }
    }
  }
  const fvg = fvgZones.length > 0 ? { type: fvgZones[0].type, top: fvgZones[0].top, bottom: fvgZones[0].bottom } : undefined;
  
  // Enhanced Liquidity Sweep check: Macro swings, fractal swings, EQH/EQL, and Asian session
  const lastCandle = recent[recent.length - 1];
  const prevCandle = recent[recent.length - 2];
  const prevHigh = Math.max(...recent.slice(0, -2).map((c) => c.high));
  const prevLow = Math.min(...recent.slice(0, -2).map((c) => c.low));
  
  let sweptHigh = (lastCandle.high > prevHigh && lastCandle.close < prevHigh) || 
                  (prevCandle && prevCandle.high > prevHigh && lastCandle.close < prevHigh);
  let sweptLow = (lastCandle.low < prevLow && lastCandle.close > prevLow) ||
                 (prevCandle && prevCandle.low < prevLow && lastCandle.close > prevLow);

  let liquiditySweepDetails: TechnicalIndicators['liquiditySweepDetails'] = undefined;
  if (sweptHigh) {
    liquiditySweepDetails = { sweptLevel: prevHigh, levelType: 'MACRO_SWING', direction: 'BEARISH' };
  } else if (sweptLow) {
    liquiditySweepDetails = { sweptLevel: prevLow, levelType: 'MACRO_SWING', direction: 'BULLISH' };
  }

  // Check recent fractal swings if not swept macro
  if (!sweptHigh && !sweptLow) {
    const recentFractalHighs = fractalHighs.slice(-3);
    for (const fh of recentFractalHighs) {
      if ((lastCandle.high > fh && lastCandle.close < fh) || (prevCandle && prevCandle.high > fh && lastCandle.close < fh)) {
        sweptHigh = true;
        liquiditySweepDetails = { sweptLevel: fh, levelType: 'FRACTAL_SWING', direction: 'BEARISH' };
        break;
      }
    }
    const recentFractalLows = fractalLows.slice(-3);
    for (const fl of recentFractalLows) {
      if ((lastCandle.low < fl && lastCandle.close > fl) || (prevCandle && prevCandle.low < fl && lastCandle.close > fl)) {
        sweptLow = true;
        liquiditySweepDetails = { sweptLevel: fl, levelType: 'FRACTAL_SWING', direction: 'BULLISH' };
        break;
      }
    }
  }

  // Check Equal Highs / Lows if not swept
  if (!sweptHigh && !sweptLow) {
    for (const eqh of equalHighs) {
      if ((lastCandle.high > eqh && lastCandle.close < eqh) || (prevCandle && prevCandle.high > eqh && lastCandle.close < eqh)) {
        sweptHigh = true;
        liquiditySweepDetails = { sweptLevel: eqh, levelType: 'EQUAL_HIGHS_LOWS', direction: 'BEARISH' };
        break;
      }
    }
    for (const eql of equalLows) {
      if ((lastCandle.low < eql && lastCandle.close > eql) || (prevCandle && prevCandle.low < eql && lastCandle.close > eql)) {
        sweptLow = true;
        liquiditySweepDetails = { sweptLevel: eql, levelType: 'EQUAL_HIGHS_LOWS', direction: 'BULLISH' };
        break;
      }
    }
  }

  // Check Asian Session High / Low if not swept
  if (!sweptHigh && !sweptLow && asianHigh !== null && asianLow !== null) {
    if ((lastCandle.high > asianHigh && lastCandle.close < asianHigh) || (prevCandle && prevCandle.high > asianHigh && lastCandle.close < asianHigh)) {
      sweptHigh = true;
      liquiditySweepDetails = { sweptLevel: asianHigh, levelType: 'ASIAN_SESSION', direction: 'BEARISH' };
    } else if ((lastCandle.low < asianLow && lastCandle.close > asianLow) || (prevCandle && prevCandle.low < asianLow && lastCandle.close > asianLow)) {
      sweptLow = true;
      liquiditySweepDetails = { sweptLevel: asianLow, levelType: 'ASIAN_SESSION', direction: 'BULLISH' };
    }
  }

  const liquiditySweepDetected = sweptHigh || sweptLow;

  // Compression state calculation
  const compressionBbWidth = bollingerBands.upper - bollingerBands.lower;
  const isCompressed = compressionBbWidth <= atr14 * 2.2;
  const squeezeRatio = Number((compressionBbWidth / Math.max(0.1, atr14)).toFixed(2));
  const expansionTriggered = isCompressed && (lastCandle.close > bollingerBands.upper || lastCandle.close < bollingerBands.lower);
  const compressionState = {
    isCompressed,
    squeezeRatio,
    expansionTriggered,
  };
  
  // Premium / Discount calculation
  const range = swingHigh - swingLow;
  const equilibrium = swingLow + range * 0.5;
  let premiumDiscountZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' = 'EQUILIBRIUM';
  if (range > 0) {
    if (latestClose > equilibrium + range * 0.1) {
      premiumDiscountZone = 'PREMIUM';
    } else if (latestClose < equilibrium - range * 0.1) {
      premiumDiscountZone = 'DISCOUNT';
    }
  }
  
  let structureShift: string | undefined = undefined;
  let chochDetected = false;
  let bosDetected = false;

  // Split recent candles into prior half and current half to determine HH/HL or LH/LL
  const halfWindow = Math.floor(recent.length / 2);
  const priorHalf = recent.slice(0, halfWindow);
  const latterHalf = recent.slice(halfWindow);

  const priorHigh = Math.max(...priorHalf.map((c) => c.high));
  const priorLow = Math.min(...priorHalf.map((c) => c.low));
  const latterHigh = Math.max(...latterHalf.map((c) => c.high));
  const latterLow = Math.min(...latterHalf.map((c) => c.low));

  let trendStructure: 'HH_HL' | 'LH_LL' | 'RANGING' = 'RANGING';
  if (latterHigh > priorHigh && latterLow > priorLow) {
    trendStructure = 'HH_HL'; // Higher Highs & Higher Lows (Bullish Structure)
  } else if (latterHigh < priorHigh && latterLow < priorLow) {
    trendStructure = 'LH_LL'; // Lower Highs & Lower Lows (Bearish Structure)
  }

  let mssDetected = false;
  let mssDirection: 'BULLISH' | 'BEARISH' | undefined = undefined;
  let mssType: string | undefined = undefined;

  // CHOCH (Change of Character): Reversal breaking the structural pivot
  if (trendStructure === 'HH_HL' && latestClose < priorLow) {
    chochDetected = true;
    structureShift = 'Bearish CHOCH (Change of Character)';
  } else if (trendStructure === 'LH_LL' && latestClose > priorHigh) {
    chochDetected = true;
    structureShift = 'Bullish CHOCH (Change of Character)';
  } else if (latestClose > swingHigh) {
    bosDetected = true;
    structureShift = 'Bullish BOS (Break of Structure)';
  } else if (latestClose < swingLow) {
    bosDetected = true;
    structureShift = 'Bearish BOS (Break of Structure)';
  }

  // MSS (Market Structure Shift) after Liquidity Sweep
  if (sweptHigh && latestClose < ema20) {
    mssDetected = true;
    mssDirection = 'BEARISH';
    mssType = 'SWEEP_MSS';
    if (!structureShift) {
      structureShift = 'Bearish MSS after Liquidity Sweep';
    }
  } else if (sweptLow && latestClose > ema20) {
    mssDetected = true;
    mssDirection = 'BULLISH';
    mssType = 'SWEEP_MSS';
    if (!structureShift) {
      structureShift = 'Bullish MSS after Liquidity Sweep';
    }
  }

  let structureEvent: TechnicalIndicators['structureEvent'] = 'NONE';
  if (mssDetected) {
    structureEvent = mssDirection === 'BULLISH' ? 'BULLISH_MSS_SWEEP' : 'BEARISH_MSS_SWEEP';
  } else if (chochDetected) {
    structureEvent = trendStructure === 'HH_HL' ? 'BEARISH_CHOCH' : 'BULLISH_CHOCH';
  } else if (bosDetected) {
    structureEvent = latestClose > swingHigh ? 'BULLISH_BOS' : 'BEARISH_BOS';
  }

  // Liquidity levels: Buy-side liquidity (BSL) above swing highs, Sell-side liquidity (SSL) below swing lows
  const liquidityLevels = {
    buySideLiquidity: Number(swingHigh.toFixed(2)),
    sellSideLiquidity: Number(swingLow.toFixed(2)),
  };

  // =========================================================================
  // MARKET REGIME & OVEREXTENSION DETECTOR ENGINE
  // =========================================================================
  // 1. Calculate Volatility Ratio (current ATR vs 50-period average ATR)
  const longAtr = calculateATR(effectiveCandles, Math.min(50, effectiveCandles.length));
  const volatilityRatio = Number((longAtr > 0 ? atr14 / longAtr : 1.0).toFixed(2));

  // 2. Measure EMA Ribbon alignment & slope
  const isEmaBullishStack = latestClose > ema20 && ema20 > ema50 && (ema200 === 0 || ema50 > ema200);
  const isEmaBearishStack = latestClose < ema20 && ema20 < ema50 && (ema200 === 0 || ema50 < ema200);
  const ema20Ema50Spread = Math.abs(ema20 - ema50);
  const isEmaSpreadExpanding = ema20Ema50Spread >= atr14 * 0.7;

  // 3. Measure Candle Progression (Ratio of trending directional candles in last 12)
  const last12Candles = recent.slice(-12);
  let bullCandlesCount = 0;
  let bearCandlesCount = 0;
  for (const c of last12Candles) {
    if (c.close > c.open) bullCandlesCount++;
    else if (c.close < c.open) bearCandlesCount++;
  }

  // 4. Overextension Detection
  // In Gold (XAUUSD), overextension requires significant point distance (>15.0 pts or >3.5x ATR) or extreme RSI in a stacked trend
  const distFromEma20 = Math.abs(latestClose - ema20);
  const isDistOverextended = distFromEma20 > Math.max(15.0, atr14 * 3.5);
  const isRsiOverextended = (isEmaBullishStack && rsi14 >= 78) || (isEmaBearishStack && rsi14 <= 22);
  const isOverextended = (isEmaBullishStack || isEmaBearishStack || isDistOverextended) && (isDistOverextended || isRsiOverextended);
  let overextensionReason: string | undefined = undefined;
  if (isOverextended) {
    if (isDistOverextended && isRsiOverextended) {
      overextensionReason = `السعر ممتد بشكل حاد بعيداً عن متوسط EMA20 بمقدار $${distFromEma20.toFixed(2)} (>3.5x ATR) مع وصول RSI إلى ${rsi14.toFixed(1)}.`;
    } else if (isDistOverextended) {
      overextensionReason = `السعر ممتد سريعاً بعيداً عن متوسط EMA20 بمقدار $${distFromEma20.toFixed(2)} (>3.5x ATR)؛ ينبغي انتظار تصحيح سطحي قبل الدخول.`;
    } else {
      overextensionReason = `مؤشر القوة النسبية RSI وصل إلى مستوى متطرف (${rsi14.toFixed(1)}) في نهاية الموجة الحالية.`;
    }
  }

  // 5. Compute Trend Strength (0-100)
  let trendStrength = 50;
  if (isEmaBullishStack || isEmaBearishStack) {
    trendStrength += 15;
    if (isEmaSpreadExpanding) trendStrength += 15;
    if (bullCandlesCount >= 8 || bearCandlesCount >= 8) trendStrength += 15;
    if (macd.histogram > 0 && isEmaBullishStack) trendStrength += 5;
    if (macd.histogram < 0 && isEmaBearishStack) trendStrength += 5;
  } else {
    // Ranging / Churn
    const bbWidth = bollingerBands.upper - bollingerBands.lower;
    if (bbWidth < atr14 * 2.5) {
      trendStrength -= 20; // Squeeze / low volatility
    }
  }
  trendStrength = Math.min(100, Math.max(0, trendStrength));

  // 6. Classify Market Regime into the 8 discrete states
  let marketRegime: TechnicalIndicators['marketRegime'] = 'UNCLEAR';
  let recommendedAction: NonNullable<TechnicalIndicators['regimeContext']>['recommendedAction'] = 'NO_EDGE_WAIT';
  let summaryDescription = '';

  const isTransition = chochDetected || (structureShift && structureShift.includes('CHOCH'));
  const bbWidth = bollingerBands.upper - bollingerBands.lower;

  const isContradictoryUptrend = trendStructure === 'HH_HL' && isEmaBearishStack && latestClose < ema50;
  const isContradictoryDowntrend = trendStructure === 'LH_LL' && isEmaBullishStack && latestClose > ema50;

  if (isTransition || isContradictoryUptrend || isContradictoryDowntrend) {
    marketRegime = 'TRANSITION';
    recommendedAction = 'TRANSITION_CONFIRM';
    summaryDescription = `تحول وإعادة ترتيب في هيكل السوق (${isContradictoryUptrend ? 'HH_HL + EMA Bearish' : isContradictoryDowntrend ? 'LH_LL + EMA Bullish' : structureShift})؛ يتطلب تأكيد الاتجاه المستقبلي.`;
  } else if (isEmaBullishStack && trendStructure === 'HH_HL' && trendStrength >= 70) {
    marketRegime = 'STRONG_UPTREND';
    recommendedAction = isOverextended ? 'PULLBACK_WAIT' : 'TREND_CONTINUATION';
    summaryDescription = `اتجاه صاعد قوي متسارع مع سيطرة واضحة للمشترين${isOverextended ? ' (السعر ممتد حالياً - انتظار تراجع تصحيحي)' : ' (فرص استمرار مع التصحيح)'}.`;
  } else if (isEmaBearishStack && trendStructure === 'LH_LL' && trendStrength >= 70) {
    marketRegime = 'STRONG_DOWNTREND';
    recommendedAction = isOverextended ? 'PULLBACK_WAIT' : 'TREND_CONTINUATION';
    summaryDescription = `اتجاه هابط قوي متسارع مع تدفق سيولة بيعية مستمرة${isOverextended ? ' (السعر ممتد حالياً - انتظار تراجع تصحيحي)' : ' (فرص استمرار مع التصحيح)'}.`;
  } else if (trendStructure === 'HH_HL' && (isEmaBullishStack || latestClose >= ema50)) {
    marketRegime = 'WEAK_UPTREND';
    recommendedAction = 'TREND_CONTINUATION';
    summaryDescription = 'اتجاه صاعد معتدل أو متذبذب مع تصحيحات أعمق تناسب استراتيجيات مناطق الـ Discount و OTE.';
  } else if (trendStructure === 'LH_LL' && (isEmaBearishStack || latestClose <= ema50)) {
    marketRegime = 'WEAK_DOWNTREND';
    recommendedAction = 'TREND_CONTINUATION';
    summaryDescription = 'اتجاه هابط معتدل أو متذبذب مع تصحيحات أعمق تناسب استراتيجيات مناطق الـ Premium و FVG.';
  } else if (volatilityRatio >= 1.35 || bbWidth >= atr14 * 4.2) {
    marketRegime = 'VOLATILE_RANGE';
    recommendedAction = 'RANGE_EDGES';
    summaryDescription = 'نطاق عرضي عالي التقلب مع ذيول كسر وهمية عند القمم والقيعان؛ التداول على الأطراف وسحب السيولة فقط.';
  } else if (Math.abs(swingHigh - swingLow) >= atr14 * 1.2 || trendStructure === 'RANGING') {
    marketRegime = 'NORMAL_RANGE';
    recommendedAction = 'RANGE_EDGES';
    summaryDescription = 'نطاق تداول عرضي متوازن محدد بين الدعم والمقاومة؛ التداول محصور عند أطراف الرينج وتجنب المنتصف.';
  } else {
    marketRegime = 'UNCLEAR';
    recommendedAction = 'NO_EDGE_WAIT';
    summaryDescription = 'حركة سعرية غير منتظمة بدون ميزة إحصائية واضحة (No Edge)؛ يفضل الانتظار لحماية رأس المال.';
  }

  const regimeContext: TechnicalIndicators['regimeContext'] = {
    regime: marketRegime,
    trendStrength,
    isOverextended,
    overextensionReason,
    volatilityRatio,
    rangeBoundaries: {
      high: Number(swingHigh.toFixed(2)),
      low: Number(swingLow.toFixed(2)),
      equilibrium: Number(equilibrium.toFixed(2)),
    },
    recommendedAction,
    summaryDescription,
  };

  return {
    isDataSufficient: effectiveCandles.length >= 10,
    ema20,
    ema50,
    ema200,
    vwap,
    rsi14,
    macd,
    atr14,
    bollingerBands,
    swingHigh: Number(swingHigh.toFixed(2)),
    swingLow: Number(swingLow.toFixed(2)),
    rollingHigh: Number(rollingHigh.toFixed(2)),
    rollingLow: Number(rollingLow.toFixed(2)),
    structuralSwingHigh: Number(structuralSwingHigh.toFixed(2)),
    structuralSwingLow: Number(structuralSwingLow.toFixed(2)),
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2)),
    structure,
    structureShift,
    structureEvent,
    trendStructure,
    chochDetected,
    bosDetected,
    mssDetected,
    mssDirection,
    mssType,
    liquidityLevels,
    orderBlock,
    orderBlocks,
    fvg,
    fvgZones,
    fractalSwings: {
      highs: fractalHighs,
      lows: fractalLows,
    },
    liquiditySweepDetected,
    liquiditySweepDetails,
    compressionState,
    premiumDiscountZone,
    marketRegime,
    regimeContext,
  };
}

// ============================================================================
// PATTERN RECOGNITION HELPERS FOR EXPANDED PRICE ACTION DETECTOR (S10 - S13)
// ============================================================================

export interface DoubleTopBottomPattern {
  found: boolean;
  type?: 'DOUBLE_TOP' | 'DOUBLE_BOTTOM';
  confirmationState: 'CONFIRMED_REVERSAL' | 'PRE_CONFIRMATION';
  isConfirmed: boolean;
  hasNecklineBreak: boolean;
  isInvalidated: boolean;
  pivot1: number;
  pivot2: number;
  pivot1Index: number;
  pivot2Index: number;
  pivot1Time: number;
  pivot2Time: number;
  neckline: number;
  extremeLevel: number;
  patternAnchorKey: string;
}

/**
 * Detects Double Top (M-formation) or Double Bottom (W-formation) from closed candle series.
 * Distinguishes PRE_CONFIRMATION (second peak/trough rejection) from CONFIRMED_REVERSAL (neckline break).
 */
export function detectDoubleTopBottom(candles: Candle[], atr14: number): DoubleTopBottomPattern[] {
  const results: DoubleTopBottomPattern[] = [];
  // Strictly filter to closed candles only to prevent forming spikes from false triggers
  const closedCandles = candles.filter((c) => c.isClosed !== false);
  if (closedCandles.length < 15) return results;

  const window = Math.min(50, closedCandles.length);
  const slice = closedCandles.slice(-window);

  // Identify swing highs and swing lows (3-candle pivot)
  const swingHighs: { index: number; high: number; timestamp: number }[] = [];
  const swingLows: { index: number; low: number; timestamp: number }[] = [];

  for (let i = 2; i < slice.length - 1; i++) {
    if (slice[i].high >= slice[i - 1].high && slice[i].high >= slice[i - 2].high && slice[i].high >= slice[i + 1].high) {
      swingHighs.push({ index: i, high: slice[i].high, timestamp: slice[i].timestamp });
    }
    if (slice[i].low <= slice[i - 1].low && slice[i].low <= slice[i - 2].low && slice[i].low <= slice[i + 1].low) {
      swingLows.push({ index: i, low: slice[i].low, timestamp: slice[i].timestamp });
    }
  }

  // Check Double Tops (M-Formation)
  for (let a = 0; a < swingHighs.length - 1; a++) {
    for (let b = a + 1; b < swingHighs.length; b++) {
      const p1 = swingHighs[a];
      const p2 = swingHighs[b];
      const sep = p2.index - p1.index;

      if (sep >= 3 && sep <= 30) {
        const diff = Math.abs(p1.high - p2.high);
        if (diff <= Math.max(0.8 * atr14, 1.20)) {
          // Find neckline (trough between the two peaks)
          const midSlice = slice.slice(p1.index, p2.index + 1);
          const neckline = Math.min(...midSlice.map((c) => c.low));
          const depth = Math.max(p1.high, p2.high) - neckline;

          if (depth >= Math.max(0.6 * atr14, 1.00)) {
            const candlesSinceP2 = slice.length - 1 - p2.index;
            if (candlesSinceP2 <= 12) {
              const candlesAfterP2 = slice.slice(p2.index + 1);
              const extremeLevel = Math.max(p1.high, p2.high);

              // Invalidation: closed candle above extreme level + buffer
              const isInvalidated = candlesAfterP2.some((c) => c.close > extremeLevel + 0.3 * atr14);
              if (isInvalidated) continue;

              // Confirmed neckline break by a closed candle
              const hasNecklineBreak = candlesAfterP2.some((c) => c.close < neckline);

              // Rejection at/after peak 2
              const recentCandle = slice[slice.length - 1];
              const upperWick = recentCandle.high - Math.max(recentCandle.open, recentCandle.close);
              const totalRange = Math.max(0.01, recentCandle.high - recentCandle.low);
              const isRejection = (upperWick >= totalRange * 0.25 || recentCandle.close < recentCandle.open) &&
                recentCandle.close <= extremeLevel + 0.5;

              if (hasNecklineBreak || isRejection) {
                const confirmationState: 'CONFIRMED_REVERSAL' | 'PRE_CONFIRMATION' = hasNecklineBreak
                  ? 'CONFIRMED_REVERSAL'
                  : 'PRE_CONFIRMATION';

                const anchorKey = `DOUBLE_TOP_${p1.timestamp}_${p2.timestamp}`;
                results.push({
                  found: true,
                  type: 'DOUBLE_TOP',
                  confirmationState,
                  isConfirmed: hasNecklineBreak,
                  hasNecklineBreak,
                  isInvalidated: false,
                  pivot1: p1.high,
                  pivot2: p2.high,
                  pivot1Index: p1.index,
                  pivot2Index: p2.index,
                  pivot1Time: p1.timestamp,
                  pivot2Time: p2.timestamp,
                  neckline,
                  extremeLevel,
                  patternAnchorKey: anchorKey,
                });
              }
            }
          }
        }
      }
    }
  }

  // Check Double Bottoms (W-Formation)
  for (let a = 0; a < swingLows.length - 1; a++) {
    for (let b = a + 1; b < swingLows.length; b++) {
      const p1 = swingLows[a];
      const p2 = swingLows[b];
      const sep = p2.index - p1.index;

      if (sep >= 3 && sep <= 30) {
        const diff = Math.abs(p1.low - p2.low);
        if (diff <= Math.max(0.8 * atr14, 1.20)) {
          // Find neckline (peak between the two troughs)
          const midSlice = slice.slice(p1.index, p2.index + 1);
          const neckline = Math.max(...midSlice.map((c) => c.high));
          const depth = neckline - Math.min(p1.low, p2.low);

          if (depth >= Math.max(0.6 * atr14, 1.00)) {
            const candlesSinceP2 = slice.length - 1 - p2.index;
            if (candlesSinceP2 <= 12) {
              const candlesAfterP2 = slice.slice(p2.index + 1);
              const extremeLevel = Math.min(p1.low, p2.low);

              // Invalidation: closed candle below extreme level - buffer
              const isInvalidated = candlesAfterP2.some((c) => c.close < extremeLevel - 0.3 * atr14);
              if (isInvalidated) continue;

              // Confirmed neckline break by a closed candle
              const hasNecklineBreak = candlesAfterP2.some((c) => c.close > neckline);

              // Rejection at/after trough 2
              const recentCandle = slice[slice.length - 1];
              const lowerWick = Math.min(recentCandle.open, recentCandle.close) - recentCandle.low;
              const totalRange = Math.max(0.01, recentCandle.high - recentCandle.low);
              const isRejection = (lowerWick >= totalRange * 0.25 || recentCandle.close > recentCandle.open) &&
                recentCandle.close >= extremeLevel - 0.5;

              if (hasNecklineBreak || isRejection) {
                const confirmationState: 'CONFIRMED_REVERSAL' | 'PRE_CONFIRMATION' = hasNecklineBreak
                  ? 'CONFIRMED_REVERSAL'
                  : 'PRE_CONFIRMATION';

                const anchorKey = `DOUBLE_BOTTOM_${p1.timestamp}_${p2.timestamp}`;
                results.push({
                  found: true,
                  type: 'DOUBLE_BOTTOM',
                  confirmationState,
                  isConfirmed: hasNecklineBreak,
                  hasNecklineBreak,
                  isInvalidated: false,
                  pivot1: p1.low,
                  pivot2: p2.low,
                  pivot1Index: p1.index,
                  pivot2Index: p2.index,
                  pivot1Time: p1.timestamp,
                  pivot2Time: p2.timestamp,
                  neckline,
                  extremeLevel,
                  patternAnchorKey: anchorKey,
                });
              }
            }
          }
        }
      }
    }
  }

  return results;
}

export interface BareSRLevelPattern {
  level: number;
  type: 'RESISTANCE' | 'SUPPORT';
  touches: number;
  strength: 'STRONG' | 'MODERATE';
}

/**
 * Detects clustered bare horizontal support/resistance levels with multi-touch historical reactions
 */
export function detectBareSRLevels(
  candles15m: Candle[],
  candles5m: Candle[],
  atr14: number
): BareSRLevelPattern[] {
  const points: { price: number; isHigh: boolean }[] = [];

  // Collect swing points from 15M and 5M
  const window15m = candles15m.slice(-40);
  for (let i = 2; i < window15m.length - 1; i++) {
    if (window15m[i].high >= window15m[i - 1].high && window15m[i].high >= window15m[i + 1].high) {
      points.push({ price: window15m[i].high, isHigh: true });
    }
    if (window15m[i].low <= window15m[i - 1].low && window15m[i].low <= window15m[i + 1].low) {
      points.push({ price: window15m[i].low, isHigh: false });
    }
  }

  const window5m = candles5m.slice(-30);
  for (let i = 2; i < window5m.length - 1; i++) {
    if (window5m[i].high >= window5m[i - 1].high && window5m[i].high >= window5m[i + 1].high) {
      points.push({ price: window5m[i].high, isHigh: true });
    }
    if (window5m[i].low <= window5m[i - 1].low && window5m[i].low <= window5m[i + 1].low) {
      points.push({ price: window5m[i].low, isHigh: false });
    }
  }

  if (points.length === 0) return [];

  // Cluster price points within ATR threshold
  const threshold = Math.max(0.6 * atr14, 0.80);
  const clusters: { prices: number[]; isHighCount: number; isLowCount: number }[] = [];

  for (const p of points) {
    let matchedCluster = clusters.find(
      (c) => Math.abs(c.prices.reduce((a, b) => a + b, 0) / c.prices.length - p.price) <= threshold
    );
    if (matchedCluster) {
      matchedCluster.prices.push(p.price);
      if (p.isHigh) matchedCluster.isHighCount++;
      else matchedCluster.isLowCount++;
    } else {
      clusters.push({
        prices: [p.price],
        isHighCount: p.isHigh ? 1 : 0,
        isLowCount: p.isHigh ? 0 : 1,
      });
    }
  }

  // Filter clusters with >= 2 touches
  const results: BareSRLevelPattern[] = [];
  for (const c of clusters) {
    if (c.prices.length >= 2) {
      const avgLevel = Number((c.prices.reduce((a, b) => a + b, 0) / c.prices.length).toFixed(2));
      const isRes = c.isHighCount >= c.isLowCount;
      results.push({
        level: avgLevel,
        type: isRes ? 'RESISTANCE' : 'SUPPORT',
        touches: c.prices.length,
        strength: c.prices.length >= 3 ? 'STRONG' : 'MODERATE',
      });
    }
  }

  return results;
}

export interface BreakoutRetestPattern {
  found: boolean;
  type: 'RESISTANCE_TO_SUPPORT' | 'SUPPORT_TO_RESISTANCE';
  brokenLevel: number;
  breakoutCandleClose: number;
  retestPrice: number;
}

/**
 * Detects first clean retest of a broken horizontal level
 */
export function detectHorizontalBreakoutRetest(
  candles15m: Candle[],
  candles5m: Candle[],
  atr14: number
): BreakoutRetestPattern[] {
  const results: BreakoutRetestPattern[] = [];
  if (candles5m.length < 10) return results;

  const srLevels = detectBareSRLevels(candles15m, candles5m, atr14);
  const slice5m = candles5m.slice(-20);
  const lastCandle = slice5m[slice5m.length - 1];

  for (const sr of srLevels) {
    const level = sr.level;

    // Check Resistance -> Support Retest (BUY)
    if (sr.type === 'RESISTANCE') {
      const retestTolerance = Math.max(1.2, atr14 * 0.4);
      // Find breakout candle between 1 and 15 candles ago (supporting rapid 5M breakout -> retest)
      let breakoutIdx = -1;
      for (let i = slice5m.length - 15; i < slice5m.length - 1; i++) {
        if (i >= 0 && slice5m[i].close >= level + 0.25 * atr14) {
          breakoutIdx = i;
          break;
        }
      }

      if (breakoutIdx !== -1) {
        // Verify no candle after breakout closed back below the level (failed breakout)
        const intermediateCandles = slice5m.slice(breakoutIdx + 1, slice5m.length - 1);
        const hasFailedBackBelow = intermediateCandles.some((c) => c.close < level - 0.2 * atr14);

        if (!hasFailedBackBelow) {
          // Check current/recent candle returns to touch/retest the level
          const prev5mCandle = slice5m[slice5m.length - 2];
          const touchRecent = lastCandle.low <= level + retestTolerance && lastCandle.low >= level - 0.4 * atr14;
          const touchPrev = prev5mCandle ? (prev5mCandle.low <= level + retestTolerance && prev5mCandle.low >= level - 0.4 * atr14) : false;
          // Must hold above the broken level (rejection up / acceptance above)
          const holdsAbove = lastCandle.close >= level - 0.1 * atr14;
          const hasBullishReaction = (lastCandle.close > lastCandle.open) ||
            (lastCandle.close - lastCandle.low >= (lastCandle.high - lastCandle.low) * 0.25);

          if ((touchRecent || touchPrev) && holdsAbove && hasBullishReaction) {
            results.push({
              found: true,
              type: 'RESISTANCE_TO_SUPPORT',
              brokenLevel: level,
              breakoutCandleClose: slice5m[breakoutIdx].close,
              retestPrice: touchRecent ? lastCandle.low : (prev5mCandle?.low ?? lastCandle.low),
            });
          }
        }
      }
    }

    // Check Support -> Resistance Retest (SELL)
    if (sr.type === 'SUPPORT') {
      const retestTolerance = Math.max(1.2, atr14 * 0.4);
      let breakoutIdx = -1;
      for (let i = slice5m.length - 15; i < slice5m.length - 1; i++) {
        if (i >= 0 && slice5m[i].close <= level - 0.25 * atr14) {
          breakoutIdx = i;
          break;
        }
      }

      if (breakoutIdx !== -1) {
        // Verify no candle after breakout closed back above the level (failed breakout)
        const intermediateCandles = slice5m.slice(breakoutIdx + 1, slice5m.length - 1);
        const hasFailedBackAbove = intermediateCandles.some((c) => c.close > level + 0.2 * atr14);

        if (!hasFailedBackAbove) {
          const prev5mCandle = slice5m[slice5m.length - 2];
          const touchRecent = lastCandle.high >= level - retestTolerance && lastCandle.high <= level + 0.4 * atr14;
          const touchPrev = prev5mCandle ? (prev5mCandle.high >= level - retestTolerance && prev5mCandle.high <= level + 0.4 * atr14) : false;
          // Must hold below the broken level (rejection down / acceptance below)
          const holdsBelow = lastCandle.close <= level + 0.1 * atr14;
          const hasBearishReaction = (lastCandle.close < lastCandle.open) ||
            (lastCandle.high - lastCandle.close >= (lastCandle.high - lastCandle.low) * 0.25);

          if ((touchRecent || touchPrev) && holdsBelow && hasBearishReaction) {
            results.push({
              found: true,
              type: 'SUPPORT_TO_RESISTANCE',
              brokenLevel: level,
              breakoutCandleClose: slice5m[breakoutIdx].close,
              retestPrice: touchRecent ? lastCandle.high : (prev5mCandle?.high ?? lastCandle.high),
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Checks if there is explicit confirmed structural reversal in the specified direction.
 * Requires closed candle confirmation on M15/M5 (e.g. BOS/CHOCH or neckline break).
 */
export function hasConfirmedReversalStructure(
  direction: 'BUY' | 'SELL',
  indicators15m: TechnicalIndicators,
  indicators5m: TechnicalIndicators,
  closedCandles15m: Candle[],
  closedCandles5m: Candle[],
  atr14: number
): boolean {
  if (direction === 'BUY') {
    // Bullish reversal confirmation
    // 1. Confirmed M15 / M5 structural shift / BOS / MSS in bullish direction
    const ev15m = indicators15m?.structureEvent;
    const ev5m = indicators5m?.structureEvent;
    const isBullEvent =
      ev15m === 'BULLISH_MSS_SWEEP' || ev15m === 'BULLISH_CHOCH' || ev15m === 'BULLISH_BOS' ||
      ev5m === 'BULLISH_MSS_SWEEP' || ev5m === 'BULLISH_CHOCH' || ev5m === 'BULLISH_BOS' ||
      (indicators15m?.mssDetected && indicators15m?.mssDirection === 'BULLISH') ||
      (indicators5m?.mssDetected && indicators5m?.mssDirection === 'BULLISH');
    if (isBullEvent) {
      return true;
    }

    // 2. Confirmed Double Bottom neckline break
    const candleSet = closedCandles15m && closedCandles15m.length >= 15 ? closedCandles15m : (closedCandles5m || []);
    if (candleSet.length >= 15) {
      const doubleBottoms = detectDoubleTopBottom(candleSet, atr14 || 1.0);
      if (doubleBottoms.some((p) => p.type === 'DOUBLE_BOTTOM' && p.confirmationState === 'CONFIRMED_REVERSAL')) {
        return true;
      }
    }

    // 3. 15M closed candle higher high over previous swing high with bullish structure
    if (closedCandles15m && closedCandles15m.length >= 5) {
      const last15 = closedCandles15m[closedCandles15m.length - 1];
      const prevSwings = closedCandles15m.slice(-6, -1);
      const prevMaxHigh = Math.max(...prevSwings.map((c) => c.high));
      if (last15.close > prevMaxHigh + 0.2 * (atr14 || 1.0) && indicators15m?.structure === 'BULLISH') {
        return true;
      }
    }

    return false;
  } else {
    // Bearish reversal confirmation
    // 1. Confirmed M15 / M5 structural shift / BOS / MSS in bearish direction
    const ev15m = indicators15m?.structureEvent;
    const ev5m = indicators5m?.structureEvent;
    const isBearEvent =
      ev15m === 'BEARISH_MSS_SWEEP' || ev15m === 'BEARISH_CHOCH' || ev15m === 'BEARISH_BOS' ||
      ev5m === 'BEARISH_MSS_SWEEP' || ev5m === 'BEARISH_CHOCH' || ev5m === 'BEARISH_BOS' ||
      (indicators15m?.mssDetected && indicators15m?.mssDirection === 'BEARISH') ||
      (indicators5m?.mssDetected && indicators5m?.mssDirection === 'BEARISH');
    if (isBearEvent) {
      return true;
    }

    // 2. Confirmed Double Top neckline break
    const candleSet = closedCandles15m && closedCandles15m.length >= 15 ? closedCandles15m : (closedCandles5m || []);
    if (candleSet.length >= 15) {
      const doubleTops = detectDoubleTopBottom(candleSet, atr14 || 1.0);
      if (doubleTops.some((p) => p.type === 'DOUBLE_TOP' && p.confirmationState === 'CONFIRMED_REVERSAL')) {
        return true;
      }
    }

    // 3. 15M closed candle lower low below previous swing low with bearish structure
    if (closedCandles15m && closedCandles15m.length >= 5) {
      const last15 = closedCandles15m[closedCandles15m.length - 1];
      const prevSwings = closedCandles15m.slice(-6, -1);
      const prevMinLow = Math.min(...prevSwings.map((c) => c.low));
      if (last15.close < prevMinLow - 0.2 * (atr14 || 1.0) && indicators15m?.structure === 'BEARISH') {
        return true;
      }
    }

    return false;
  }
}

