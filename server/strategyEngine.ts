import {
  AssetType,
  Candle,
  SignalDecision,
  TechnicalIndicators,
  TradeSignal,
  StrategyFamily,
} from '../src/types.js';
import { BrokerContractSpecs, DEFAULT_BROKER_SPECS } from './riskManager.js';
import {
  discoverGbv5Candidates,
  executeGbv5Brain,
  Gbv5BrainInput,
  Gbv5Candidate,
} from './gbv5Brain.js';

// ============================================================================
// GB-V5 STRATEGY ENGINE ADAPTER
// Exposes clean GB-V5 candidate discovery and execution pipeline.
// ZERO legacy S1–S13 logic.
// ============================================================================

export interface MultiStrategyEngineInput {
  asset?: AssetType;
  balance?: number;
  currentPrice: number;
  indicators1h: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators5m: TechnicalIndicators;
  candles1h?: Candle[];
  candles15m?: Candle[];
  candles5m: Candle[];
  candles1m?: Candle[];
  brokerSpecs?: Partial<BrokerContractSpecs> | BrokerContractSpecs;
  activeTradeDirection?: 'BUY' | 'SELL' | null;
  minConfidence?: number;
  currentSpread?: number;
  losingStreak?: number;
}

export interface SetupCandidate {
  family: StrategyFamily;
  strategyFamily?: StrategyFamily;
  setupName: string;
  direction: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  entry: number;
  entryPrice?: number;
  stopLoss: number;
  slPoints: number;
  tp1: number;
  tp1Points: number;
  tp1Rr: number;
  tp2: number;
  tp2Points: number;
  tp2Rr: number;
  confidence: number;
  score: number;
  strategyConfidence: number;
  executionQualityScore: number;
  entryTiming: 'OPTIMAL' | 'ACCEPTABLE' | 'LATE' | 'CHASED';
  setupFreshness: 'FRESH' | 'TESTED_ONCE' | 'TESTED_TWICE' | 'EXHAUSTED' | 'INVALIDATED';
  pullbackQuality: 'HEALTHY' | 'ACCEPTABLE' | 'WEAK' | 'INVALID';
  tpRunway: 'CLEAR' | 'OBSTACLE_AHEAD' | 'BLOCKED';
  lifecycleState: 'DISCOVERED' | 'QUALIFIED' | 'READY' | 'ACTIVE' | 'INVALIDATED';
  timeframe: string;
  mainReasons: string[];
  invalidation: string;
  supportingConfluences: string[];
  patternMetadata?: Record<string, any>;
  poiId?: string;
  rawScoreBreakdown?: {
    structureScore: number;
    liquidityScore: number;
    priceActionScore: number;
    locationScore: number;
    technicalScore: number;
  };
}

export interface MultiStrategyEngineResult {
  hasOpportunity: boolean;
  hasValidSignal?: boolean;
  selectedCandidate: SetupCandidate | null;
  allCandidates: SetupCandidate[];
  finalSignal: TradeSignal;
  noTradeReason?: string;
}

export function extractSessionExtremes(candles: Candle[]): {
  sessionHigh?: number;
  sessionLow?: number;
  asianHigh?: number;
  asianLow?: number;
  londonHigh?: number;
  londonLow?: number;
  nyHigh?: number;
  nyLow?: number;
} {
  if (!candles || candles.length === 0) return {};
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  return {
    sessionHigh: maxHigh,
    sessionLow: minLow,
    asianHigh: Math.max(...highs.slice(0, 15)),
    asianLow: Math.min(...lows.slice(0, 15)),
    londonHigh: maxHigh,
    londonLow: minLow,
    nyHigh: maxHigh,
    nyLow: minLow,
  };
}

/**
 * Computes candidate quality score matching executeGbv5Brain semantics:
 * confluenceScore * (tp1Rr >= 2.0 ? 1.1 : 1.0)
 */
