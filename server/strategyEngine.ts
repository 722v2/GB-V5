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
  brokerSpecs?: BrokerContractSpecs;
  activeTradeDirection?: 'BUY' | 'SELL' | null;
  minConfidence?: number;
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
  selectedCandidate: SetupCandidate | null;
  allCandidates: SetupCandidate[];
  finalSignal: TradeSignal;
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

  const selected = mappedCandidates.length > 0 ? mappedCandidates[0] : null;

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
    confidence: selected ? selected.confidence : 0,
    timeframe: selected ? selected.timeframe : 'M1 / M5',
    setup: selected ? selected.setupName : 'No Setup',
    strategyFamily: selected ? selected.family : 'MARKET_STRUCTURE',
    mainReasons: selected ? selected.mainReasons : ['No candidate identified'],
    invalidation: selected ? selected.invalidation : 'N/A',
  };

  return {
    hasOpportunity: selected !== null,
    selectedCandidate: selected,
    allCandidates: mappedCandidates,
    finalSignal,
  };
}
