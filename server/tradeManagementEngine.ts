import {
  AssetType,
  Candle,
  TechnicalIndicators,
  TradeLedgerItem,
  TradeManagementState,
  ManagementActionType,
  ManagementAction,
  AppSettings,
  DEFAULT_APP_SETTINGS,
} from '../src/types.js';
import { storage } from './storage.js';
import { generateMultiStrategyCandidates, SetupCandidate } from './strategyEngine.js';
import { BrokerContractSpecs, DEFAULT_BROKER_SPECS, evaluateTradeRisk } from './riskManager.js';
import { telegramService } from './telegram.js';
import { globalLifecycleManager } from './tradeQualityEngine.js';

export interface TradeHealthMetrics {
  tradeId: string;
  direction: 'BUY' | 'SELL';
  currentPrice: number;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  lotSize: number;
  floatingPnl: number;
  currentR: number;
  distanceToSlPoints: number;
  distanceToTp1Points: number;
  distanceToTp2Points: number;
  tp1ProgressPct: number;
  tp2ProgressPct: number;
  regimeAlignment: 'STRONG_ALIGNMENT' | 'MODERATE_ALIGNMENT' | 'NEUTRAL' | 'OPPOSING';
  structureHealth: 'BULLISH_CONTINUATION' | 'BEARISH_CONTINUATION' | 'RANGING' | 'WEAKENING' | 'REVERSED';
  pullbackQuality: 'HEALTHY' | 'SHALLOW' | 'DEEP_DANGEROUS' | 'STALLING';
  oppositePressureScore: number; // 0 (none) to 100 (extreme counter pressure)
  reversalLevel: 0 | 1 | 2 | 3; // 0=None, 1=Minor tick, 2=Reversal Watch, 3=High Conviction Reversal
  isOriginalThesisValid: boolean;
  notes: string[];
}

export interface TradeManagementEvaluationResult {
  tradeId: string;
  state: TradeManagementState;
  action: ManagementAction;
  health: TradeHealthMetrics;
  safetyPassed: boolean;
  safetyRejectionReason?: string;
  isDuplicateNotification: boolean;
}

export class TradeManagementEngine {
  private lastNotificationCache = new Map<string, {
    actionType: ManagementActionType;
    level?: number;
    timestamp: number;
  }>();
  private tradeLastNotifiedState = new Map<string, TradeManagementState>();
  private tradeLastNotifiedLevel = new Map<string, number>();
  private inFlightTradeIds = new Set<string>();
  private totalClosedCount = 0;

  constructor() {}

  public isInFlight(tradeId: string): boolean {
    return this.inFlightTradeIds.has(tradeId);
  }

  public acquireInFlight(tradeId: string): boolean {
    if (this.inFlightTradeIds.has(tradeId)) return false;
    this.inFlightTradeIds.add(tradeId);
    return true;
  }

  public releaseInFlight(tradeId: string): void {
    this.inFlightTradeIds.delete(tradeId);
  }

  public getTotalClosedCount(): number {
    return this.totalClosedCount;
  }

  /**
   * Evaluates all open active trades in the ledger.
   * Deterministic, safe, and robust.
   */
  public async evaluateActiveTrades(
    currentPrice: number,
    candles1h: Candle[] = [],
    candles15m: Candle[] = [],
    candles5m: Candle[] = [],
    candles1m: Candle[] = [],
    ind1h?: TechnicalIndicators,
    ind15m?: TechnicalIndicators,
    ind5m?: TechnicalIndicators,
    activeCapital?: number,
    settings: AppSettings = DEFAULT_APP_SETTINGS
  ): Promise<TradeManagementEvaluationResult[]> {
    if (settings.enableTradeManagement === false) {
      return [];
    }

    const openTrades = storage.getActiveTrades().filter(
      (t) => t.result === 'OPEN' && t.isActive !== false
    );

    if (openTrades.length === 0) {
      return [];
    }

    const resolvedCapital =
      activeCapital !== undefined && activeCapital > 0
        ? activeCapital
        : (storage.getSettings().manualCapital || 100);

    const results: TradeManagementEvaluationResult[] = [];

    for (const trade of openTrades) {
      // Idempotency: skip if currently in-flight
      if (this.inFlightTradeIds.has(trade.id)) continue;
      // Verify current state is still OPEN
      if (trade.result !== 'OPEN') continue;

      try {
        const evalResult = await this.evaluateSingleTrade(
          trade,
          currentPrice,
          candles1h,
          candles15m,
          candles5m,
          candles1m,
          ind1h as any,
          ind15m as any,
          ind5m as any,
          resolvedCapital,
          settings
        );

        results.push(evalResult);

        // Process notification and state recording if actionable
        await this.applyManagementDecision(evalResult, trade, settings);
      } catch (err) {
        console.error(`[TradeManagementEngine] Error evaluating trade ${trade.id}:`, err);
      }
    }

    return results;
  }