export function computeCandidateQualityScore(candidate: SetupCandidate): number {
  const confluence = typeof candidate.score === 'number' ? candidate.score : 0;
  const rrMultiplier = (candidate.tp1Rr ?? 0) >= 2.0 ? 1.1 : 1.0;
  return confluence * rrMultiplier;
}

/**
 * Deterministically ranks candidates by quality:
 * 1. Ranking score: confluenceScore * (tp1Rr >= 2.0 ? 1.1 : 1.0)
 * 2. Quality fields tie-breaking:
 *    a. raw confidence
 *    b. tp1Rr
 *    c. tp2Rr
 *    d. raw confluence score
 * 3. Stable deterministic tie-breaker for identical metrics:
 *    a. strategyFamily / family
 *    b. setupName
 *    c. direction
 */
export function compareCandidatesByQuality(a: SetupCandidate, b: SetupCandidate): number {
  // 1. Primary GB-V5 ranking score: confluenceScore * (tp1Rr >= 2.0 ? 1.1 : 1.0)
  const scoreA = computeCandidateQualityScore(a);
  const scoreB = computeCandidateQualityScore(b);
  if (Math.abs(scoreB - scoreA) > 1e-6) {
    return scoreB - scoreA;
  }

  // 2. Tie-break: raw confidence (higher is better)
  const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (Math.abs(confDiff) > 1e-6) {
    return confDiff;
  }

  // 3. Tie-break: TP1 reward-to-risk ratio (higher is better)
  const tp1RrDiff = (b.tp1Rr ?? 0) - (a.tp1Rr ?? 0);
  if (Math.abs(tp1RrDiff) > 1e-6) {
    return tp1RrDiff;
  }

  // 4. Tie-break: TP2 reward-to-risk ratio (higher is better)
  const tp2RrDiff = (b.tp2Rr ?? 0) - (a.tp2Rr ?? 0);
  if (Math.abs(tp2RrDiff) > 1e-6) {
    return tp2RrDiff;
  }

  // 5. Tie-break: raw unweighted confluence score (higher is better)
  const rawScoreDiff = (b.score ?? 0) - (a.score ?? 0);
  if (Math.abs(rawScoreDiff) > 1e-6) {
    return rawScoreDiff;
  }

  // 6. Strict deterministic tie-breaker on stable strings
  const familyCmp = (a.family || '').localeCompare(b.family || '');
  if (familyCmp !== 0) return familyCmp;

  const nameCmp = (a.setupName || '').localeCompare(b.setupName || '');
  if (nameCmp !== 0) return nameCmp;

  return (a.direction || '').localeCompare(b.direction || '');
}

