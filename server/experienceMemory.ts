/**
 * Trading Experience / Feedback Memory Engine
 * 
 * Surgical, isolated, additive feedback memory layer.
 * Learns: FACTORS -> COMBINATION -> OUTCOME (never price -> outcome).
 * 
 * Strict invariants:
 * 1. Factor snapshots are captured at final decision time using categorical factors only.
 * 2. Raw prices (entry, SL, TP1, TP2, current price) are strictly excluded from combination keys.
 * 3. Only completed outcomes whose completedAt < signal decision time are considered (no data leakage).
 * 4. Trades without snapshots are silently skipped (no historical backfill, no fabrication).
 * 5. Minimum sample size (MIN_SAMPLE_SIZE = 6) enforced before presenting statistical win rates.
 * 6. Completely advisory: cannot veto, force, or alter trading decisions, risk, or signals.
 * 7. Fail-safe: all operations fail open; any error never disrupts scanner, AI, or storage.
 */

import { TechnicalIndicators, TradeSignal, TradeLedgerItem, AppSettings } from '../src/types.js';
import { storage, TradeOutcomeRecord } from './storage.js';

export const MIN_SAMPLE_SIZE = 6;
export const MIN_SIMILARITY = 0.70;
export const MAX_PATTERNS_FOR_AI = 3;

export interface NormalizedFactors {
  setupFamily: string;
  direction: 'BUY' | 'SELL';
  htfStructure: 'UPTREND' | 'DOWNTREND' | 'RANGING';
  m15Structure: 'BULLISH' | 'BEARISH' | 'RANGING';
  marketRegime: 'STRONG_TREND' | 'NORMAL_RANGE' | 'VOLATILE' | 'TRANSITION' | 'UNCLEAR';
  liquidity: 'SWEEP_BUY_SIDE' | 'SWEEP_SELL_SIDE' | 'NONE';
  orderBlock: 'BULLISH_OB' | 'BEARISH_OB' | 'NONE';
  fvg: 'BULLISH_FVG' | 'BEARISH_FVG' | 'NONE';
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  rsi: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  macd: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volatility: 'HIGH' | 'NORMAL' | 'LOW';
}

export interface FactorSnapshot {
  signalId: string;
  setupFamily: string;
  direction: 'BUY' | 'SELL';
  factors: NormalizedFactors;
  combinationKey: string;
  createdAt: number;
}

export interface ExperienceRecord {
  id: string;
  signalId: string;
  tradeId?: string;
  combinationKey: string;
  factors: NormalizedFactors;
  direction: 'BUY' | 'SELL';
  setupFamily: string;
  outcome: 'WIN' | 'LOSS';
  realizedPnl: number;
  rr?: number;
  completedAt: number;
}

export interface ExperiencePattern {
  sampleSize: number;
  wins: number;
  losses: number;
  winRate: number; // e.g. 83.3 (%)
  avgRealizedPnl: number;
  avgRr?: number;
  matchType: 'EXACT' | 'PARTIAL';
  similarity: number; // 1.0 for exact, >= MIN_SIMILARITY for partial
  relevantCombination: Partial<NormalizedFactors>;
}

export interface HistoricalExperienceContext {
  sampleSize: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRealizedPnl: number;
  patterns: ExperiencePattern[];
  advisoryNote: string;
}

export class ExperienceMemoryEngine {
  // In-memory index: combinationKey -> ExperienceRecord[]
  private indexByCombination: Map<string, ExperienceRecord[]> = new Map();
  private isIndexInitialized = false;

  /**
   * Deterministically generates a canonical combinationKey from categorical factors.
   * Sorts factor keys alphabetically and guarantees no raw price fields participate.
   */
  public generateCombinationKey(factors: NormalizedFactors): string {
    const sortedKeys = Object.keys(factors).sort() as (keyof NormalizedFactors)[];
    return sortedKeys
      .map((k) => `${k}=${String(factors[k] || 'UNKNOWN')}`)
      .join('|');
  }