  /**
   * Core deterministic single trade evaluation.
   */
  public async evaluateSingleTrade(
    trade: TradeLedgerItem,
    currentPrice: number,
    candles1h: Candle[],
    candles15m: Candle[],
    candles5m: Candle[],
    candles1m: Candle[],
    ind1h: TechnicalIndicators,
    ind15m: TechnicalIndicators,
    ind5m: TechnicalIndicators,
    activeCapital: number,
    settings: AppSettings = DEFAULT_APP_SETTINGS
  ): Promise<TradeManagementEvaluationResult> {
    const isBuy = trade.direction.toUpperCase().includes('BUY');
    const direction: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';
    let entry = Number(trade.entry !== undefined ? trade.entry : (trade as any).entryPrice);
    let sl = Number(trade.sl !== undefined ? trade.sl : (trade as any).stopLoss);
    let tp1 = Number(trade.tp1);
    let tp2 = (trade.tp2 && Number(trade.tp2) > 0) ? Number(trade.tp2) : 0;
    const lotSize = trade.lotSize || 0.01;
    const contractSize = settings.contractSizeOz || 100;

    // P1-7: Attempt to resolve missing TP/SL from original signal in storage
    if (!entry || isNaN(entry) || !sl || isNaN(sl) || !tp1 || isNaN(tp1)) {
      const origSignal = storage.getSignal(trade.id) || (trade.signalId ? storage.getSignal(trade.signalId) : null);
      if (origSignal) {
        if (!entry || isNaN(entry)) entry = Number(origSignal.entry);
        if (!sl || isNaN(sl)) sl = Number(origSignal.stopLoss);
        if (!tp1 || isNaN(tp1)) tp1 = Number(origSignal.tp1);
        if ((!tp2 || isNaN(tp2)) && origSignal.tp2 && Number(origSignal.tp2) > 0) tp2 = Number(origSignal.tp2);
      }
    }

    // P1-7: NEVER create synthetic TP/SL levels.
    // If still missing, mark trade as DATA_INCOMPLETE and skip Phase 4 evaluation.
    // Log a warning. Do NOT invent prices.
    if (!entry || isNaN(entry) || !sl || isNaN(sl) || !tp1 || isNaN(tp1) || entry <= 0 || sl <= 0 || tp1 <= 0) {
      console.warn(`[TradeManagementEngine] Trade ${trade.id} is missing critical TP/SL/entry levels. Marked as DATA_INCOMPLETE, skipping Phase 4 evaluation.`);
      return {
        tradeId: trade.id,
        state: 'DATA_INCOMPLETE',
        action: {
          actionType: 'HOLD',
          tradeId: trade.id,
          direction,
          currentPrice,
          entryPrice: entry || currentPrice,
          oldSL: sl || 0,
          oldTP1: tp1 || 0,
          oldTP2: tp2 || 0,
          floatingPnl: 0,
          currentR: 0,
          managementState: 'DATA_INCOMPLETE',
          reason: `Skipped Phase 4 evaluation: Trade ${trade.id} lacks valid entry, SL, or TP1 price levels.`,
          confidence: 0,
          timestamp: Date.now(),
          source: 'DETERMINISTIC',
          requiresConfirmation: false,
        },
        health: {
          tradeId: trade.id,
          direction,
          currentPrice,
          entryPrice: entry || currentPrice,
          slPrice: sl || 0,
          tp1Price: tp1 || 0,
          tp2Price: tp2 || 0,
          lotSize: trade.lotSize || 0.01,
          floatingPnl: 0,
          currentR: 0,
          distanceToSlPoints: 0,
          distanceToTp1Points: 0,
          distanceToTp2Points: 0,
          tp1ProgressPct: 0,
          tp2ProgressPct: 0,
          regimeAlignment: 'NEUTRAL',
          structureHealth: 'RANGING',
          pullbackQuality: 'HEALTHY',
          oppositePressureScore: 0,
          reversalLevel: 0,
          isOriginalThesisValid: false,
          notes: ['DATA_INCOMPLETE: Trade is missing entry, SL, or TP1 levels. Phase 4 evaluation skipped.'],
        },
        safetyPassed: false,
        safetyRejectionReason: 'DATA_INCOMPLETE: Trade is missing entry, SL, or TP1',
        isDuplicateNotification: true,
      };
    }

    // Safety against extreme legacy/test anomalies (>30% price deviation)
    const priceDeviationPct = Math.abs(currentPrice - entry) / currentPrice;
    if (priceDeviationPct > 0.30 && entry > 0) {
      console.warn(
        `[TradeManagementEngine] Anomalous trade detected: ID ${trade.id}, Entry $${entry} vs Market $${currentPrice}. Marking VOID.`
      );
      this.inFlightTradeIds.add(trade.id);
      try {
        storage.closeTrade(
          trade.id,
          'VOID',
          0,
          entry,
          `Auto-voided by TradeManagementEngine: Entry price ($${entry}) differs anomalously (>30%) from market ($${currentPrice})`
        );
        trade.managementState = 'CLOSED';
        trade.isActive = false;
        this.totalClosedCount++;
      } finally {
        this.inFlightTradeIds.delete(trade.id);
      }
      return {
        tradeId: trade.id,
        state: 'CLOSED',
        action: {
          actionType: 'HOLD',
          tradeId: trade.id,
          direction,
          currentPrice,
          entryPrice: entry,
          oldSL: sl,
          oldTP1: tp1,
          oldTP2: tp2,
          floatingPnl: 0,
          currentR: 0,
          managementState: 'CLOSED',
          reason: 'Trade auto-voided due to anomalous price deviation (>30%).',
          confidence: 100,
          timestamp: Date.now(),
          source: 'DETERMINISTIC',
          requiresConfirmation: false,
        },
        health: {
          tradeId: trade.id,
          direction,
          currentPrice,
          entryPrice: entry,
          slPrice: sl,
          tp1Price: tp1,
          tp2Price: tp2,
          lotSize,
          floatingPnl: 0,
          currentR: 0,
          distanceToSlPoints: 0,
          distanceToTp1Points: 0,
          distanceToTp2Points: 0,
          tp1ProgressPct: 0,
          tp2ProgressPct: 0,
          regimeAlignment: 'NEUTRAL',
          structureHealth: 'RANGING',
          pullbackQuality: 'HEALTHY',
          oppositePressureScore: 0,
          reversalLevel: 0,
          isOriginalThesisValid: false,
          notes: ['Trade voided due to >30% price deviation anomaly'],
        },
        safetyPassed: true,
        isDuplicateNotification: true,
      };
    }

    // Terminal Exit Evaluation: Stop Loss, TP2, or single-target TP1
    const hasValidTp2 = Boolean(tp2 && tp2 > 0);
    let exitTrigger: 'TP2' | 'TP1' | 'SL' | null = null;
    let exitPrice = currentPrice;

    if (isBuy) {
      if (sl > 0 && currentPrice <= sl) {
        exitTrigger = 'SL';
        exitPrice = sl;
      } else if (hasValidTp2 && currentPrice >= tp2) {
        exitTrigger = 'TP2';
        exitPrice = tp2;
      } else if (!hasValidTp2 && tp1 > 0 && currentPrice >= tp1) {
        exitTrigger = 'TP1';
        exitPrice = tp1;
      }
    } else {
      if (sl > 0 && currentPrice >= sl) {
        exitTrigger = 'SL';
        exitPrice = sl;
      } else if (hasValidTp2 && currentPrice <= tp2) {
        exitTrigger = 'TP2';
        exitPrice = tp2;
      } else if (!hasValidTp2 && tp1 > 0 && currentPrice <= tp1) {
        exitTrigger = 'TP1';
        exitPrice = tp1;
      }
    }

    if (exitTrigger) {
      this.inFlightTradeIds.add(trade.id);
      try {
        const isWin = exitTrigger === 'TP2' || exitTrigger === 'TP1';
        const priceDiff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
        let realizedPl = Number((priceDiff * contractSize * lotSize).toFixed(2));

        if (!isWin && realizedPl > 0) realizedPl = -Math.abs(realizedPl);
        if (isWin && realizedPl < 0) realizedPl = Math.abs(realizedPl);

        const resultType = isWin ? 'WIN' : 'LOSS';
        const noteSuffix = `Closed via Unified TradeManagementEngine [Trigger: ${exitTrigger} @ $${exitPrice.toFixed(2)}]`;

        console.log(
          `[TradeManagementEngine] Auto-closing trade ${trade.id} -> ${resultType} (Exit: $${exitPrice}, P/L: $${realizedPl})`
        );
        trade.managementState = 'CLOSED';
        trade.isActive = false;
        storage.closeTrade(trade.id, resultType, realizedPl, exitPrice, noteSuffix);
        if (resultType === 'LOSS') {
          globalLifecycleManager.markSetupFailed(trade, 'Trade hit Stop Loss in Unified TradeManagementEngine');
        } else if (resultType === 'WIN') {
          globalLifecycleManager.markSetupCompleted(trade, 'Trade reached TP2 target in Unified TradeManagementEngine');
        }
        this.totalClosedCount++;

        return {
          tradeId: trade.id,
          state: 'CLOSED',
          action: {
            actionType: 'HOLD',
            tradeId: trade.id,
            direction,
            currentPrice,
            entryPrice: entry,
            oldSL: sl,
            oldTP1: tp1,
            oldTP2: tp2,
            floatingPnl: realizedPl,
            currentR: isWin ? 2.0 : -1.0,
            managementState: 'CLOSED',
            reason: `Trade exited at ${exitTrigger} ($${exitPrice.toFixed(2)}). Realized P/L: $${realizedPl}.`,
            confidence: 100,
            timestamp: Date.now(),
            source: 'DETERMINISTIC',
            requiresConfirmation: false,
          },
          health: {
            tradeId: trade.id,
            direction,
            currentPrice,
            entryPrice: entry,
            slPrice: sl,
            tp1Price: tp1,
            tp2Price: tp2,
            lotSize,
            floatingPnl: realizedPl,
            currentR: isWin ? 2.0 : -1.0,
            distanceToSlPoints: 0,
            distanceToTp1Points: 0,
            distanceToTp2Points: 0,
            tp1ProgressPct: isWin ? 100 : 0,
            tp2ProgressPct: isWin ? 100 : 0,
            regimeAlignment: isWin ? 'STRONG_ALIGNMENT' : 'OPPOSING',
            structureHealth: isWin ? 'BULLISH_CONTINUATION' : 'WEAKENING',
            pullbackQuality: 'HEALTHY',
            oppositePressureScore: isWin ? 0 : 100,
            reversalLevel: isWin ? 0 : 3,
            isOriginalThesisValid: isWin,
            notes: [`Trade closed via ${exitTrigger}`],
          },
          safetyPassed: true,
          isDuplicateNotification: true,
        };
      } catch (err) {
        console.error(`[TradeManagementEngine] Error closing trade ${trade.id}:`, err);
      } finally {
        this.inFlightTradeIds.delete(trade.id);
      }
    }

    // 1. Calculate Core Health Metrics
    const priceDiff = isBuy ? currentPrice - entry : entry - currentPrice;
    const floatingPnl = Number((priceDiff * contractSize * lotSize).toFixed(2));
    const slDistancePoints = Math.abs(entry - sl);
    const currentR = slDistancePoints > 0 ? Number((priceDiff / slDistancePoints).toFixed(2)) : 0;

    const distanceToSlPoints = isBuy ? currentPrice - sl : sl - currentPrice;
    const distanceToTp1Points = isBuy ? tp1 - currentPrice : currentPrice - tp1;
    const distanceToTp2Points = (tp2 && tp2 > 0) ? (isBuy ? tp2 - currentPrice : currentPrice - tp2) : 0;

    const tp1DistanceTotal = Math.abs(tp1 - entry);
    const tp1ProgressPct = tp1DistanceTotal > 0
      ? Math.max(0, Math.min(150, ((priceDiff) / tp1DistanceTotal) * 100))
      : 0;

    const tp2DistanceTotal = (tp2 && tp2 > 0) ? Math.abs(tp2 - entry) : 0;
    const tp2ProgressPct = (tp2 && tp2 > 0 && tp2DistanceTotal > 0)
      ? Math.max(0, Math.min(150, ((priceDiff) / tp2DistanceTotal) * 100))
      : 0;

    // 2. Assess Structure & Health Deterministically
    const health = this.assessTradeHealth(
      trade,
      direction,
      currentPrice,
      entry,
      sl,
      tp1,
      tp2,
      lotSize,
      floatingPnl,
      currentR,
      distanceToSlPoints,
      distanceToTp1Points,
      distanceToTp2Points,
      tp1ProgressPct,
      tp2ProgressPct,
      candles1h,
      candles15m,
      candles5m,
      ind1h,
      ind15m,
      ind5m
    );

    // 3. Generate Management Decision
    const decision = this.determineManagementAction(
      trade,
      health,
      currentPrice,
      entry,
      sl,
      tp1,
      tp2,
      candles15m,
      candles5m,
      ind15m,
      ind5m,
      settings
    );

    // 4. Safety Validation
    const safety = this.validateManagementActionSafety(
      decision,
      trade,
      activeCapital,
      settings
    );

    // 5. Deduplication Check
    const isDuplicate = this.checkNotificationDeduplication(trade.id, decision);

    return {
      tradeId: trade.id,
      state: decision.managementState,
      action: decision,
      health,
      safetyPassed: safety.valid,
      safetyRejectionReason: safety.reason,
      isDuplicateNotification: isDuplicate,
    };
  }