export function generateMultiStrategyCandidates(input: MultiStrategyEngineInput): MultiStrategyEngineResult {
  const brainInput: Gbv5BrainInput = {
    asset: (input.asset as AssetType) || 'XAU/USD',
    currentPrice: input.currentPrice,
    balance: input.balance || 100,
    candles1m: input.candles1m || [],
    candles5m: input.candles5m || [],
    candles15m: input.candles15m || [],
    candles1h: input.candles1h || [],
    indicators5m: input.indicators5m,
    indicators15m: input.indicators15m,
    indicators1h: input.indicators1h,
    brokerSpecs: input.brokerSpecs || DEFAULT_BROKER_SPECS,
    activeTradeDirection: input.activeTradeDirection || null,
    minConfidence: input.minConfidence || 70,
  };

  const { candidates } = discoverGbv5Candidates(brainInput);

  const mappedCandidates: SetupCandidate[] = candidates.map((c) => ({
    family: c.legacyFamilyAlias,
    strategyFamily: c.legacyFamilyAlias,
    setupName: c.setupName,
    direction: c.direction,
    orderType: c.orderType,
    entry: c.entry,
    entryPrice: c.entry,
    stopLoss: c.stopLoss,
    slPoints: c.slPoints,
    tp1: c.tp1,
    tp1Points: c.tp1Points,
    tp1Rr: c.tp1Rr,
    tp2: c.tp2,
    tp2Points: c.tp2Points,
    tp2Rr: c.tp2Rr,
    confidence: c.confidence,
    score: c.confluenceScore,
    strategyConfidence: c.confidence,
    executionQualityScore: c.confluenceScore,
    entryTiming: 'OPTIMAL',
    setupFreshness: 'FRESH',
    pullbackQuality: 'HEALTHY',
    tpRunway: 'CLEAR',
    lifecycleState: 'READY',
    timeframe: c.timeframe,
    mainReasons: c.mainReasons,
    invalidation: c.invalidation,
    supportingConfluences: c.supportingConfluences,
    patternMetadata: c.patternMetadata,
    rawScoreBreakdown: {
      structureScore: c.evidence.structure.evidenceScore,
      liquidityScore: c.evidence.liquidity.evidenceScore,
      priceActionScore: c.evidence.priceAction.rejectionQualityScore,
      locationScore: 10,
      technicalScore: c.evidence.macd.evidenceScore,
    },
  }));

  // Deterministically rank all discovered candidates by quality
  const rankedCandidates = [...mappedCandidates].sort(compareCandidatesByQuality);

  // Filter eligible candidates by minimum confidence & active trade direction
  const minConf = brainInput.minConfidence ?? 70;
  let eligibleCandidates = rankedCandidates.filter((c) => (c.confidence ?? 0) >= minConf);

  if (brainInput.activeTradeDirection) {
    eligibleCandidates = eligibleCandidates.filter((c) => c.direction === brainInput.activeTradeDirection);
  }

  // Strongest eligible candidate selected regardless of discovery order
  const selected = eligibleCandidates.length > 0 ? eligibleCandidates[0] : null;

  const finalSignal: TradeSignal = {
    id: `sig_${Date.now()}`,
    timestamp: Date.now(),
    asset: brainInput.asset,
    signal: selected ? (selected.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW') : 'NO TRADE',
    direction: selected ? (selected.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW') : 'NO TRADE',
    currentPrice: input.currentPrice,
    entry: selected ? selected.entry : input.currentPrice,
    stopLoss: selected ? selected.stopLoss : 0,
    slPoints: selected ? selected.slPoints : 0,
    tp1: selected ? selected.tp1 : 0,
    tp1Points: selected ? selected.tp1Points : 0,
    tp1Rr: selected ? selected.tp1Rr : 0,
    tp2: selected ? selected.tp2 : 0,
    tp2Points: selected ? selected.tp2Points : 0,
    tp2Rr: selected ? selected.tp2Rr : 0,
    rr: selected ? `1:${selected.tp1Rr.toFixed(2)}` : 'N/A',
    rrRatio: selected ? selected.tp1Rr : 0,
    riskPercent: 0,
    riskAmount: 0,
    potentialProfit: 0,
    potentialLoss: 0,
    recommendedLotSize: 0,
    confidence: selected ? selected.confidence : 0,
    strategyConfidence: selected ? selected.strategyConfidence : 0,
    executionQualityScore: selected ? selected.executionQualityScore : 0,
    confluenceScore: selected ? selected.score : undefined,
    timeframe: selected ? selected.timeframe : 'M1 / M5',
    setup: selected ? selected.setupName : 'No Setup',
    strategyFamily: selected ? (selected.strategyFamily || selected.family) : 'MARKET_STRUCTURE',
    mainReasons: selected ? selected.mainReasons : ['No candidate identified'],
    invalidation: selected ? selected.invalidation : 'N/A',
    supportingConfluences: selected ? selected.supportingConfluences : undefined,
    patternMetadata: selected ? selected.patternMetadata : undefined,
  };

  return {
    hasOpportunity: selected !== null,
    hasValidSignal: selected !== null,
    selectedCandidate: selected,
    allCandidates: mappedCandidates,
    finalSignal,
    noTradeReason: finalSignal.noTradeReason,
  };
}