  /**
   * Normalizes raw indicators and setup parameters into discrete categorical factor buckets.
   * Strictly avoids any price levels or continuous floats in the factor representation.
   */
  public normalizeFactors(params: {
    direction: 'BUY' | 'SELL' | string;
    setupFamily?: string;
    indicators1h?: TechnicalIndicators;
    indicators15m?: TechnicalIndicators;
    indicators5m?: TechnicalIndicators;
  }): NormalizedFactors {
    const dir: 'BUY' | 'SELL' = String(params.direction).toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
    const ind1h = params.indicators1h;
    const ind15m = params.indicators15m;
    const ind5m = params.indicators5m;

    // 1. HTF Structure (1H)
    let htfStructure: 'UPTREND' | 'DOWNTREND' | 'RANGING' = 'RANGING';
    if (ind1h?.structure === 'BULLISH') htfStructure = 'UPTREND';
    else if (ind1h?.structure === 'BEARISH') htfStructure = 'DOWNTREND';

    // 2. M15 Structure
    let m15Structure: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
    if (ind15m?.structure === 'BULLISH') m15Structure = 'BULLISH';
    else if (ind15m?.structure === 'BEARISH') m15Structure = 'BEARISH';

    // 3. Market Regime (15M)
    let marketRegime: 'STRONG_TREND' | 'NORMAL_RANGE' | 'VOLATILE' | 'TRANSITION' | 'UNCLEAR' = 'UNCLEAR';
    const rawRegime = ind15m?.marketRegime || '';
    if (rawRegime.includes('STRONG_UPTREND') || rawRegime.includes('STRONG_DOWNTREND')) {
      marketRegime = 'STRONG_TREND';
    } else if (rawRegime.includes('NORMAL_RANGE')) {
      marketRegime = 'NORMAL_RANGE';
    } else if (rawRegime.includes('VOLATILE_RANGE')) {
      marketRegime = 'VOLATILE';
    } else if (rawRegime.includes('TRANSITION')) {
      marketRegime = 'TRANSITION';
    } else if (rawRegime.includes('WEAK_UPTREND') || rawRegime.includes('WEAK_DOWNTREND')) {
      marketRegime = 'STRONG_TREND';
    }

    // 4. Liquidity Sweep
    let liquidity: 'SWEEP_BUY_SIDE' | 'SWEEP_SELL_SIDE' | 'NONE' = 'NONE';
    if (ind15m?.liquiditySweepDetected) {
      liquidity = dir === 'BUY' ? 'SWEEP_SELL_SIDE' : 'SWEEP_BUY_SIDE';
    }

    // 5. Order Block
    let orderBlock: 'BULLISH_OB' | 'BEARISH_OB' | 'NONE' = 'NONE';
    if (ind15m?.orderBlock?.type === 'BULLISH') orderBlock = 'BULLISH_OB';
    else if (ind15m?.orderBlock?.type === 'BEARISH') orderBlock = 'BEARISH_OB';

    // 6. Fair Value Gap (FVG)
    let fvg: 'BULLISH_FVG' | 'BEARISH_FVG' | 'NONE' = 'NONE';
    if (ind15m?.fvg?.type === 'BULLISH') fvg = 'BULLISH_FVG';
    else if (ind15m?.fvg?.type === 'BEARISH') fvg = 'BEARISH_FVG';

    // 7. Premium / Discount Zone
    const zone = ind15m?.premiumDiscountZone || 'EQUILIBRIUM';

    // 8. RSI Categorical Bucket (5M)
    const rsiVal = ind5m?.rsi14 ?? 50;
    let rsi: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = 'NEUTRAL';
    if (rsiVal >= 70) rsi = 'OVERBOUGHT';
    else if (rsiVal <= 30) rsi = 'OVERSOLD';

    // 9. MACD Categorical Bucket (5M)
    let macd: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (ind5m?.macd) {
      if (ind5m.macd.histogram > 0.05) macd = 'BULLISH';
      else if (ind5m.macd.histogram < -0.05) macd = 'BEARISH';
    }

    // 10. Volatility Bucket (5M ATR ratio or ATR level)
    let volatility: 'HIGH' | 'NORMAL' | 'LOW' = 'NORMAL';
    const atr = ind5m?.atr14 ?? 1.5;
    if (atr > 3.0) volatility = 'HIGH';
    else if (atr < 0.8) volatility = 'LOW';

    // 11. Setup Family
    const setupFamily = params.setupFamily || 'PRICE_ACTION';

    return {
      setupFamily,
      direction: dir,
      htfStructure,
      m15Structure,
      marketRegime,
      liquidity,
      orderBlock,
      fvg,
      zone,
      rsi,
      macd,
      volatility,
    };
  }