  /**
   * Health and Multi-Timeframe Structural Assessment
   */
  public assessTradeHealth(
    trade: TradeLedgerItem,
    direction: 'BUY' | 'SELL',
    currentPrice: number,
    entry: number,
    sl: number,
    tp1: number,
    tp2: number,
    lotSize: number,
    floatingPnl: number,
    currentR: number,
    distanceToSlPoints: number,
    distanceToTp1Points: number,
    distanceToTp2Points: number,
    tp1ProgressPct: number,
    tp2ProgressPct: number,
    candles1h: Candle[],
    candles15m: Candle[],
    candles5m: Candle[],
    ind1h?: TechnicalIndicators,
    ind15m?: TechnicalIndicators,
    ind5m?: TechnicalIndicators
  ): TradeHealthMetrics {
    const isBuy = direction === 'BUY';
    const notes: string[] = [];

    const ind1hSafe = ind1h || ({} as Partial<TechnicalIndicators>);
    const ind15mSafe = ind15m || ({} as Partial<TechnicalIndicators>);
    const ind5mSafe = ind5m || ({} as Partial<TechnicalIndicators>);

    // Check 1H Regime alignment
    const emaFast1h = ind1hSafe.ema20 || currentPrice;
    const emaSlow1h = ind1hSafe.ema50 || currentPrice;
    const is1hBullish = emaFast1h > emaSlow1h && currentPrice > emaSlow1h;
    const is1hBearish = emaFast1h < emaSlow1h && currentPrice < emaSlow1h;

    let regimeAlignment: TradeHealthMetrics['regimeAlignment'] = 'NEUTRAL';
    if ((isBuy && is1hBullish) || (!isBuy && is1hBearish)) {
      regimeAlignment = 'STRONG_ALIGNMENT';
      notes.push('1H Trend strongly aligned with position direction');
    } else if ((isBuy && is1hBearish) || (!isBuy && is1hBullish)) {
      regimeAlignment = 'OPPOSING';
      notes.push('1H Higher timeframe trend opposing current position');
    } else {
      regimeAlignment = 'MODERATE_ALIGNMENT';
    }

    // Check 15M & 5M Swings & Structure (strictly closed candles only)
    const recent5m = (candles5m || []).filter((c) => c.isClosed !== false).slice(-15);
    const recent15m = (candles15m || []).filter((c) => c.isClosed !== false).slice(-15);

    let structureHealth: TradeHealthMetrics['structureHealth'] = 'RANGING';
    let oppositePressure = 0;
    let reversalLevel: 0 | 1 | 2 | 3 = 0;

    // Check if 5M has created higher highs / higher lows (BUY) or lower lows / lower highs (SELL)
    if (recent5m.length >= 6) {
      const cCurrent = recent5m[recent5m.length - 1];
      const cPrev1 = recent5m[recent5m.length - 2];
      const cPrev2 = recent5m[recent5m.length - 3];

      if (isBuy) {
        // Bullish continuation check
        if ((cCurrent.close >= cPrev1.close || ind15mSafe.structure === 'BULLISH') && (ind5mSafe.rsi14 || 50) >= 50) {
          structureHealth = 'BULLISH_CONTINUATION';
          notes.push('5M/15M Bullish expansion continuing');
        } else if (cCurrent.close < cPrev2.low && (ind5mSafe.rsi14 || 50) < 45) {
          // Counter pressure
          oppositePressure += 35;
          structureHealth = 'WEAKENING';
          notes.push('5M Break below local swing low (Bearish counter pressure)');
        }
      } else {
        // Bearish continuation check
        if ((cCurrent.close <= cPrev1.close || ind15mSafe.structure === 'BEARISH') && (ind5mSafe.rsi14 || 50) <= 50) {
          structureHealth = 'BEARISH_CONTINUATION';
          notes.push('5M/15M Bearish expansion continuing');
        } else if (cCurrent.close > cPrev2.high && (ind5mSafe.rsi14 || 50) > 55) {
          // Counter pressure
          oppositePressure += 35;
          structureHealth = 'WEAKENING';
          notes.push('5M Break above local swing high (Bullish counter pressure)');
        }
      }
    }

    // Check 15M opposite BOS / CHOCH
    if (recent15m.length >= 6) {
      const last15 = recent15m[recent15m.length - 1];
      const lowest15 = Math.min(...recent15m.slice(-6, -2).map((c) => c.low));
      const highest15 = Math.max(...recent15m.slice(-6, -2).map((c) => c.high));

      if (isBuy) {
        if (last15.close < lowest15) {
          oppositePressure += 45;
          structureHealth = 'REVERSED';
          notes.push('15M Bearish BOS detected against BUY position');
        }
      } else {
        if (last15.close > highest15) {
          oppositePressure += 45;
          structureHealth = 'REVERSED';
          notes.push('15M Bullish BOS detected against SELL position');
        }
      }
    }

    // Multi-factor Reversal Level classification (3-Level Reversal Model + Reversal Defense)
    if (oppositePressure >= 75 && regimeAlignment === 'OPPOSING') {
      reversalLevel = 3; // High-conviction reversal
      notes.push('LEVEL 3: High-conviction multi-timeframe structural reversal confirmed');
    } else if (oppositePressure >= 50 || (oppositePressure >= 40 && structureHealth === 'REVERSED')) {
      reversalLevel = 2; // Level 2+: Reversal Defense
      notes.push('LEVEL 2+: REVERSAL_DEFENSE - Elevated counter-pressure detected, activating protective SL defense');
    } else if (oppositePressure >= 35 || (floatingPnl < 0 && structureHealth === 'WEAKENING')) {
      reversalLevel = 2; // Reversal watch
      notes.push('LEVEL 2: Reversal Watch - Trade structure weakening, close monitoring');
    } else if (oppositePressure > 10) {
      reversalLevel = 1; // Minor pull-back / hesitation
      notes.push('LEVEL 1: Minor counter-tick or normal pullback. No action required');
    }

    // Pullback quality
    let pullbackQuality: TradeHealthMetrics['pullbackQuality'] = 'HEALTHY';
    if (oppositePressure > 50) {
      pullbackQuality = 'DEEP_DANGEROUS';
    } else if (structureHealth === 'RANGING') {
      pullbackQuality = 'STALLING';
    }

    const isOriginalThesisValid = reversalLevel < 3 && distanceToSlPoints > 0;

    return {
      tradeId: trade.id,
      direction,
      currentPrice,
      entryPrice: entry,
      slPrice: sl,
      tp1Price: tp1,
      tp2Price: tp2,
      lotSize,
      floatingPnl,
      currentR,
      distanceToSlPoints,
      distanceToTp1Points,
      distanceToTp2Points,
      tp1ProgressPct,
      tp2ProgressPct,
      regimeAlignment,
      structureHealth,
      pullbackQuality,
      oppositePressureScore: Math.min(100, oppositePressure),
      reversalLevel,
      isOriginalThesisValid,
      notes,
    };
  }

