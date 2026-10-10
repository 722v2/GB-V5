import { Candle, SignalDecision, TradeSignal, HistoricalDataValidationReport } from '../src/types.js';
import { analyzeTechnicals } from './indicators.js';
import { calculateDynamicTakeProfits, DynamicTpResult } from './tpEngine.js';
import { evaluateTradeRisk } from './riskManager.js';
import { discoverGbv5Candidates } from './gbv5Brain.js';
import {
  fetchHistoricalCandlesWithPagination,
  validateHistoricalBacktestDataset,
  fetchHistoricalBacktestDataset,
} from './marketData.js';

export interface BacktestRequest {
  initialCapital: number;
  timeRange: '1D' | '3D' | '7D' | '14D' | '30D' | '60D' | '90D' | '180D' | '365D';
  customBarsCount?: number;
  riskPercent?: number;
  allowAvailableSlice?: boolean;
  brokerSpecs?: any;
}

export interface BacktestTrade {
  id: string;
  entryTime: string;
  exitTime: string;
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'BUY' | 'SELL';
  signalType: SignalDecision;
  setup: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  slPoints: number;
  tp1Points: number;
  riskPercent: number;
  riskAmount: number;
  lotSize: number;
  result: 'WIN' | 'LOSS' | 'AMBIGUOUS';
  pl: number;
  balanceBefore: number;
  balanceAfter: number;
  rrRatio: number;
  realRR: number;
  plannedRR_TP1?: number;
  plannedRR_TP2?: number;
  realizedR: number;
  exitReason: 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_EXPIRATION' | 'AMBIGUOUS_SAME_CANDLE';
  confidence: number;
  durationMinutes: number;
  tpSelectionReason?: string;
  structuralTargetUsed?: string;
  targetDistance?: number;
  slDistance?: number;
  atrAtEntry?: number;
  passedVolatilitySanity?: boolean;
  noFutureDataUsed?: boolean;
  rawStructuralTarget?: number;
  targetSourceType?: string;
  isModified?: boolean;
  modificationReason?: string;
  technicalSL?: number;
  finalSL?: number;
  slBuffer?: number;
  initialLot?: number;
  addonLot?: number;
  initialEntry?: number;
  addonEntry?: number;
  finalAverageEntry?: number;
  combinedRisk?: number;
  addonUsed?: boolean;
}

export interface BacktestSummary {
  runId: string;
  runTimestamp: number;
  initialCapital: number;
  finalBalance: number;
  netProfit: number;
  netProfitPercent: number;
  totalTrades: number;
  wins: number;
  losses: number;
  ambiguousTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  medianRR: number;
  averageRR: number;
  maxRR: number;
  pctTradesRrAbove5: number;
  pctTradesRrAbove10: number;
  noTradeCountSub2RR: number;
  rejectedByDailyRiskLimit?: number;
  rejectedByMinimumLotRisk?: number;
  tradesUsingAddon?: number;
  addonRejectedRiskCount?: number;
  maxDailyAggregateRisk?: number;
  maxActualPerTradeRisk?: number;
  maxBufferUsed?: number;
  avgBufferUsed?: number;
  dailyRiskTaken?: Record<string, number>;
  largestWin: number;
  largestLoss: number;
  averageWin: number;
  averageLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  dailyTradesDistribution: Record<string, number>;
  timeRange: string;
  candlesEvaluated: number;
  candlesCount1m?: number;
  candlesCount1h: number;
  candlesCount15m: number;
  candlesCount5m: number;
  startTimestamp: number;
  endTimestamp: number;
  startDate: string;
  endDate: string;
  trades: BacktestTrade[];
  equityCurve: { time: string; timestamp: number; balance: number }[];
  validationReport?: HistoricalDataValidationReport;
}