  /**
   * Captures a normalized decision-time factor snapshot for a winning finalized signal.
   * Called once at final decision time before outcome is known.
   */
  public captureDecisionSnapshot(
    signal: TradeSignal,
    indicators1h?: TechnicalIndicators,
    indicators15m?: TechnicalIndicators,
    indicators5m?: TechnicalIndicators,
    targetStorage?: any
  ): FactorSnapshot | null {
    try {
      if (!this.isFeatureEnabled(targetStorage)) return null;
      if (!signal || !signal.id || signal.signal === 'NO TRADE') return null;

      const factors = this.normalizeFactors({
        direction: signal.signal,
        setupFamily: signal.strategyFamily || signal.setup || 'UNKNOWN',
        indicators1h,
        indicators15m,
        indicators5m,
      });

      const combinationKey = this.generateCombinationKey(factors);
      const snapshot: FactorSnapshot = {
        signalId: signal.id,
        setupFamily: factors.setupFamily,
        direction: factors.direction,
        factors,
        combinationKey,
        createdAt: signal.timestamp || Date.now(),
      };

      (targetStorage || storage).saveFactorSnapshot(snapshot);
      return snapshot;
      return snapshot;
    } catch (err) {
      console.warn('[ExperienceMemory] Error capturing decision snapshot (failing open):', err);
      return null;
    }
  }

  /**
   * Links a completed trade outcome (WIN / LOSS) to its decision-time factor snapshot.
   * If no snapshot exists, silently skips (no fabrication, no backfill).
   */
  public recordCompletedOutcome(
    snapshot: FactorSnapshot | null,
    outcomeRecord: TradeOutcomeRecord,
    trade?: TradeLedgerItem,
    targetStorage?: any
  ): ExperienceRecord | null {
    try {
      if (!this.isFeatureEnabled(targetStorage)) return null;
      if (!snapshot || !snapshot.combinationKey) {
        // No decision-time snapshot exists. Silently skip for learning.
        return null;
      }

      if (outcomeRecord.outcome !== 'WIN' && outcomeRecord.outcome !== 'LOSS') {
        return null;
      }

      const completedAt =
        outcomeRecord.closedAt ||
        outcomeRecord.timestamp ||
        (trade && trade.closedAt) ||
        Date.now();

      const expId = `exp_${snapshot.signalId}_${completedAt}`;
      const record: ExperienceRecord = {
        id: expId,
        signalId: snapshot.signalId,
        tradeId: outcomeRecord.tradeId || (trade && trade.id),
        combinationKey: snapshot.combinationKey,
        factors: snapshot.factors,
        direction: snapshot.direction,
        setupFamily: snapshot.setupFamily,
        outcome: outcomeRecord.outcome,
        realizedPnl: typeof outcomeRecord.realizedPnl === 'number' ? outcomeRecord.realizedPnl : outcomeRecord.pl || 0,
        rr: (trade as any)?.rrRatio || (trade?.tp1Points && trade?.slPoints ? Number((trade.tp1Points / trade.slPoints).toFixed(2)) : undefined),
        completedAt,
      };

      (targetStorage || storage).saveExperienceRecord(record);
      this.addRecordToIndex(record);

      console.log(
        `[ExperienceMemory] Recorded completed outcome for signal ${snapshot.signalId}: ${record.outcome} (${record.realizedPnl >= 0 ? '+' : ''}$${record.realizedPnl}) | Combination: ${record.combinationKey}`
      );
      return record;
    } catch (err) {
      console.warn('[ExperienceMemory] Error recording completed outcome (failing open):', err);
      return null;
    }
  }