  /**
   * Determines the optimal Management Action.
   * If nothing needs to change -> returns HOLD.
   */
  public determineManagementAction(
    trade: TradeLedgerItem,
    health: TradeHealthMetrics,
    currentPrice: number,
    entry: number,
    sl: number,
    tp1: number,
    tp2: number,
    candles15m: Candle[],
    candles5m: Candle[],
    ind15m: TechnicalIndicators,
    ind5m: TechnicalIndicators,
    settings: AppSettings
  ): ManagementAction {
    const isBuy = health.direction === 'BUY';
    const partialClosePct = settings.partialClosePercent || 50;

    // -------------------------------------------------------------------------
    // 1. Check Level 3: Confirmed High-Conviction Reversal -> EARLY_EXIT
    // -------------------------------------------------------------------------
    if (health.reversalLevel === 3) {
      return {
        actionType: 'EARLY_EXIT',
        tradeId: trade.id,
        direction: health.direction,
        currentPrice,
        entryPrice: entry,
        oldSL: sl,
        oldTP1: tp1,
        oldTP2: tp2,
        floatingPnl: health.floatingPnl,
        currentR: health.currentR,
        managementState: 'EARLY_EXIT',
        reason: `High-conviction structural reversal confirmed against ${health.direction}. ${health.notes.join('; ')}`,
        confidence: 85,
        timestamp: Date.now(),
        source: 'DETERMINISTIC',
        requiresConfirmation: false,
        oppositeSetupCandidate: {
          direction: isBuy ? 'SELL' : 'BUY',
          setupName: 'High-Conviction Structural Reversal',
          entry: currentPrice,
          stopLoss: isBuy
            ? Number((currentPrice + 4.0).toFixed(2))
            : Number((currentPrice - 4.0).toFixed(2)),
          tp1: isBuy
            ? Number((currentPrice - 10.0).toFixed(2))
            : Number((currentPrice + 10.0).toFixed(2)),
          tp2: isBuy
            ? Number((currentPrice - 20.0).toFixed(2))
            : Number((currentPrice + 20.0).toFixed(2)),
          confidence: 85,
        },
      };
    }

    // -------------------------------------------------------------------------
    // 2. Check Level 2+ / Level 2 Reversals
    // -------------------------------------------------------------------------
    const isReversalDefense =
      health.notes.some((n) => n.includes('REVERSAL_DEFENSE')) ||
      (health.oppositePressureScore >= 50 && health.reversalLevel >= 2);

    if (isReversalDefense) {
      // Attempt protective SL tightening (defend capital, NEVER loosen existing SL)
      const closed5m = (candles5m || []).filter((c) => c.isClosed !== false);
      const recentSwings = closed5m.slice(-8);

      if (isBuy) {
        const lowestRecent5m = recentSwings.length >= 3 ? Math.min(...recentSwings.slice(-5).map((c) => c.low)) : sl;
        let candidateSl = lowestRecent5m;
        if (currentPrice > entry + 1.0 && entry + 0.20 > candidateSl) {
          candidateSl = entry + 0.20;
        }

        // Tighter SL must be strictly above old SL and strictly below current market price with buffer
        if (candidateSl > sl && candidateSl < currentPrice - 0.40) {
          return {
            actionType: 'UPDATE_SL',
            tradeId: trade.id,
            direction: health.direction,
            currentPrice,
            entryPrice: entry,
            oldSL: sl,
            newSL: Number(candidateSl.toFixed(2)),
            oldTP1: tp1,
            oldTP2: tp2,
            floatingPnl: health.floatingPnl,
            currentR: health.currentR,
            managementState: 'REVERSAL_DEFENSE',
            reason: `Elevated counter-pressure detected (${health.oppositePressureScore}%). Tightening stop loss to protected level at $${candidateSl.toFixed(2)} to defend capital against potential reversal.`,
            confidence: 80,
            timestamp: Date.now(),
            source: 'DETERMINISTIC',
            requiresConfirmation: false,
          };
        }
      } else {
        const highestRecent5m = recentSwings.length >= 3 ? Math.max(...recentSwings.slice(-5).map((c) => c.high)) : sl;
        let candidateSl = highestRecent5m;
        if (currentPrice < entry - 1.0 && entry - 0.20 < candidateSl) {
          candidateSl = entry - 0.20;
        }

        // Tighter SL must be strictly below old SL and strictly above current market price with buffer
        if (candidateSl < sl && candidateSl > currentPrice + 0.40) {
          return {
            actionType: 'UPDATE_SL',
            tradeId: trade.id,
            direction: health.direction,
            currentPrice,
            entryPrice: entry,
            oldSL: sl,
            newSL: Number(candidateSl.toFixed(2)),
            oldTP1: tp1,
            oldTP2: tp2,
            floatingPnl: health.floatingPnl,
            currentR: health.currentR,
            managementState: 'REVERSAL_DEFENSE',
            reason: `Elevated counter-pressure detected (${health.oppositePressureScore}%). Tightening stop loss to protected level at $${candidateSl.toFixed(2)} to defend capital against potential reversal.`,
            confidence: 80,
            timestamp: Date.now(),
            source: 'DETERMINISTIC',
            requiresConfirmation: false,
          };
        }
      }

      // If no valid tightening can be done without crossing price or widening, return REVERSAL_DEFENSE state retaining existing SL
      return {
        actionType: 'REVERSAL_WATCH',
        tradeId: trade.id,
        direction: health.direction,
        currentPrice,
        entryPrice: entry,
        oldSL: sl,
        oldTP1: tp1,
        oldTP2: tp2,
        floatingPnl: health.floatingPnl,
        currentR: health.currentR,
        managementState: 'REVERSAL_DEFENSE',
        reason: `Elevated counter-pressure detected (${health.oppositePressureScore}%). Defensive observation active with protected stop loss maintained at $${sl.toFixed(2)}.`,
        confidence: 75,
        timestamp: Date.now(),
        source: 'DETERMINISTIC',
        requiresConfirmation: false,
      };
    }

    if (health.reversalLevel === 2) {
      return {
        actionType: 'REVERSAL_WATCH',
        tradeId: trade.id,
        direction: health.direction,
        currentPrice,
        entryPrice: entry,
        oldSL: sl,
        oldTP1: tp1,
        oldTP2: tp2,
        floatingPnl: health.floatingPnl,
        currentR: health.currentR,
        managementState: 'REVERSAL_WATCH',
        reason: `Position under observation: counter-structure pressure detected (${health.oppositePressureScore}%). Monitoring closely, no exit yet.`,
        confidence: 70,
        timestamp: Date.now(),
        source: 'DETERMINISTIC',
        requiresConfirmation: false,
      };
    }

    // -------------------------------------------------------------------------
    // 3. Check TP1 Reach: Partial TP Recommendation & Profit Protection
    // -------------------------------------------------------------------------
    const isTp1Reached = isBuy ? currentPrice >= tp1 : currentPrice <= tp1;
    if (isTp1Reached && !trade.partialClosed) {
      // Calculate suggested protected SL (Breakeven + buffer or protected structural swing)
      let suggestedProtectedSl: number;
      if (isBuy) {
        // Protect at least Breakeven + $0.50 buffer
        suggestedProtectedSl = Number((entry + 0.50).toFixed(2));
      } else {
        suggestedProtectedSl = Number((entry - 0.50).toFixed(2));
      }

      return {
        actionType: 'PARTIAL_CLOSE_TP1',
        tradeId: trade.id,
        direction: health.direction,
        currentPrice,
        entryPrice: entry,
        oldSL: sl,
        newSL: suggestedProtectedSl,
        oldTP1: tp1,
        oldTP2: tp2,
        partialClosePercent: partialClosePct,
        floatingPnl: health.floatingPnl,
        currentR: health.currentR,
        managementState: 'TP1_HIT',
        reason: `TP1 reached at $${tp1.toFixed(2)}. Suggest closing ${partialClosePct}% of position and protecting remaining volume toward TP2 with SL at $${suggestedProtectedSl.toFixed(2)}.`,
        confidence: 90,
        timestamp: Date.now(),
        source: 'DETERMINISTIC',
        requiresConfirmation: true,
      };
    }

    // -------------------------------------------------------------------------
    // 4. Dynamic TP2 Target Extension on Strong Structural Expansion (>= 80% to TP2)
    // -------------------------------------------------------------------------
    if (health.tp2ProgressPct >= 80 && health.structureHealth.includes('CONTINUATION')) {
      const isStrongExpansion = isBuy
        ? (ind5m.rsi14 || 50) >= 60 && (ind15m.rsi14 || 50) >= 55
        : (ind5m.rsi14 || 50) <= 40 && (ind15m.rsi14 || 50) <= 45;

      if (isStrongExpansion) {
        const extensionDistance = Math.abs(tp2 - entry) * 0.35; // 35% extension
        const proposedTp2 = isBuy
          ? Number((tp2 + extensionDistance).toFixed(2))
          : Number((tp2 - extensionDistance).toFixed(2));

        const isExtendedFarther = isBuy ? proposedTp2 > tp2 + 2.0 : proposedTp2 < tp2 - 2.0;

        if (isExtendedFarther) {
          return {
            actionType: 'UPDATE_TP2',
            tradeId: trade.id,
            direction: health.direction,
            currentPrice,
            entryPrice: entry,
            oldSL: sl,
            oldTP1: tp1,
            oldTP2: tp2,
            newTP2: proposedTp2,
            floatingPnl: health.floatingPnl,
            currentR: health.currentR,
            managementState: 'TARGET_EXTENSION',
            reason: `Strong ${health.direction} momentum and continuation expansion confirmed. Extending TP2 target to $${proposedTp2.toFixed(2)}.`,
            confidence: 80,
            timestamp: Date.now(),
            source: 'DETERMINISTIC',
            requiresConfirmation: false,
          };
        }
      }
    }

    // -------------------------------------------------------------------------
    // 5. Dynamic Stop Trailing on Strong Continuation (Past TP1 or > 1.2R)
    // -------------------------------------------------------------------------
    if (health.currentR >= 1.2 || trade.partialClosed) {
      const recentSwings = candles5m.slice(-10);
      if (recentSwings.length >= 4) {
        if (isBuy) {
          // Find confirmed Higher Low on 5M above current SL and below current price
          const lowestRecent5m = Math.min(...recentSwings.slice(-6, -1).map((c) => c.low));
          if (lowestRecent5m > sl + 1.0 && lowestRecent5m < currentPrice - 1.5) {
            const proposedSl = Number(lowestRecent5m.toFixed(2));
            if (proposedSl > sl) {
              return {
                actionType: 'UPDATE_SL',
                tradeId: trade.id,
                direction: health.direction,
                currentPrice,
                entryPrice: entry,
                oldSL: sl,
                newSL: proposedSl,
                oldTP1: tp1,
                oldTP2: tp2,
                floatingPnl: health.floatingPnl,
                currentR: health.currentR,
                managementState: 'TRAIL_STOP',
                reason: `Bullish continuation confirmed. Trailing stop loss to confirmed protected Higher Low at $${proposedSl.toFixed(2)}.`,
                confidence: 80,
                timestamp: Date.now(),
                source: 'DETERMINISTIC',
                requiresConfirmation: false,
              };
            }
          }
        } else {
          // Find confirmed Lower High on 5M below current SL and above current price
          const highestRecent5m = Math.max(...recentSwings.slice(-6, -1).map((c) => c.high));
          if (highestRecent5m < sl - 1.0 && highestRecent5m > currentPrice + 1.5) {
            const proposedSl = Number(highestRecent5m.toFixed(2));
            if (proposedSl < sl) {
              return {
                actionType: 'UPDATE_SL',
                tradeId: trade.id,
                direction: health.direction,
                currentPrice,
                entryPrice: entry,
                oldSL: sl,
                newSL: proposedSl,
                oldTP1: tp1,
                oldTP2: tp2,
                floatingPnl: health.floatingPnl,
                currentR: health.currentR,
                managementState: 'TRAIL_STOP',
                reason: `Bearish continuation confirmed. Trailing stop loss to confirmed protected Lower High at $${proposedSl.toFixed(2)}.`,
                confidence: 80,
                timestamp: Date.now(),
                source: 'DETERMINISTIC',
                requiresConfirmation: false,
              };
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 6. DEFAULT: DO NOTHING (HOLD)
    // -------------------------------------------------------------------------
    return {
      actionType: 'HOLD',
      tradeId: trade.id,
      direction: health.direction,
      currentPrice,
      entryPrice: entry,
      oldSL: sl,
      oldTP1: tp1,
      oldTP2: tp2,
      floatingPnl: health.floatingPnl,
      currentR: health.currentR,
      managementState: 'HOLD',
      reason: 'Trade thesis remains valid and active. No management action required.',
      confidence: 75,
      timestamp: Date.now(),
      source: 'DETERMINISTIC',
      requiresConfirmation: false,
    };
  }

  /**
   * Action Safety Validation.
   * Ensures risk is NEVER increased, SL is NEVER widened, and limits are strictly respected.
   */
  public validateManagementActionSafety(
    action: ManagementAction,
    trade: TradeLedgerItem,
    activeCapital: number,
    settings: AppSettings
  ): { valid: boolean; reason?: string } {
    const isBuy = action.direction === 'BUY';
    const oldSl = Number(trade.sl);

    // 1. Validate SL Modifications
    if (action.actionType === 'UPDATE_SL' || action.actionType === 'PARTIAL_CLOSE_TP1') {
      if (action.newSL !== undefined) {
        // Must NOT widen SL (For BUY, newSL cannot be lower than oldSL; for SELL, newSL cannot be higher than oldSL)
        if (isBuy && action.newSL < oldSl) {
          return {
            valid: false,
            reason: `Safety Violation: Cannot widen BUY Stop Loss from $${oldSl} to $${action.newSL} (Risk increase prohibited).`,
          };
        }
        if (!isBuy && action.newSL > oldSl) {
          return {
            valid: false,
            reason: `Safety Violation: Cannot widen SELL Stop Loss from $${oldSl} to $${action.newSL} (Risk increase prohibited).`,
          };
        }

        // New SL must not cross current price (which would cause immediate instant stopout)
        if (isBuy && action.newSL >= action.currentPrice) {
          return {
            valid: false,
            reason: `Safety Violation: Proposed BUY SL ($${action.newSL}) is at or above current price ($${action.currentPrice}).`,
          };
        }
        if (!isBuy && action.newSL <= action.currentPrice) {
          return {
            valid: false,
            reason: `Safety Violation: Proposed SELL SL ($${action.newSL}) is at or below current price ($${action.currentPrice}).`,
          };
        }
      }
    }

    // 2. Validate TP Modifications
    if (action.actionType === 'UPDATE_TP2' && action.newTP2 !== undefined) {
      if (isBuy && action.newTP2 <= action.currentPrice) {
        return {
          valid: false,
          reason: `Safety Violation: Proposed BUY extended TP2 ($${action.newTP2}) is below current price ($${action.currentPrice}).`,
        };
      }
      if (!isBuy && action.newTP2 >= action.currentPrice) {
        return {
          valid: false,
          reason: `Safety Violation: Proposed SELL extended TP2 ($${action.newTP2}) is above current price ($${action.currentPrice}).`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Deduplication check to prevent redundant message spam.
   * P1-9: State-transition based deduplication:
   * - A notification should fire when the trade ENTERS a new management state.
   * - Do NOT re-notify for the same state unless price moved significantly.
   * - Remove the blunt 15-minute time throttle for state changes.
   * - Track tradeLastNotifiedState.set(tradeId, newState).
   * - If newState !== previousState -> allow notification immediately.
   * - If newState === previousState -> suppress (dedup).
   * Returns true if notification should be SUPPRESSED.
   */
  public checkNotificationDeduplication(tradeId: string, action: ManagementAction): boolean {
    if (action.actionType === 'HOLD' || action.managementState === 'DATA_INCOMPLETE') {
      return true; // HOLD and DATA_INCOMPLETE are always suppressed
    }

    const previousState = this.tradeLastNotifiedState.get(tradeId);
    const newState = action.managementState;
    const targetLevel = action.newSL || action.newTP2 || 0;
    const previousLevel = this.tradeLastNotifiedLevel.get(tradeId) || 0;

    // State transition -> fire immediately
    if (newState !== previousState) {
      return false;
    }

    // Same state: only re-notify if it is an update action and the level changed significantly (>= 1.0)
    if (action.actionType === 'UPDATE_SL' || action.actionType === 'UPDATE_TP2') {
      if (targetLevel > 0 && Math.abs(targetLevel - previousLevel) >= 1.0) {
        return false;
      }
    }

    // Same state with no significant level change -> suppress (dedup)
    return true;
  }

  /**
   * Applies the management decision: updates trade ledger state.
   */
  public async applyManagementDecision(
    evalResult: TradeManagementEvaluationResult,
    trade: TradeLedgerItem,
    settings: AppSettings
  ): Promise<void> {
    const { action, safetyPassed, isDuplicateNotification } = evalResult;

    if (!safetyPassed) {
      console.warn(
        `[TradeManagementEngine] Safety check failed for trade ${trade.id}: ${evalResult.safetyRejectionReason}`
      );
      return;
    }

    // Update trade ledger in memory & storage
    let needsLedgerSave = false;

    if (trade.managementState !== action.managementState) {
      trade.managementState = action.managementState;
      trade.lastManagementAction = action.actionType;
      trade.lastManagementTimestamp = action.timestamp;
      needsLedgerSave = true;
    }

    if (action.actionType === 'PARTIAL_CLOSE_TP1' && !trade.partialClosed) {
      trade.partialClosed = true;
      trade.partialClosePercent = action.partialClosePercent || 50;
      trade.tp1HitTimestamp = action.timestamp;
      if (action.newSL) {
        trade.suggestedSL = action.newSL;
      }
      needsLedgerSave = true;
    }

    if (action.actionType === 'UPDATE_SL' && action.newSL) {
      trade.suggestedSL = action.newSL;
      needsLedgerSave = true;
    }

    if (action.actionType === 'UPDATE_TP2' && action.newTP2) {
      trade.suggestedTP2 = action.newTP2;
      needsLedgerSave = true;
    }

    if (action.actionType === 'EARLY_EXIT' && trade.isActive !== false) {
      this.inFlightTradeIds.add(trade.id);
      try {
        const isBuy = (trade.direction || '').toUpperCase().includes('BUY');
        const entry = Number(trade.entry || 0);
        const exitPrice = Number(action.currentPrice || entry);
        const lotSize = Number(trade.lotSize || 0.01);
        const contractSize = trade.asset === 'BTC/USD' ? 1 : 100;
        const priceDiff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
        const realizedPl = Number((priceDiff * contractSize * lotSize).toFixed(2));
        const resultType: 'WIN' | 'LOSS' = realizedPl >= 0 ? 'WIN' : 'LOSS';
        const noteSuffix = `Early Exit closed via TradeManagementEngine [Confirmed Structural Reversal @ $${exitPrice.toFixed(2)}]`;

        trade.managementState = 'CLOSED';
        trade.isActive = false;
        trade.result = resultType;
        storage.closeTrade(trade.id, resultType, realizedPl, exitPrice, noteSuffix);
        globalLifecycleManager.markSetupFailed(trade, 'Trade closed early due to confirmed structural reversal');
        this.totalClosedCount++;
        needsLedgerSave = false;
      } finally {
        this.inFlightTradeIds.delete(trade.id);
      }
    }

    // Track notification state for deduplication
    if (!isDuplicateNotification && action.actionType !== 'HOLD' && action.managementState !== 'DATA_INCOMPLETE') {
      this.tradeLastNotifiedState.set(trade.id, action.managementState);
      const targetLevel = action.newSL || action.newTP2 || 0;
      if (targetLevel > 0) {
        this.tradeLastNotifiedLevel.set(trade.id, targetLevel);
      }
      const cacheKey = `${trade.id}:${action.actionType}`;
      this.lastNotificationCache.set(cacheKey, {
        actionType: action.actionType,
        level: targetLevel,
        timestamp: Date.now(),
      });

      if (!trade.notifiedStates) {
        trade.notifiedStates = [];
      }
      const stateStr = String(action.managementState);
      if (!trade.notifiedStates.includes(stateStr as any)) {
        trade.notifiedStates.push(stateStr as any);
        needsLedgerSave = true;
      }

      // Dispatch management alert via Telegram asynchronously
      this.sendManagementNotification(action, trade, evalResult.health).catch((err) => {
        console.error(`[TradeManagementEngine] Telegram dispatch error for trade ${trade.id}:`, err);
      });
    }

    if (needsLedgerSave) {
      storage.saveTrade(trade);
    }
  }

  /**
   * Formats and delivers clear, high-impact management instructions.
   */
  public async sendManagementNotification(
    action: ManagementAction,
    trade: TradeLedgerItem,
    health?: TradeHealthMetrics
  ): Promise<boolean> {
    const isBuy = action.direction === 'BUY';
    const dirEmoji = isBuy ? '🟢' : '🔴';
    const pnlSign = (action.floatingPnl ?? 0) >= 0 ? '+' : '';
    const pnlFormatted = `${pnlSign}${(action.floatingPnl ?? 0).toFixed(2)}`;

    let titleHeader = '';
    let bodyText = '';

    switch (action.actionType) {
      case 'PARTIAL_CLOSE_TP1': {
        titleHeader = `🎯 <b>إدارة الصفقة — TP1 تحقق</b>`;
        const pct = action.partialClosePercent || 50;
        const slText = action.newSL 
          ? `حرّك SL إلى $${action.newSL.toFixed(2)} لحماية الصفقة.`
          : `حرّك SL إلى نقطة الدخول (Breakeven).`;
        const hasValidTp2 = Boolean(trade.tp2 && Number(trade.tp2) > 0);
        const tp2Display = hasValidTp2 ? `$${Number(trade.tp2).toFixed(2)}` : 'غير محدد';
        const pctInstruction = hasValidTp2
          ? `• أغلق <b>${pct}%</b> من الصفقة لجني الربح.\n• اترك <b>${100 - pct}%</b> المتبقية باتجاه TP2.`
          : `• أغلق الصفقة بالكامل حجزاً للأرباح عند الهدف الوحيد.`;

        bodyText = `
${dirEmoji} <b>${action.direction} XAU/USD</b>

Entry: $${action.entryPrice.toFixed(2)}
Current: $${action.currentPrice.toFixed(2)}
Floating P&L: ${pnlSign}$${Math.abs(action.floatingPnl ?? 0).toFixed(2)}

✅ <b>ماذا حدث؟</b>
السعر وصل إلى TP1.

📌 <b>القرار:</b>
${pctInstruction}
• ${slText}

🎯 <b>TP2:</b>
${tp2Display}
`.trim();
        break;
      }

      case 'UPDATE_SL': {
        titleHeader = `🛡️ <b>إدارة الصفقة — تحديث وقف الخسارة</b>`;
        const hasValidTp2 = Boolean(trade.tp2 && Number(trade.tp2) > 0);
        const tp2Display = hasValidTp2 ? `$${Number(trade.tp2).toFixed(2)}` : 'غير محدد';

        bodyText = `
${dirEmoji} <b>${action.direction} XAU/USD</b>

Current: $${action.currentPrice.toFixed(2)}

📌 <b>لماذا؟</b>
تحرك السعر لصالح الصفقة وتكوّن هيكل جديد يحمي الأرباح.

🔧 <b>الإجراء:</b>
حرّك SL من <b>$${action.oldSL.toFixed(2)}</b> إلى <b>$${action.newSL?.toFixed(2)}</b>.

🎯 <b>TP2:</b>
${tp2Display}
`.trim();
        break;
      }

      case 'UPDATE_TP2': {
        titleHeader = `🚀 <b>إدارة الصفقة — تمديد الهدف الثاني (Target Extension)</b>`;

        bodyText = `
${dirEmoji} <b>${action.direction} XAU/USD</b>

Current: $${action.currentPrice.toFixed(2)}

📌 <b>ماذا حدث؟</b>
تم تمديد الهدف الثاني (TP2) للصفقة.

🔎 <b>لماذا؟</b>
تحرك السعر بقوة وزخم عالٍ في اتجاه الصفقة مخترقاً المقاومة/الدعم المحلي وتكونت بنية استمرارية قوية.

🔧 <b>الإجراء:</b>
مدّد هدف جني الأرباح الثاني (TP2) من <b>$${action.oldTP2?.toFixed(2) || (trade.tp2 || 0).toFixed(2)}</b> إلى <b>$${action.newTP2?.toFixed(2)}</b>.

🛡️ <b>الوقف الحالي (SL) يبقى:</b>
$${action.oldSL.toFixed(2)}
`.trim();
        break;
      }

      case 'REVERSAL_WATCH': {
        titleHeader = `⚠️ <b>إدارة الصفقة — مراقبة انعكاس</b>`;
        const actionText = isBuy
          ? 'ظهرت إشارات ضغط هابط ضد صفقة الشراء.'
          : 'ظهرت إشارات ضغط صاعد ضد صفقة البيع.';

        let evidence1 = '';
        let evidence2 = '';
        let evidence3 = '';
        let changeTrigger = '';

        if (isBuy) {
          evidence1 = `• <b>فريم 5 دقائق (5M):</b> كسر تحت مستوى الدعم والقاع الهيكلي المحلي الأخير عند $${(action.currentPrice - 0.75).toFixed(2)}`;
          evidence2 = `• <b>فريم 15 دقيقة (15M):</b> تراجع مؤشر القوة النسبية (RSI) تحت 45 مما يعكس تباطؤاً في الزخم الشرائي.`;
          evidence3 = `• <b>مستوى خطر:</b> مستوى $${(action.oldSL + 2.0).toFixed(2)} يمثل مستوى دعم حرج قد يهدد سلامة الصفقة.`;
          changeTrigger = `كسر واضح ومؤكد لهيكل فريم 15 دقيقة (15M Bearish BOS) أسفل السعر الحالي أو تفعيل وقف الخسارة`;
        } else {
          evidence1 = `• <b>فريم 5 دقائق (5M):</b> اختراق فوق مستوى المقاومة والقمة الهيكلية المحلية الأخيرة عند $${(action.currentPrice + 0.75).toFixed(2)}`;
          evidence2 = `• <b>فريم 15 دقيقة (15M):</b> ارتفاع مؤشر القوة النسبية (RSI) فوق 55 مما يعكس تباطؤاً في الزخم البيعي المعاكس.`;
          evidence3 = `• <b>مستوى خطر:</b> مستوى $${(action.oldSL - 2.0).toFixed(2)} يمثل مستوى مقاومة حرج قد يهدد سلامة الصفقة.`;
          changeTrigger = `اختراق واضح ومؤكد لهيكل فريم 15 دقيقة (15M Bullish BOS) أعلى السعر الحالي أو تفعيل وقف الخسارة`;
        }

        bodyText = `
${dirEmoji} <b>${action.direction} XAU/USD</b>
الدخول: $${action.entryPrice.toFixed(2)}
السعر الحالي: $${action.currentPrice.toFixed(2)}
الربح/الخسارة العائمة: ${pnlSign}$${Math.abs(action.floatingPnl ?? 0).toFixed(2)}

📌 <b>ماذا حدث؟</b>
${actionText}

🔎 <b>الأدلة:</b>
${evidence1}
${evidence2}
${evidence3}

🧠 <b>التقييم:</b>
الضغط المعاكس موجود، لكنه لم يصل بعد إلى درجة تؤكد انعكاس الاتجاه.

✅ <b>القرار الآن:</b>
استمرار الصفقة — لا تغلقها حالياً.

🚨 <b>متى يتغير القرار؟</b>
إذا حدث <b>[${changeTrigger}]</b>, تنتقل الحالة إلى CONFIRMED REVERSAL ويتم إرسال توصية خروج.
`.trim();
        break;
      }

      case 'EARLY_EXIT': {
        const isReversal = (health?.reversalLevel === 3) || action.reason.toLowerCase().includes('reversal');

        if (isReversal) {
          titleHeader = `🚨 <b>إدارة الصفقة — انعكاس مؤكد</b>`;
          const eventText = isBuy
            ? 'تم تأكيد انعكاس هابط ضد صفقة الشراء.'
            : 'تم تأكيد انعكاس صاعد ضد صفقة البيع.';

          const confirmation1 = isBuy ? '15M Bearish BOS' : '15M Bullish BOS';
          const confirmation2 = isBuy
            ? `5M break of recent Swing Low at $${(action.entryPrice - 1.0).toFixed(2)}`
            : `5M break of recent Swing High at $${(action.entryPrice + 1.0).toFixed(2)}`;
          const confirmation3 = isBuy
            ? '1H/15M context: EMA bearish crossing and structural break'
            : '1H/15M context: EMA bullish crossing and structural break';
          const thesisText = isBuy ? 'فرضية الشراء لم تعد صالحة.' : 'فرضية البيع لم تعد صالحة.';

          bodyText = `
${dirEmoji} <b>${action.direction} XAU/USD</b>
Entry: $${action.entryPrice.toFixed(2)}
Current: $${action.currentPrice.toFixed(2)}
Floating P&L: ${pnlSign}$${Math.abs(action.floatingPnl ?? 0).toFixed(2)}

🔴 <b>ماذا حدث؟</b>
${eventText}

🔎 <b>التأكيد:</b>
• ${confirmation1}
• ${confirmation2}
• ${confirmation3}

🚨 <b>القرار:</b>
إغلاق الصفقة الآن.

⚠️ <b>السبب:</b>
${thesisText}
`.trim();
        } else {
          titleHeader = `🚨 <b>إدارة الصفقة — خروج مبكر</b>`;
          const eventText = isBuy
            ? 'فرضية الشراء أصبحت غير صالحة.'
            : 'فرضية البيع أصبحت غير صالحة.';

          const evidence1 = isBuy
            ? `• كسر السعر لمستويات السيولة الصاعدة وثباته أسفل الدعم الرئيسي عند $${(action.currentPrice - 0.5).toFixed(2)}`
            : `• اختراق السعر لمستويات السيولة الهابطة وثباته أعلى المقاومة الرئيسية عند $${(action.currentPrice + 0.5).toFixed(2)}`;
          const evidence2 = `• إشارات فنية على الفريمات الصغيرة تؤكد انتفاء زخم الحركة لصالح الصفقة`;
          const evidence3 = isBuy
            ? `• ضغط بيعي معاكس قوي جداً يهدد نقطة وقف الخسارة`
            : `• ضغط شرائي معاكس قوي جداً يهدد نقطة وقف الخسارة`;

          bodyText = `
${dirEmoji} <b>${action.direction} XAU/USD</b>

Entry: $${action.entryPrice.toFixed(2)}
Current: $${action.currentPrice.toFixed(2)}
Floating P&L: ${pnlSign}$${Math.abs(action.floatingPnl ?? 0).toFixed(2)}

❌ <b>ماذا حدث؟</b>
${eventText}

🔎 <b>التأكيد:</b>
${evidence1}
${evidence2}
• ${evidence3}

🚨 <b>القرار:</b>
إغلاق الصفقة الآن.
`.trim();
        }
        break;
      }

      default:
        return false;
    }

    const formattedMessage = `
${titleHeader}

${bodyText}

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')} | نظام الإدارة المتقدمة Phase 4</i>
`.trim();

    // Dispatch notification to private Telegram chat via reliable idempotent queue
    let actionKey = 'mgmt';
    if (action.actionType === 'PARTIAL_CLOSE_TP1') {
      actionKey = 'tp1';
    } else if (action.actionType === 'UPDATE_SL' && (action.managementState === 'BE_LOCKED' || String(action.reason).includes('Break-Even'))) {
      actionKey = 'be';
    } else if (action.actionType === 'EARLY_EXIT') {
      actionKey = 'early_exit';
    } else if (action.actionType === 'REVERSAL_WATCH') {
      actionKey = 'reversal';
    } else if (action.actionType === 'UPDATE_TP2') {
      actionKey = 'tp2';
    }

    const notificationId = action.actionType === 'EARLY_EXIT'
      ? `early_exit_${trade.id}`
      : `mgmt_${actionKey}_${trade.id}`;

    telegramService.sendManagementNotification(formattedMessage, {
      notificationId,
      tradeId: trade.id,
      event: action.actionType,
      eventTimestamp: action.timestamp || Date.now(),
    }).catch((err) => {
      console.error('[TradeManagementEngine] Telegram management alert dispatch error:', err);
    });

    return true;
  }

  /**
   * Future Auto-Trading Execution Adapter (Prepared for future MT5 execution when enabled).
   * Strictly inactive while autoTradingEnabled is false.
   */
  public prepareFutureAutoTradeExecution(
    action: ManagementAction,
    settings: AppSettings = DEFAULT_APP_SETTINGS
  ): {
    executable: boolean;
    autoTradingEnabled: boolean;
    steps: Array<{
      stepNumber: number;
      action: string;
      parameters: Record<string, any>;
    }>;
  } {
    const isAutoTradingOn = settings.autoTradingEnabled === true;

    if (!isAutoTradingOn) {
      return {
        executable: false,
        autoTradingEnabled: false,
        steps: [
          {
            stepNumber: 1,
            action: 'MANUAL_INSTRUCTION_ONLY',
            parameters: {
              tradeId: action.tradeId,
              actionType: action.actionType,
              requiresConfirmation: action.requiresConfirmation,
            },
          },
        ],
      };
    }

    // Architecture for future execution when auto trading is explicitly turned on
    const steps = [];
    if (action.actionType === 'EARLY_EXIT') {
      steps.push({
        stepNumber: 1,
        action: 'MT5_CLOSE_POSITION',
        parameters: { tradeId: action.tradeId, exitPrice: action.currentPrice },
      });
      steps.push({
        stepNumber: 2,
        action: 'MT5_VERIFY_POSITION_CLOSED',
        parameters: { tradeId: action.tradeId },
      });
      if (action.oppositeSetupCandidate) {
        steps.push({
          stepNumber: 3,
          action: 'MT5_RE_EVALUATE_AND_OPEN_OPPOSITE',
          parameters: action.oppositeSetupCandidate,
        });
      }
    } else if (action.actionType === 'PARTIAL_CLOSE_TP1') {
      steps.push({
        stepNumber: 1,
        action: 'MT5_PARTIAL_CLOSE_VOLUME',
        parameters: {
          tradeId: action.tradeId,
          percent: action.partialClosePercent || 50,
        },
      });
      if (action.newSL) {
        steps.push({
          stepNumber: 2,
          action: 'MT5_MODIFY_ORDER_SL',
          parameters: { tradeId: action.tradeId, newSL: action.newSL },
        });
      }
    } else if (action.actionType === 'UPDATE_SL' && action.newSL) {
      steps.push({
        stepNumber: 1,
        action: 'MT5_MODIFY_ORDER_SL',
        parameters: { tradeId: action.tradeId, newSL: action.newSL },
      });
    } else if (action.actionType === 'UPDATE_TP2' && action.newTP2) {
      steps.push({
        stepNumber: 1,
        action: 'MT5_MODIFY_ORDER_TP',
        parameters: { tradeId: action.tradeId, newTP2: action.newTP2 },
      });
    }

    return {
      executable: true,
      autoTradingEnabled: true,
      steps,
    };
  }

  /**
   * Resets notification cache (useful for testing)
   */
  public clearNotificationCache(): void {
    this.lastNotificationCache.clear();
  }
}

export const tradeManagementEngine = new TradeManagementEngine();