function parseBiquoteBars(bars: any[]): Candle[] {
  return (bars || [])
    .map((b: any) => {
      const rawVolume = Number(b.volume) || 0;
      const tickVolume = Number(b.tickVolume) || 0;
      const effectiveVolume = rawVolume > 0 ? rawVolume : tickVolume;
      return {
        timestamp: new Date(b.openTime).getTime(),
        open: Number(parseFloat(b.open).toFixed(2)),
        high: Number(parseFloat(b.high).toFixed(2)),
        low: Number(parseFloat(b.low).toFixed(2)),
        close: Number(parseFloat(b.close).toFixed(2)),
        volume: effectiveVolume,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Executes a deterministic backtest strictly on real XAUUSD historical candles
 * Reuses identical 1H Bias + 15M Setup + 5M Confirmation + Realistic Structure TP/SL + Risk Guard.
 */
export async function runXauusdBacktest(request: BacktestRequest): Promise<BacktestSummary> {
  const initialCapital = Math.max(1, request.initialCapital || 10);
  const timeRange = request.timeRange || '7D';
  const baseRiskPercent = typeof request.riskPercent === 'number' && request.riskPercent > 0 ? request.riskPercent : 15.0;
  const runTimestamp = Date.now();
  const runId = `btrun_${runTimestamp}_${Math.random().toString(36).substring(2, 7)}`;

  console.log(`[BacktestEngine] Starting run ${runId} - Capital: $${initialCapital}, Risk: ${baseRiskPercent}%, Range: ${timeRange}`);

  // 1. Calculate requested time range
  const daysMap: Record<string, number> = {
    '1D': 1,
    '3D': 3,
    '7D': 7,
    '14D': 14,
    '30D': 30,
    '60D': 60,
    '90D': 90,
    '180D': 180,
    '365D': 365,
  };
  const days = daysMap[timeRange] || 7;
  const requestedEndTime = Date.now();
  const requestedStartTime = requestedEndTime - days * 24 * 60 * 60 * 1000;

  // 2. Fetch real historical candles via primary provider (MT5 Bridge) or fallback (Biquote)
  const datasetResult = await fetchHistoricalBacktestDataset({
    symbol: 'XAUUSD',
    timeRange,
    requestedStartTime,
    requestedEndTime,
  });

  const all1h = datasetResult.candles1h;
  const all15m = datasetResult.candles15m;
  const all5m = datasetResult.candles5m;
  const all1m = datasetResult.candles1m || [];
  const validation = datasetResult.validation;

  if (all5m.length < 30) {
    throw new Error(`بيانات الشموع التاريخية الحقيقية غير كافية لإجراء الـBacktest من مزود (${datasetResult.provider}).`);
  }

  // Strict Data Integrity Check (Rule 14 & 15):
  // If data is insufficient for requested period, refuse to fake a full backtest
  if (!validation.isFullCoverage && !request.allowAvailableSlice) {
    const err: any = new Error(
      `[DataValidationError: INSUFFICIENT_HISTORICAL_DATA] لا يمكن إجراء الـBacktest لفترة (${timeRange}): ` +
      `مزود البيانات (${validation.provider}) يوفر فقط ${all5m.length} شمعة 5M تغطي ${Number(((validation.actualLatestCandleTime - validation.actualEarliestCandleTime) / (3600 * 24 * 1000)).toFixed(2))} يوم فقط ` +
      `(من ${validation.actualEarliestDate} إلى ${validation.actualLatestDate})، بينما الفترة المطلوبة تبدأ من ${validation.requestedStartDate}. ` +
      `تنص معايير النزاهة الصارمة على عدم تعويض البيانات بنماذج صناعية وعدم تشغيل اختبار ناقص كأنه كامل.`
    );
    err.validationReport = validation;
    throw err;
  }

  const endTimestamp = all5m[all5m.length - 1]?.timestamp || requestedEndTime;
  const targetStartTime = validation.isFullCoverage ? requestedStartTime : (all5m[0]?.timestamp || requestedStartTime);

  // Provide warm-up period for indicator stabilization (EMA50, EMA200, MACD, RSI, ATR)
  const warmupDays = Math.max(1, Math.min(7, Math.ceil(days * 0.05)));
  const availableOldestTimestamp = all5m[0]?.timestamp || targetStartTime;
  const warmupStartTime = Math.max(availableOldestTimestamp, targetStartTime - warmupDays * 24 * 60 * 60 * 1000);

  const candles1m = all1m.filter((c) => c.timestamp >= warmupStartTime && c.timestamp <= endTimestamp);
  const candles5m = all5m.filter((c) => c.timestamp >= warmupStartTime && c.timestamp <= endTimestamp);
  const candles15m = all15m.filter((c) => c.timestamp >= warmupStartTime && c.timestamp <= endTimestamp);
  const candles1h = all1h.filter((c) => c.timestamp >= warmupStartTime - 48 * 3600 * 1000 && c.timestamp <= endTimestamp);

  const activeCandles5m = candles5m.filter((c) => c.timestamp >= targetStartTime);
  const activeCandles15m = candles15m.filter((c) => c.timestamp >= targetStartTime);
  const activeCandles1h = candles1h.filter((c) => c.timestamp >= targetStartTime);

  console.log(`[BacktestEngine] Range ${timeRange}: Total 1M: ${candles1m.length}, Total 5M with warmup: ${candles5m.length}, Active 5M: ${activeCandles5m.length}, Active 15M: ${activeCandles15m.length}, Active 1H: ${activeCandles1h.length}`);

  let runningBalance = initialCapital;
  let peakBalance = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let losingStreak = 0;
  let maxConsecutiveLosses = 0;
  let winningStreak = 0;
  let maxConsecutiveWins = 0;
  let noTradeCountSub2RR = 0;
  let rejectedByDailyRiskLimit = 0;
  let rejectedByMinimumLotRisk = 0;
  let tradesUsingAddonCount = 0;
  let addonRejectedRiskCount = 0;
  let maxBufferUsed = 0;
  let sumBufferUsed = 0;

  const trades: BacktestTrade[] = [];
  const dailyTradeCounts: Record<string, number> = {};
  const dailyRiskTaken: Record<string, number> = {};
  const equityCurve: { time: string; timestamp: number; balance: number }[] = [
    {
      time: new Date(targetStartTime).toISOString().replace('T', ' ').slice(0, 16),
      timestamp: targetStartTime,
      balance: initialCapital,
    },
  ];

  // We iterate through 5M candles simulating real-time step-by-step scanner
  const warmUp = 35;

  for (let i = warmUp; i < candles5m.length - 1; i++) {
    const current5m = candles5m[i];

    // CRITICAL: Only take trades that occur within the target requested period [targetStartTime, endTimestamp]
    if (current5m.timestamp < targetStartTime) {
      continue;
    }

    const currentDateKey = new Date(current5m.timestamp).toISOString().slice(0, 10);
    const dayTrades = dailyTradeCounts[currentDateKey] || 0;
    const dayRisk = dailyRiskTaken[currentDateKey] || 0;

    // Rule: Max 3 trades per day
    if (dayTrades >= 3) {
      continue;
    }

    // Rule: Daily Risk Max 30%
    if (dayRisk >= 30.0) {
      continue;
    }

    // Prepare slices of historical data up to index `i` (STRICT NO LOOKAHEAD)
    const history5m = candles5m.slice(0, i + 1);
    // Evaluation moment is when current5m completes (close time = open timestamp + 5m)
    const evalTimestamp = current5m.timestamp + 5 * 60 * 1000;

    // Filter 15m and 1h candles strictly by full completion (candle CLOSE timestamp <= evalTimestamp)
    const history15m = candles15m.filter((c) => c.timestamp + 15 * 60 * 1000 <= evalTimestamp);
    const history1h = candles1h.filter((c) => c.timestamp + 60 * 60 * 1000 <= evalTimestamp);

    if (history15m.length < 25 || history1h.length < 20) {
      continue;
    }

    // Calculate technical indicators
    const ind5m = analyzeTechnicals(history5m);
    const ind15m = analyzeTechnicals(history15m);
    const ind1h = analyzeTechnicals(history1h);

    const currentPrice = current5m.close;
    const prev5m = history5m[history5m.length - 2] || current5m;
    const atr5m = ind5m.atr14 || 1.5;
    const atr15m = ind15m.atr14 || 2.5;

    // 1H Bias
    const is1hBullish = ind1h.structure === 'BULLISH' || currentPrice > ind1h.ema50;
    const is1hBearish = ind1h.structure === 'BEARISH' || currentPrice < ind1h.ema50;

    // Rejection candle logic
    const bullishRejection =
      (current5m.close > current5m.open && current5m.open - current5m.low > (current5m.high - current5m.close) * 1.5) ||
      current5m.close > prev5m.high;
    const bearishRejection =
      (current5m.close < current5m.open && current5m.high - current5m.open > (current5m.close - current5m.low) * 1.5) ||
      current5m.close < prev5m.low;

    let candidateSignal: {
      decision: SignalDecision;
      entry: number;
      stopLoss: number;
      technicalSL?: number;
      slBuffer?: number;
      tp1: number;
      tp2: number;
      confidence: number;
      setup: string;
      realRR: number;
      tp2Rr: number;
      tpSelectionReason: string;
      structuralTargetUsed: string;
      atrAtEntry: number;
      passedVolatilitySanity: boolean;
      rawStructuralTarget: number;
      targetSourceType: string;
      isModified: boolean;
      modificationReason: string;
    } | null = null;

    const minSlConfigured = request.brokerSpecs?.minGoldSlPoints ?? 35;
    const maxSlConfigured = request.brokerSpecs?.maxGoldSlPoints ?? 85;

    // 0. Primary GB-V5 Brain Canonical Candidate Discovery (M1 Primary with M5/M15/H1 context)
    const history1m = candles1m.filter((c) => c.timestamp + 60 * 1000 <= evalTimestamp);
    if (history1m.length >= 30) {
      try {
        const brainRes = discoverGbv5Candidates({
          asset: 'XAU/USD',
          currentPrice,
          balance: runningBalance,
          candles1m: history1m,
          candles5m: history5m,
          candles15m: history15m,
          candles1h: history1h,
          indicators5m: ind5m,
          indicators15m: ind15m,
          indicators1h: ind1h,
          brokerSpecs: {
            accountBalance: runningBalance,
            riskPercent: baseRiskPercent,
            contractSizeOz: 100,
            minimumLot: 0.01,
            maximumLot: 100,
            lotStep: 0.01,
            minGoldSlPoints: minSlConfigured,
            maxGoldSlPoints: maxSlConfigured,
            minRr: request.brokerSpecs?.minRr ?? 1.5,
            maxLoss: request.brokerSpecs?.maxLoss ?? 5.5,
          },
          minConfidence: 75,
        });

        if (brainRes.candidates.length > 0) {
          const topCand = brainRes.candidates[0];
          candidateSignal = {
            decision: topCand.direction === 'BUY'
              ? (topCand.orderType === 'LIMIT' ? 'BUY LIMIT' : 'BUY NOW')
              : (topCand.orderType === 'LIMIT' ? 'SELL LIMIT' : 'SELL NOW'),
            entry: topCand.entry,
            stopLoss: topCand.stopLoss,
            tp1: topCand.tp1,
            tp2: topCand.tp2,
            confidence: topCand.confidence,
            setup: `GB-V5 [${topCand.family}] ${topCand.setupName}`,
            realRR: topCand.tp1Rr,
            tp2Rr: topCand.tp2Rr,
            tpSelectionReason: topCand.mainReasons.join('; '),
            structuralTargetUsed: topCand.supportingConfluences.join('; ') || 'Structural Target',
            atrAtEntry: atr5m,
            passedVolatilitySanity: true,
            rawStructuralTarget: topCand.tp1,
            targetSourceType: 'CANONICAL_FAMILY',
            isModified: false,
            modificationReason: '',
          };
        }
      } catch (bErr) {
        // Fallback to structural setups
      }
    }

    // 1. Bullish Setup (BUY NOW)
    if (!candidateSignal && is1hBullish && (ind15m.premiumDiscountZone === 'DISCOUNT' || currentPrice <= ind5m.ema50 + atr5m) && bullishRejection) {
      const entry = currentPrice;
      // Technical SL based on real invalidation: strictly 40 to 50 pip range
      const rawSlDist = entry - (Math.min(ind5m.swingLow, current5m.low) - atr5m * 0.3);
      const slDistance = Number(rawSlDist.toFixed(2));
      const slPoints = Number((slDistance / 0.1).toFixed(1));

      if (slPoints >= 40 && slPoints <= 50) {
        const stopLoss = Number((entry - slDistance).toFixed(2));

        const dynamicTp = calculateDynamicTakeProfits({
          direction: 'BUY',
          entry,
          stopLoss,
          asset: 'XAU/USD',
          indicators1h: ind1h,
          indicators15m: ind15m,
          indicators5m: ind5m,
          candles1h: history1h,
          candles15m: history15m,
          candles5m: history5m,
        });

        if (dynamicTp.valid) {
          candidateSignal = {
            decision: 'BUY NOW',
            entry,
            stopLoss,
            tp1: dynamicTp.tp1,
            tp2: dynamicTp.tp2,
            confidence: 83,
            setup: 'Discount Retest + Realistic Structure Target',
            realRR: dynamicTp.tp1Rr,
            tp2Rr: dynamicTp.tp2Rr,
            tpSelectionReason: dynamicTp.tpSelectionReason,
            structuralTargetUsed: dynamicTp.structuralTargetUsed,
            atrAtEntry: dynamicTp.atrAtEntry,
            passedVolatilitySanity: dynamicTp.passedVolatilityCheck,
            rawStructuralTarget: dynamicTp.rawStructuralTarget,
            targetSourceType: dynamicTp.targetSourceType,
            isModified: dynamicTp.isModified,
            modificationReason: dynamicTp.modificationReason,
          };
        } else {
          noTradeCountSub2RR += 1;
        }
      }
    }

    // 2. Bearish Setup (SELL NOW)
    if (!candidateSignal && is1hBearish && (ind15m.premiumDiscountZone === 'PREMIUM' || currentPrice >= ind5m.ema50 - atr5m) && bearishRejection) {
      const entry = currentPrice;
      const rawSlDist = (Math.max(ind5m.swingHigh, current5m.high) + atr5m * 0.3) - entry;
      const slDistance = Number(rawSlDist.toFixed(2));
      const slPoints = Number((slDistance / 0.1).toFixed(1));

      if (slPoints >= 40 && slPoints <= 50) {
        const stopLoss = Number((entry + slDistance).toFixed(2));

        const dynamicTp = calculateDynamicTakeProfits({
          direction: 'SELL',
          entry,
          stopLoss,
          asset: 'XAU/USD',
          indicators1h: ind1h,
          indicators15m: ind15m,
          indicators5m: ind5m,
          candles1h: history1h,
          candles15m: history15m,
          candles5m: history5m,
        });

        if (dynamicTp.valid) {
          candidateSignal = {
            decision: 'SELL NOW',
            entry,
            stopLoss,
            tp1: dynamicTp.tp1,
            tp2: dynamicTp.tp2,
            confidence: 82,
            setup: 'Premium Exhaustion + Realistic Structure Target',
            realRR: dynamicTp.tp1Rr,
            tp2Rr: dynamicTp.tp2Rr,
            tpSelectionReason: dynamicTp.tpSelectionReason,
            structuralTargetUsed: dynamicTp.structuralTargetUsed,
            atrAtEntry: dynamicTp.atrAtEntry,
            passedVolatilitySanity: dynamicTp.passedVolatilityCheck,
            rawStructuralTarget: dynamicTp.rawStructuralTarget,
            targetSourceType: dynamicTp.targetSourceType,
            isModified: dynamicTp.isModified,
            modificationReason: dynamicTp.modificationReason,
          };
        } else {
          noTradeCountSub2RR += 1;
        }
      }
    }

    // 3. Limit setups
    if (!candidateSignal && is1hBullish && ind15m.orderBlock?.type === 'BULLISH' && ind15m.orderBlock.high < currentPrice) {
      const ob = ind15m.orderBlock;
      const entry = Number(((ob.high + ob.low) / 2).toFixed(2));
      const rawSlDist = entry - (ob.low - atr15m * 0.2);
      const slDistance = Number(rawSlDist.toFixed(2));
      const slPoints = Number((slDistance / 0.1).toFixed(1));

      if (slPoints >= 40 && slPoints <= 50) {
        const stopLoss = Number((entry - slDistance).toFixed(2));

        const dynamicTp = calculateDynamicTakeProfits({
          direction: 'BUY',
          entry,
          stopLoss,
          asset: 'XAU/USD',
          indicators1h: ind1h,
          indicators15m: ind15m,
          indicators5m: ind5m,
          candles1h: history1h,
          candles15m: history15m,
          candles5m: history5m,
        });

        if (dynamicTp.valid) {
          candidateSignal = {
            decision: 'BUY LIMIT',
            entry,
            stopLoss,
            tp1: dynamicTp.tp1,
            tp2: dynamicTp.tp2,
            confidence: 79,
            setup: 'Bullish Order Block Mitigation',
            realRR: dynamicTp.tp1Rr,
            tp2Rr: dynamicTp.tp2Rr,
            tpSelectionReason: dynamicTp.tpSelectionReason,
            structuralTargetUsed: dynamicTp.structuralTargetUsed,
            atrAtEntry: dynamicTp.atrAtEntry,
            passedVolatilitySanity: dynamicTp.passedVolatilityCheck,
            rawStructuralTarget: dynamicTp.rawStructuralTarget,
            targetSourceType: dynamicTp.targetSourceType,
            isModified: dynamicTp.isModified,
            modificationReason: dynamicTp.modificationReason,
          };
        } else {
          noTradeCountSub2RR += 1;
        }
      }
    }

    if (!candidateSignal && is1hBearish && ind15m.orderBlock?.type === 'BEARISH' && ind15m.orderBlock.low > currentPrice) {
      const ob = ind15m.orderBlock;
      const entry = Number(((ob.high + ob.low) / 2).toFixed(2));
      const rawSlDist = (ob.high + atr15m * 0.2) - entry;
      const slDistance = Number(rawSlDist.toFixed(2));
      const slPoints = Number((slDistance / 0.1).toFixed(1));

      if (slPoints >= 40 && slPoints <= 50) {
        const stopLoss = Number((entry + slDistance).toFixed(2));

        const dynamicTp = calculateDynamicTakeProfits({
          direction: 'SELL',
          entry,
          stopLoss,
          asset: 'XAU/USD',
          indicators1h: ind1h,
          indicators15m: ind15m,
          indicators5m: ind5m,
          candles1h: history1h,
          candles15m: history15m,
          candles5m: history5m,
        });

        if (dynamicTp.valid) {
          candidateSignal = {
            decision: 'SELL LIMIT',
            entry,
            stopLoss,
            tp1: dynamicTp.tp1,
            tp2: dynamicTp.tp2,
            confidence: 79,
            setup: 'Bearish Order Block Mitigation',
            realRR: dynamicTp.tp1Rr,
            tp2Rr: dynamicTp.tp2Rr,
            tpSelectionReason: dynamicTp.tpSelectionReason,
            structuralTargetUsed: dynamicTp.structuralTargetUsed,
            atrAtEntry: dynamicTp.atrAtEntry,
            passedVolatilitySanity: dynamicTp.passedVolatilityCheck,
            rawStructuralTarget: dynamicTp.rawStructuralTarget,
            targetSourceType: dynamicTp.targetSourceType,
            isModified: dynamicTp.isModified,
            modificationReason: dynamicTp.modificationReason,
          };
        } else {
          noTradeCountSub2RR += 1;
        }
      }
    }

    // If no valid signal, continue
    if (!candidateSignal) continue;

    // FEATURE 2: TECHNICAL SL AND BUFFER
    const technicalSL = candidateSignal.stopLoss;
    const technicalSlDistance = Math.abs(candidateSignal.entry - technicalSL);
    const technicalSlPoints = Number((technicalSlDistance / 0.1).toFixed(1));

    if (technicalSlPoints < minSlConfigured || technicalSlPoints > maxSlConfigured) {
      continue;
    }

    if (candidateSignal.targetSourceType === 'CANONICAL_FAMILY') {
      candidateSignal.technicalSL = technicalSL;
      candidateSignal.slBuffer = 0;
    } else {
      const isBuySignal = candidateSignal.decision.includes('BUY');
      const bufferRaw = Number((atr5m * 0.15).toFixed(2));
      const slBuffer = Number(Math.min(1.5, Math.max(0.2, bufferRaw)).toFixed(2));
      const finalSL = isBuySignal
        ? Number((technicalSL - slBuffer).toFixed(2))
        : Number((technicalSL + slBuffer).toFixed(2));

      // Recalculate dynamic TP / RR validity using finalSL
      const bufferedDynamicTp = calculateDynamicTakeProfits({
        direction: isBuySignal ? 'BUY' : 'SELL',
        entry: candidateSignal.entry,
        stopLoss: finalSL,
        asset: 'XAU/USD',
        indicators1h: ind1h,
        indicators15m: ind15m,
        indicators5m: ind5m,
        candles1h: history1h,
        candles15m: history15m,
        candles5m: history5m,
      });

      if (!bufferedDynamicTp.valid) {
        noTradeCountSub2RR += 1;
        continue;
      }

      // Apply buffered SL and re-computed TPs to candidateSignal
      candidateSignal.technicalSL = technicalSL;
      candidateSignal.slBuffer = slBuffer;
      candidateSignal.stopLoss = finalSL;
      candidateSignal.tp1 = bufferedDynamicTp.tp1;
      candidateSignal.tp2 = bufferedDynamicTp.tp2;
      candidateSignal.realRR = bufferedDynamicTp.tp1Rr;
      candidateSignal.tp2Rr = bufferedDynamicTp.tp2Rr;

      if (slBuffer > maxBufferUsed) {
        maxBufferUsed = slBuffer;
      }
    }

    // Apply strict Risk Manager
    const riskEval = evaluateTradeRisk({
      balance: runningBalance,
      entry: candidateSignal.entry,
      stopLoss: candidateSignal.stopLoss,
      tp1: candidateSignal.tp1,
      tp2: candidateSignal.tp2,
      confidence: candidateSignal.confidence,
      losingStreak,
      asset: 'XAU/USD',
      brokerSpecs: {
        accountBalance: runningBalance,
        riskPercent: baseRiskPercent,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        minGoldSlPoints: minSlConfigured,
        maxGoldSlPoints: maxSlConfigured,
        minRr: request.brokerSpecs?.minRr ?? 1.5,
        maxLoss: request.brokerSpecs?.maxLoss ?? 5.5,
      },
    });

    if (!riskEval.valid || !riskEval.positionSizing.isExecutable) {
      if (
        riskEval.positionSizing &&
        riskEval.positionSizing.standardLotSize > 0 &&
        riskEval.positionSizing.standardLotSize < riskEval.positionSizing.minimumLot
      ) {
        rejectedByMinimumLotRisk += 1;
      }
      continue;
    }

    // Rule: Aggregate Daily Risk Max 30% (reject trade if dayRisk + proposed risk > 30%)
    if (Number((dayRisk + riskEval.riskPercent).toFixed(4)) > 30.0) {
      rejectedByDailyRiskLimit += 1;
      continue;
    }

    // Simulate Trade Outcome forward through subsequent candles
    const initialLot = riskEval.positionSizing.standardLotSize;
    const initialEntry = candidateSignal.entry;
    const initialRiskDollars = riskEval.riskAmount;
    const isBuy = candidateSignal.decision.includes('BUY');
    const isLimit = candidateSignal.decision.includes('LIMIT');
    let tradeFilled = !isLimit;
    let exitIndex = -1;
    let exitPrice = candidateSignal.entry;
    let exitReason: 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_EXPIRATION' | 'AMBIGUOUS_SAME_CANDLE' = 'TIME_EXPIRATION';
    let entryTimestamp = isLimit ? current5m.timestamp : evalTimestamp;

    // FEATURE 1: POSITION ADD-ON / PYRAMIDING TRACKING
    let addonUsed = false;
    let addonLot = 0;
    let addonEntry = 0;
    let addonRiskDollars = 0;
    let addonTimestamp = 0;

    // Look forward up to 100 candles (8+ hours)
    const maxLookForward = Math.min(candles5m.length, i + 100);

    for (let j = i + 1; j < maxLookForward; j++) {
      const futureBar = candles5m[j];

      // If pending limit, check if triggered
      if (!tradeFilled) {
        if (isBuy && futureBar.low <= candidateSignal.entry) {
          tradeFilled = true;
          entryTimestamp = futureBar.timestamp;
        } else if (!isBuy && futureBar.high >= candidateSignal.entry) {
          tradeFilled = true;
          entryTimestamp = futureBar.timestamp;
        } else {
          continue; // Pending still waiting
        }
      }

      // Check Stop Loss & Take Profits
      const touchedSl = isBuy
        ? futureBar.low <= candidateSignal.stopLoss
        : futureBar.high >= candidateSignal.stopLoss;
      const touchedTp1 = isBuy
        ? futureBar.high >= candidateSignal.tp1
        : futureBar.low <= candidateSignal.tp1;
      const touchedTp2 = isBuy
        ? futureBar.high >= candidateSignal.tp2
        : futureBar.low <= candidateSignal.tp2;

      // SAME-CANDLE CONFLICT HANDLING
      if (touchedSl && (touchedTp1 || touchedTp2)) {
        if (isBuy) {
          if (futureBar.open <= candidateSignal.stopLoss) {
            exitIndex = j;
            exitPrice = candidateSignal.stopLoss;
            exitReason = 'STOP_LOSS';
            break;
          } else if (futureBar.open >= candidateSignal.tp1) {
            exitIndex = j;
            exitPrice = candidateSignal.tp1;
            exitReason = 'TP1';
            break;
          } else if (futureBar.close < futureBar.open) {
            exitIndex = j;
            exitPrice = candidateSignal.stopLoss;
            exitReason = 'STOP_LOSS';
            break;
          } else {
            exitIndex = j;
            exitPrice = candidateSignal.stopLoss;
            exitReason = 'AMBIGUOUS_SAME_CANDLE';
            break;
          }
        } else {
          if (futureBar.open >= candidateSignal.stopLoss) {
            exitIndex = j;
            exitPrice = candidateSignal.stopLoss;
            exitReason = 'STOP_LOSS';
            break;
          } else if (futureBar.open <= candidateSignal.tp1) {
            exitIndex = j;
            exitPrice = candidateSignal.tp1;
            exitReason = 'TP1';
            break;
          } else if (futureBar.close > futureBar.open) {
            exitIndex = j;
            exitPrice = candidateSignal.stopLoss;
            exitReason = 'STOP_LOSS';
            break;
          } else {
            exitIndex = j;
            exitPrice = candidateSignal.stopLoss;
            exitReason = 'AMBIGUOUS_SAME_CANDLE';
            break;
          }
        }
      }

      // Normal single exit condition
      if (touchedSl) {
        exitIndex = j;
        exitPrice = candidateSignal.stopLoss;
        exitReason = 'STOP_LOSS';
        break;
      }
      if (touchedTp2) {
        exitIndex = j;
        exitPrice = candidateSignal.tp2;
        exitReason = 'TP2';
        break;
      }
      if (touchedTp1) {
        exitIndex = j;
        exitPrice = candidateSignal.tp1;
        exitReason = 'TP1';
        break;
      }

      // FEATURE 1: Check for optional add-on (only if position is filled and not exiting on this bar)
      if (!addonUsed && tradeFilled) {
        const isProfit = isBuy
          ? futureBar.close > initialEntry
          : futureBar.close < initialEntry;

        if (isProfit) {
          // Check fresh 5M confirmation according to existing strategy logic
          const prevBarJ = candles5m[j - 1] || futureBar;
          const isBullishRejJ =
            (futureBar.close > futureBar.open && futureBar.open - futureBar.low > (futureBar.high - futureBar.close) * 1.5) ||
            futureBar.close > prevBarJ.high;
          const isBearishRejJ =
            (futureBar.close < futureBar.open && futureBar.high - futureBar.open > (futureBar.close - futureBar.low) * 1.5) ||
            futureBar.close < prevBarJ.low;

          const freshConfirmation = isBuy ? isBullishRejJ : isBearishRejJ;

          if (freshConfirmation) {
            const proposedAddonLot = 0.01;
            const proposedAddonEntry = futureBar.close;
            const proposedAddonRiskDollars = Number((proposedAddonLot * Math.abs(proposedAddonEntry - candidateSignal.stopLoss) * 100).toFixed(4));
            const proposedCombinedRiskDollars = initialRiskDollars + proposedAddonRiskDollars;
            const proposedCombinedRiskPercent = Number(((proposedCombinedRiskDollars / runningBalance) * 100).toFixed(2));
            const allowedRiskPercent = losingStreak >= 2 ? baseRiskPercent / 2 : baseRiskPercent;

            const currentDateKey = new Date(current5m.timestamp).toISOString().slice(0, 10);
            const currentDayRisk = dailyRiskTaken[currentDateKey] || 0;
            const addonRiskPercent = Number(((proposedAddonRiskDollars / runningBalance) * 100).toFixed(2));

            if (
              proposedCombinedRiskPercent <= allowedRiskPercent + 0.0001 &&
              Number((currentDayRisk + addonRiskPercent).toFixed(4)) <= 30.0
            ) {
              addonUsed = true;
              addonLot = proposedAddonLot;
              addonEntry = proposedAddonEntry;
              addonRiskDollars = proposedAddonRiskDollars;
              addonTimestamp = futureBar.timestamp;
              tradesUsingAddonCount += 1;
              dailyRiskTaken[currentDateKey] = Number((currentDayRisk + addonRiskPercent).toFixed(4));
            } else {
              addonRejectedRiskCount += 1;
            }
          }
        }
      }
    }

    if (!tradeFilled || exitIndex === -1) {
      // Pending order expired or not closed within simulation window
      continue;
    }

    // Calculate P/L based on exact combined positions and their actual entry prices
    const exitBar = candles5m[exitIndex];

    let initialPl = 0;
    if (isBuy) {
      initialPl = initialLot * (exitPrice - initialEntry) * 100;
    } else {
      initialPl = initialLot * (initialEntry - exitPrice) * 100;
    }

    let addonPl = 0;
    if (addonUsed) {
      if (isBuy) {
        addonPl = addonLot * (exitPrice - addonEntry) * 100;
      } else {
        addonPl = addonLot * (addonEntry - exitPrice) * 100;
      }
    }

    const profitDollars = Number((initialPl + addonPl).toFixed(2));
    const combinedRiskDollars = Number((initialRiskDollars + addonRiskDollars).toFixed(4));
    const combinedLot = Number((initialLot + addonLot).toFixed(6));
    const finalAverageEntry = addonUsed
      ? Number((((initialLot * initialEntry) + (addonLot * addonEntry)) / combinedLot).toFixed(2))
      : initialEntry;

    let realizedR = 0;
    if (combinedRiskDollars > 0) {
      realizedR = Number((profitDollars / combinedRiskDollars).toFixed(2));
    }

    let tradeResult: 'WIN' | 'LOSS' | 'AMBIGUOUS' = 'LOSS';
    if (exitReason === 'TP1' || exitReason === 'TP2') {
      tradeResult = 'WIN';
    } else if (exitReason === 'AMBIGUOUS_SAME_CANDLE') {
      tradeResult = 'AMBIGUOUS';
    } else {
      tradeResult = 'LOSS';
    }

    const balanceBefore = runningBalance;
    runningBalance = Number(Math.max(0.1, balanceBefore + profitDollars).toFixed(2));
    sumBufferUsed += candidateSignal.slBuffer || 0;

    // Update drawdown
    if (runningBalance > peakBalance) {
      peakBalance = runningBalance;
    }
    const currentDd = peakBalance - runningBalance;
    const currentDdPct = (currentDd / peakBalance) * 100;
    if (currentDd > maxDrawdown) maxDrawdown = currentDd;
    if (currentDdPct > maxDrawdownPercent) maxDrawdownPercent = currentDdPct;

    // Update streak protection
    if (tradeResult === 'WIN') {
      winningStreak += 1;
      losingStreak = 0;
      if (winningStreak > maxConsecutiveWins) maxConsecutiveWins = winningStreak;
    } else {
      losingStreak += 1;
      winningStreak = 0;
      if (losingStreak > maxConsecutiveLosses) maxConsecutiveLosses = losingStreak;
    }

    // Update daily count and daily risk
    dailyTradeCounts[currentDateKey] = (dailyTradeCounts[currentDateKey] || 0) + 1;
    dailyRiskTaken[currentDateKey] = (dailyRiskTaken[currentDateKey] || 0) + riskEval.riskPercent;

    const durationMinutes = Math.round((exitBar.timestamp - entryTimestamp) / (60 * 1000));

    const tradeRecord: BacktestTrade = {
      id: `bt_${trades.length + 1}`,
      entryTime: new Date(entryTimestamp).toISOString().replace('T', ' ').slice(0, 16),
      exitTime: new Date(exitBar.timestamp).toISOString().replace('T', ' ').slice(0, 16),
      entryTimestamp,
      exitTimestamp: exitBar.timestamp,
      direction: isBuy ? 'BUY' : 'SELL',
      signalType: candidateSignal.decision,
      setup: candidateSignal.setup,
      entryPrice: candidateSignal.entry,
      exitPrice,
      stopLoss: candidateSignal.stopLoss,
      tp1: candidateSignal.tp1,
      tp2: candidateSignal.tp2,
      slPoints: riskEval.slPoints,
      tp1Points: riskEval.tp1Points,
      riskPercent: Number(((combinedRiskDollars / balanceBefore) * 100).toFixed(2)),
      riskAmount: combinedRiskDollars,
      lotSize: combinedLot,
      result: tradeResult,
      pl: profitDollars,
      balanceBefore,
      balanceAfter: runningBalance,
      rrRatio: candidateSignal.realRR,
      realRR: candidateSignal.realRR,
      plannedRR_TP1: candidateSignal.realRR,
      plannedRR_TP2: candidateSignal.tp2Rr,
      realizedR: Number(realizedR.toFixed(4)),
      exitReason,
      confidence: candidateSignal.confidence,
      durationMinutes,
      tpSelectionReason: candidateSignal.tpSelectionReason,
      structuralTargetUsed: candidateSignal.structuralTargetUsed,
      targetDistance: Number(Math.abs(candidateSignal.tp1 - candidateSignal.entry).toFixed(2)),
      slDistance: Number(Math.abs(candidateSignal.entry - candidateSignal.stopLoss).toFixed(2)),
      atrAtEntry: candidateSignal.atrAtEntry,
      passedVolatilitySanity: candidateSignal.passedVolatilitySanity,
      noFutureDataUsed: true,
      rawStructuralTarget: candidateSignal.rawStructuralTarget,
      targetSourceType: candidateSignal.targetSourceType,
      isModified: candidateSignal.isModified,
      modificationReason: candidateSignal.modificationReason,
      technicalSL: candidateSignal.technicalSL,
      finalSL: candidateSignal.stopLoss,
      slBuffer: candidateSignal.slBuffer,
      initialLot,
      addonLot: addonUsed ? addonLot : 0,
      initialEntry,
      addonEntry: addonUsed ? addonEntry : undefined,
      finalAverageEntry,
      combinedRisk: combinedRiskDollars,
      addonUsed,
    };

    trades.push(tradeRecord);
    equityCurve.push({
      time: tradeRecord.exitTime,
      timestamp: exitBar.timestamp,
      balance: runningBalance,
    });

    // Advance loop index to exitIndex to prevent duplicate trades inside the same active duration
    i = exitIndex;
  }

  // Calculate Aggregates
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.result === 'WIN').length;
  const losses = trades.filter((t) => t.result === 'LOSS').length;
  const ambiguousTrades = trades.filter((t) => t.result === 'AMBIGUOUS').length;
  const winRate = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
  const netProfit = Number((runningBalance - initialCapital).toFixed(2));
  const netProfitPercent = Number(((netProfit / initialCapital) * 100).toFixed(1));

  const totalWinDollars = trades.filter((t) => t.pl > 0).reduce((sum, t) => sum + t.pl, 0);
  const totalLossDollars = Math.abs(trades.filter((t) => t.pl < 0).reduce((sum, t) => sum + t.pl, 0));
  const profitFactor = totalLossDollars > 0 ? Number((totalWinDollars / totalLossDollars).toFixed(2)) : totalWinDollars > 0 ? 99.9 : 0;

  const largestWin = trades.length > 0 ? Math.max(0, ...trades.map((t) => t.pl)) : 0;
  const largestLoss = trades.length > 0 ? Math.min(0, ...trades.map((t) => t.pl)) : 0;
  const averageWin = wins > 0 ? Number((totalWinDollars / wins).toFixed(2)) : 0;
  const averageLoss = (losses + ambiguousTrades) > 0 ? Number((totalLossDollars / (losses + ambiguousTrades)).toFixed(2)) : 0;

  // Real R:R Distribution Statistics
  const allRRs = trades.map((t) => t.realizedR !== undefined ? t.realizedR : t.realRR).filter((r) => r > 0).sort((a, b) => a - b);
  const averageRR = allRRs.length > 0 ? Number((allRRs.reduce((a, b) => a + b, 0) / allRRs.length).toFixed(2)) : 0;
  const medianRR =
    allRRs.length === 0
      ? 0
      : allRRs.length % 2 === 1
      ? allRRs[Math.floor(allRRs.length / 2)]
      : Number(((allRRs[allRRs.length / 2 - 1] + allRRs[allRRs.length / 2]) / 2).toFixed(2));
  const maxRR = allRRs.length > 0 ? Math.max(...allRRs) : 0;
  const pctTradesRrAbove5 = totalTrades > 0 ? Number(((trades.filter((t) => (t.realizedR ?? t.realRR) > 5.0).length / totalTrades) * 100).toFixed(1)) : 0;
  const pctTradesRrAbove10 = totalTrades > 0 ? Number(((trades.filter((t) => (t.realizedR ?? t.realRR) > 10.0).length / totalTrades) * 100).toFixed(1)) : 0;

  const startDate = new Date(targetStartTime).toISOString().slice(0, 10);
  const endDate = new Date(endTimestamp).toISOString().slice(0, 10);

  return {
    runId,
    runTimestamp,
    initialCapital,
    finalBalance: runningBalance,
    netProfit,
    netProfitPercent,
    totalTrades,
    wins,
    losses,
    ambiguousTrades,
    winRate,
    profitFactor,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(1)),
    medianRR,
    averageRR,
    maxRR,
    pctTradesRrAbove5,
    pctTradesRrAbove10,
    noTradeCountSub2RR,
    rejectedByDailyRiskLimit,
    rejectedByMinimumLotRisk,
    tradesUsingAddon: tradesUsingAddonCount,
    addonRejectedRiskCount,
    maxDailyAggregateRisk: Object.values(dailyRiskTaken).length > 0 ? Number(Math.max(...Object.values(dailyRiskTaken)).toFixed(2)) : 0,
    maxActualPerTradeRisk: trades.length > 0 ? Number(Math.max(...trades.map((t) => (t.riskAmount / t.balanceBefore) * 100)).toFixed(2)) : 0,
    maxBufferUsed: Number(maxBufferUsed.toFixed(2)),
    avgBufferUsed: trades.length > 0 ? Number((sumBufferUsed / trades.length).toFixed(2)) : 0,
    dailyRiskTaken,
    largestWin,
    largestLoss,
    averageWin,
    averageLoss,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    dailyTradesDistribution: dailyTradeCounts,
    timeRange,
    candlesEvaluated: activeCandles5m.length,
    candlesCount1m: candles1m.length,
    candlesCount1h: activeCandles1h.length,
    candlesCount15m: activeCandles15m.length,
    candlesCount5m: activeCandles5m.length,
    startTimestamp: targetStartTime,
    endTimestamp,
    startDate,
    endDate,
    trades,
    equityCurve,
    validationReport: validation,
  };
}