  /**
   * Retrieves relevant historical experience for a prospective factor snapshot at decision time T.
   * STRICT DATA LEAKAGE PREVENTION:
   * Only includes records whose completedAt < decisionTime AND signalId !== currentSnapshot.signalId.
   */
  public getExperienceContext(
    snapshot: FactorSnapshot | { combinationKey: string; factors: NormalizedFactors; signalId?: string },
    decisionTime: number = Date.now(),
    targetStorage?: any
  ): HistoricalExperienceContext | null {
    try {
      if (!this.isFeatureEnabled(targetStorage)) return null;
      if (!snapshot || !snapshot.combinationKey || !snapshot.factors) return null;

      this.ensureIndex(targetStorage);

      const allRecords = (targetStorage || storage).getCompletedExperienceRecords();
      // Enforce strict completion time barrier and current-signal exclusion
      const eligibleRecords = allRecords.filter(
        (r) => r.completedAt < decisionTime && r.signalId !== (snapshot as any).signalId
      );

      if (eligibleRecords.length === 0) {
        return null;
      }

      // 1. Tier 1: Look for exact combinationKey matches
      const exactMatches = eligibleRecords.filter((r) => r.combinationKey === snapshot.combinationKey);

      let patterns: ExperiencePattern[] = [];

      if (exactMatches.length >= MIN_SAMPLE_SIZE) {
        const stats = this.calculateStatistics(exactMatches);
        patterns.push({
          ...stats,
          matchType: 'EXACT',
          similarity: 1.0,
          relevantCombination: snapshot.factors,
        });
      } else {
        // 2. Tier 2: Partial similarity match if exact matches are below MIN_SAMPLE_SIZE
        const partialMatches: { record: ExperienceRecord; similarity: number }[] = [];
        const snapshotKeys = Object.keys(snapshot.factors) as (keyof NormalizedFactors)[];
        const totalFactorsCount = snapshotKeys.length;

        for (const record of eligibleRecords) {
          if (record.combinationKey === snapshot.combinationKey) continue;
          let sharedCount = 0;
          for (const key of snapshotKeys) {
            if (record.factors && record.factors[key] === snapshot.factors[key]) {
              sharedCount++;
            }
          }
          const similarity = totalFactorsCount > 0 ? sharedCount / totalFactorsCount : 0;
          if (similarity >= MIN_SIMILARITY) {
            partialMatches.push({ record, similarity });
          }
        }

        // Sort partial matches by highest similarity first
        partialMatches.sort((a, b) => b.similarity - a.similarity);

        const combinedPool = [
          ...exactMatches,
          ...partialMatches.map((p) => p.record),
        ];

        // Only present if the combined sample reaches MIN_SAMPLE_SIZE
        if (combinedPool.length >= MIN_SAMPLE_SIZE) {
          const stats = this.calculateStatistics(combinedPool);
          const avgSim =
            combinedPool.length > 0
              ? Number(
                  (
                    (exactMatches.length * 1.0 +
                      partialMatches.reduce((acc, p) => acc + p.similarity, 0)) /
                    combinedPool.length
                  ).toFixed(2)
                )
              : 1.0;

          patterns.push({
            ...stats,
            matchType: exactMatches.length > 0 ? 'PARTIAL' : 'PARTIAL',
            similarity: avgSim,
            relevantCombination: {
              setupFamily: snapshot.factors.setupFamily,
              direction: snapshot.factors.direction,
              htfStructure: snapshot.factors.htfStructure,
              m15Structure: snapshot.factors.m15Structure,
              marketRegime: snapshot.factors.marketRegime,
              liquidity: snapshot.factors.liquidity,
              zone: snapshot.factors.zone,
            },
          });
        }
      }

      if (patterns.length === 0) {
        return null;
      }

      // Cap patterns to MAX_PATTERNS_FOR_AI (3)
      patterns = patterns.slice(0, MAX_PATTERNS_FOR_AI);

      const topPattern = patterns[0];
      return {
        sampleSize: topPattern.sampleSize,
        wins: topPattern.wins,
        losses: topPattern.losses,
        winRate: topPattern.winRate,
        avgRealizedPnl: topPattern.avgRealizedPnl,
        patterns,
        advisoryNote:
          'Historical experience is advisory only. Never override technical confluence or trade rules based solely on experience.',
      };
    } catch (err) {
      console.warn('[ExperienceMemory] Error retrieving experience context (failing open):', err);
      return null;
    }
  }

  /**
   * Helper to compute sample statistics from completed records.
   */
  private calculateStatistics(records: ExperienceRecord[]): {
    sampleSize: number;
    wins: number;
    losses: number;
    winRate: number;
    avgRealizedPnl: number;
    avgRr?: number;
  } {
    const sampleSize = records.length;
    const wins = records.filter((r) => r.outcome === 'WIN').length;
    const losses = records.filter((r) => r.outcome === 'LOSS').length;
    const winRate = sampleSize > 0 ? Number(((wins / sampleSize) * 100).toFixed(1)) : 0;

    const totalPnl = records.reduce((sum, r) => sum + (r.realizedPnl || 0), 0);
    const avgRealizedPnl = sampleSize > 0 ? Number((totalPnl / sampleSize).toFixed(2)) : 0;

    const recordsWithRr = records.filter((r) => typeof r.rr === 'number' && !isNaN(r.rr));
    const avgRr =
      recordsWithRr.length > 0
        ? Number((recordsWithRr.reduce((sum, r) => sum + (r.rr || 0), 0) / recordsWithRr.length).toFixed(2))
        : undefined;

    return {
      sampleSize,
      wins,
      losses,
      winRate,
      avgRealizedPnl,
      avgRr,
    };
  }

  /**
   * Rebuilds / maintains in-memory combinationKey index.
   */
  public ensureIndex(targetStorage?: any): void {
    if (this.isIndexInitialized) return;
    this.indexByCombination.clear();
    const records = (targetStorage || storage).getCompletedExperienceRecords();
    for (const r of records) {
      this.addRecordToIndex(r);
    }
    this.isIndexInitialized = true;
  }

  private addRecordToIndex(record: ExperienceRecord): void {
    if (!record.combinationKey) return;
    const list = this.indexByCombination.get(record.combinationKey) || [];
    list.push(record);
    this.indexByCombination.set(record.combinationKey, list);
  }

  /**
   * Checks if feature is enabled via AppSettings.
   */
  public isFeatureEnabled(targetStorage?: any): boolean {
    try {
      const settings = (targetStorage || storage).getSettings();
      return (settings as any).enableExperienceMemory !== false;
    } catch {
      return true;
    }
  }

  /**
   * Reset index for testing purposes.
   */
  public resetIndexForTesting(): void {
    this.indexByCombination.clear();
    this.isIndexInitialized = false;
  }
}

export const experienceMemoryEngine = new ExperienceMemoryEngine();

// Auto-hook into storage trade outcome events
storage.onOutcomeRecorded((record, trade) => {
  try {
    const snapshot =
      storage.getFactorSnapshot(record.signalId) ||
      (trade?.signalId ? storage.getFactorSnapshot(trade.signalId) : null) ||
      (trade?.id ? storage.getFactorSnapshot(trade.id) : null);

    if (snapshot) {
      experienceMemoryEngine.recordCompletedOutcome(snapshot, record, trade);
    }
  } catch (err) {
    console.warn('[ExperienceMemory] Error handling outcome event:', err);
  }
});
