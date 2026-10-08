export type AssetType = 'XAU/USD' | 'BTC/USD';

export type StrategyFamily =
  | 'MARKET_STRUCTURE'
  | 'LIQUIDITY_SWEEP'
  | 'ORDER_BLOCK'
  | 'FVG_IMBALANCE'
  | 'FVG_REVERSAL'
  | 'MARKET_STRUCTURE_SHIFT'
  | 'RANGE_BREAKOUT'
  | 'FIBONACCI_OTE'
  | 'BREAK_AND_RETEST'
  | 'COUNTERTREND_SCALP'
  | 'FAILED_BREAKOUT'
  | 'RANGE_SFP_REVERSAL'
  | 'RANGE_BREAKOUT_EXPANSION'
  | 'DOUBLE_TOP_BOTTOM'
  | 'BARE_SR'
  | 'STRUCTURE_ENGULFING';

// ============================================================================
// PHASE 3 — TRADE QUALITY & EXECUTION INTELLIGENCE TYPES
// ============================================================================

export type PoiFreshnessState =
  | 'FRESH'
  | 'TESTED_ONCE'
  | 'TESTED_TWICE'
  | 'EXHAUSTED'
  | 'INVALIDATED';

export interface PoiRecord {
  id: string;
  type: 'ORDER_BLOCK' | 'FVG' | 'SFP_ZONE' | 'SWING_LEVEL' | 'DYNAMIC_MA';
  timeframe: '1H' | '15M' | '5M';
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  createdTimestamp: number;
  createdCandleTime?: number;
  lastTestedCandleTime?: number;
  tapCount: number;
  state: PoiFreshnessState;
  invalidationPrice?: number;
}

export type PullbackQuality = 'HEALTHY' | 'ACCEPTABLE' | 'WEAK' | 'INVALID';

export interface PullbackAssessment {
  quality: PullbackQuality;
  retracementDepth: number; // e.g. 0.50, 0.618
  speedRating: 'CONTROLLED' | 'FAST_IMPULSIVE' | 'STALLED';
  momentumContrast: 'CORRECTIVE' | 'COUNTER_IMPULSE' | 'NEUTRAL';
  candleCount: number;
  volumeBehavior: 'DECLINING_CORRECTIVE' | 'EXPANDING_COUNTER' | 'AVERAGE';
  reasons: string[];
}

export type EntryTiming = 'OPTIMAL' | 'ACCEPTABLE' | 'LATE' | 'CHASED';

export interface EntryTimingAssessment {
  timing: EntryTiming;
  distanceFromPoiAtr: number;
  displacementAtr: number;
  isChasing: boolean;
  timingPenalty: number; // 0 to 40
  reason: string;
}

export type PriceActionTriggerType =
  | 'REJECTION_WICK'
  | 'ENGULFING'
  | 'DISPLACEMENT_CANDLE'
  | 'MICRO_BOS'
  | 'MICRO_CHOCH'
  | 'PULLBACK_STRUCTURE_BREAK'
  | 'STRONG_EXPANSION_CLOSE';

export interface TriggerAssessment {
  hasTrigger: boolean;
  hasHardPriceActionTrigger: boolean;
  priceActionScore: number;
  primaryTrigger: PriceActionTriggerType | null;
  allTriggers: PriceActionTriggerType[];
  triggerTimeframe: string;
  triggerCandleTime?: number;
  rejectionRatio?: number;
  confirmationScore: number; // 0 to 30
  description: string;
}

export type TpPathRunway = 'CLEAR' | 'MINOR_OBSTACLE' | 'MAJOR_OBSTACLE' | 'BLOCKED';

export interface TpObstacle {
  type: string;
  price: number;
  distancePoints: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface TpPathAssessment {
  runway: TpPathRunway;
  clearRunwayRatio: number; // distanceToFirstObstacle / distanceToTp1
  obstacles: TpObstacle[];
  runwayScore: number; // 0 to 25
  description: string;
}

export interface LiquidityContextInfo {
  equalHighs: { price: number; touches: number; spread: number }[];
  equalLows: { price: number; touches: number; spread: number }[];
  recentSweptLevel?: { type: 'BSL' | 'SSL'; price: number; sweptBy: number; timestamp: number } | null;
  internalLiquidityTarget?: number;
  externalLiquidityTarget?: number;
  liquidityScoreBonus: number;
  summary: string;
}

export type CandidateLifecycleState =
  | 'IDENTIFIED'
  | 'WATCHING'
  | 'DEVELOPING'
  | 'READY'
  | 'TRIGGERED'
  | 'EXECUTABLE'
  | 'ENTERED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'INVALIDATED'
  | 'CLOSED'
  | 'EXPIRED'
  | 'NOT_ENTERED';

export interface CandidateLifecycleRecord {
  id: string;
  setupName: string;
  strategyFamily: string;
  direction: 'BUY' | 'SELL';
  timeframe: string;
  poiId?: string;
  state: CandidateLifecycleState;
  firstObservedTime: number;
  lastUpdatedTime: number;
  entryProposed: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  triggersDetected: string[];
  rejectionReason?: string;
  executionQualityScore?: number;
  strategyConfidence?: number;
}

export type NavigationTab =
  | 'dashboard'
  | 'scanner'
  | 'signals'
  | 'trades'
  | 'backtest'
  | 'risk'
  | 'analytics'
  | 'health'
  | 'settings';

export type SignalDecision = 'BUY NOW' | 'SELL NOW' | 'BUY LIMIT' | 'SELL LIMIT' | 'NO TRADE';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed?: boolean;
}

export type StructureEvent =
  | 'NONE'
  | 'BULLISH_BOS'
  | 'BEARISH_BOS'
  | 'BULLISH_CHOCH'
  | 'BEARISH_CHOCH'
  | 'BULLISH_MSS_SWEEP'
  | 'BEARISH_MSS_SWEEP';

export interface TechnicalIndicators {
  ema20: number;
  ema50: number;
  ema200: number;
  vwap: number;
  rsi14: number;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  };
  atr14: number;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  };
  swingHigh: number;
  swingLow: number;
  rollingHigh?: number;
  rollingLow?: number;
  structuralSwingHigh?: number;
  structuralSwingLow?: number;
  support: number;
  resistance: number;
  structure: 'BULLISH' | 'BEARISH' | 'RANGING';
  isTrending?: boolean;
  trendDirection?: string;
  structureShift?: string;
  structureEvent?: StructureEvent;
  trendStructure?: 'HH_HL' | 'LH_LL' | 'RANGING';
  chochDetected?: boolean;
  bosDetected?: boolean;
  mssDetected?: boolean;
  mssDirection?: 'BULLISH' | 'BEARISH';
  mssType?: string;
  liquidityLevels?: {
    buySideLiquidity: number; // Swing Highs pool
    sellSideLiquidity: number; // Swing Lows pool
  };
  orderBlock?: {
    type: 'BULLISH' | 'BEARISH';
    high: number;
    low: number;
  };
  orderBlocks?: Array<{
    type: 'BULLISH' | 'BEARISH';
    high: number;
    low: number;
    mitigated?: boolean;
    strength?: number;
    createdCandleIndex?: number;
  }>;
  fvg?: {
    type: 'BULLISH' | 'BEARISH';
    top: number;
    bottom: number;
  };
  fvgZones?: Array<{
    type: 'BULLISH' | 'BEARISH';
    top: number;
    bottom: number;
    mitigated?: boolean;
    createdCandleIndex?: number;
  }>;
  fractalSwings?: {
    highs: number[];
    lows: number[];
  };
  liquiditySweepDetected?: boolean;
  liquiditySweepDetails?: {
    sweptLevel: number;
    levelType: 'MACRO_SWING' | 'FRACTAL_SWING' | 'EQUAL_HIGHS_LOWS' | 'ASIAN_SESSION';
    direction: 'BULLISH' | 'BEARISH';
  };
  compressionState?: {
    isCompressed: boolean;
    squeezeRatio: number;
    expansionTriggered: boolean;
  };
  premiumDiscountZone?: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  marketRegime?:
    | 'STRONG_UPTREND'
    | 'WEAK_UPTREND'
    | 'STRONG_DOWNTREND'
    | 'WEAK_DOWNTREND'
    | 'NORMAL_RANGE'
    | 'VOLATILE_RANGE'
    | 'TRANSITION'
    | 'UNCLEAR';
  regimeContext?: {
    regime:
      | 'STRONG_UPTREND'
      | 'WEAK_UPTREND'
      | 'STRONG_DOWNTREND'
      | 'WEAK_DOWNTREND'
      | 'NORMAL_RANGE'
      | 'VOLATILE_RANGE'
      | 'TRANSITION'
      | 'UNCLEAR';
    trendStrength: number; // 0-100
    isOverextended: boolean; // Overextension flag
    overextensionReason?: string;
    volatilityRatio: number; // current ATR / avg ATR
    rangeBoundaries?: {
      high: number;
      low: number;
      equilibrium: number;
    };
    recommendedAction: 'TREND_CONTINUATION' | 'PULLBACK_WAIT' | 'RANGE_EDGES' | 'TRANSITION_CONFIRM' | 'NO_EDGE_WAIT';
    summaryDescription: string;
  };
}

export type CapitalSource = 'MANUAL' | 'MT5';

export interface MT5AccountInfo {
  connected: boolean;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  currency: string;
  server?: string;
  accountNumber?: string;
  lastUpdated?: number | null;
  statusMessage?: string;
}

export type AccountExecutionMode = 'DEMO' | 'REAL';

export interface AppSettings {
  capitalSource: CapitalSource;
  manualCapital: number;
  riskPerTrade: number;
  maxRiskPerTrade: number;
  minTp1RR: number;
  targetTp2RR: number;
  minimumConfidence: number;
  executionMode: AccountExecutionMode;
  accountMode: AccountExecutionMode;
  autoTradingEnabled: boolean;
  symbol: string;
  timeframes: string[];
  allowedSignalTypes: string[];
  contractSizeOz: number;
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
  minGoldSlPoints?: number;
  maxGoldSlPoints: number;
  maxLoss?: number; // User-configured maximum monetary loss limit in USD (e.g. $5.00)
  partialClosePercent?: number; // Configurable percentage to close at TP1 (e.g. 50%)
  enableTradeManagement?: boolean; // Enable Phase 4 continuous trade lifecycle management
  oppositeCooldownMinutes?: number; // Configurable cooldown minutes for opposite signals after trade close
  enableExperienceMemory?: boolean; // Enable feedback memory / historical experience learning
  aiProvider?: string; // Configured runtime AI provider (e.g., OPENAI, GEMINI, etc.)
  aiModel?: string; // Configured runtime AI model
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  capitalSource: 'MANUAL',
  manualCapital: 25.0,
  riskPerTrade: 18.0,
  maxRiskPerTrade: 30.0,
  minTp1RR: 1.5,
  targetTp2RR: 3.0,
  minimumConfidence: 75,
  executionMode: 'DEMO',
  accountMode: 'DEMO',
  autoTradingEnabled: false,
  symbol: 'XAUUSD',
  timeframes: ['1H', '15M', '5M', '1M'],
  allowedSignalTypes: ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'],
  contractSizeOz: 100,
  minimumLot: 0.01,
  maximumLot: 100,
  lotStep: 0.01,
  minGoldSlPoints: 35,
  maxGoldSlPoints: 85,
  maxLoss: 5.5,
  partialClosePercent: 50,
  enableTradeManagement: true,
  oppositeCooldownMinutes: 10,
  enableExperienceMemory: true,
};

export interface BrokerSettings {
  accountBalance: number;
  riskPercent: number; // 1.0 to 15.0
  contractSizeOz: number; // default 100 oz
  minimumLot: number; // default 0.01 standard lot
  maximumLot: number; // default 100 standard lot
  lotStep: number; // default 0.01
  minGoldSlPoints?: number; // default 35 points
  maxGoldSlPoints: number; // default 85 points
  minRr: number; // default 1.5
  maxLoss?: number;
  name?: string;
  accountNumber?: string;
  server?: string;
  minLot?: number;
}

export const DEFAULT_BROKER_SETTINGS: BrokerSettings = {
  accountBalance: 25,
  riskPercent: 15.0, // 15% risk rule for challenge account
  contractSizeOz: 100,
  minimumLot: 0.01,
  maximumLot: 100,
  lotStep: 0.01,
  minGoldSlPoints: 40,
  maxGoldSlPoints: 50,
  minRr: 1.5,
  maxLoss: 5.0,
};

export interface PositionSizingDetails {
  accountBalance: number;
  riskPercent: number;
  riskDollars: number;
  entryPrice: number;
  stopLossPrice: number;
  priceDistance: number;
  contractSizeOz: number;
  riskPerStandardLot: number;
  standardLotSize: number;
  miniLotSize: number;
  microLotSize: number;
  estimatedMaxLoss: number;
  maxLoss?: number;
  isExecutable: boolean;
  nonExecutableReason?: string;
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
}

export interface DuplicateDetails {
  duplicateReason: 'DUPLICATE_ACTIVE_REENTRY' | 'DUPLICATE_ACTIVE';
  activeSignalId: string;
  candidateSignalId: string;
  activeStrategyFamily: string;
  candidateStrategyFamily: string;
  samePoi: boolean;
  sameStructuralOrigin: boolean;
  sameTargetObjective: boolean;
  sameLifecycle: boolean;
  entryDistance: number;
}

export interface TradeSignal {
  id: string;
  setupId?: string; // Structural setup identity (distinct from event signal document id)
  timestamp: number;
  asset: AssetType;
  signal: SignalDecision;
  direction?: SignalDecision;
  currentPrice: number;
  entry: number;
  stopLoss: number;
  slPoints: number; // For XAU: difference / 0.10 (max 100 points = 10.0)
  tp1: number;
  tp1Points: number; // For XAU: abs(tp1 - entry) / 0.10
  tp1Rr?: number;
  tp1RrString?: string;
  tp2: number;
  tp2Points: number; // For XAU: abs(tp2 - entry) / 0.10
  tp2Rr?: number;
  tp2RrString?: string;
  primaryTarget?: 'TP1' | 'TP2';
  rr: string; // e.g., "TP1 (Primary): 1:1.50 | TP2: 1:2.99"
  rrRatio: number; // numeric value >= 1.5
  riskPercent: number; // 1% - 3%
  riskAmount: number; // $ based on current account balance
  potentialProfit: number; // $
  potentialLoss: number; // $
  recommendedLotSize: number; // Standard lot size
  standardLot?: number;
  miniLot?: number;
  microLot?: number;
  isExecutable?: boolean;
  nonExecutableReason?: string;
  positionSizing?: PositionSizingDetails;
  confidence: number; // 0 - 100
  strategyConfidence?: number; // 0 - 100 structural edge
  executionQualityScore?: number; // 0 - 100 operational execution quality
  strategyFamily?: StrategyFamily | string;
  duplicateReason?: string;
  duplicateDetails?: DuplicateDetails;
  structuralOrigin?: string;
  targetObjective?: number;
  entryTiming?: EntryTiming;
  timingWarning?: string;
  setupFreshness?: PoiFreshnessState;
  pullbackQuality?: PullbackQuality;
  tpRunway?: TpPathRunway;
  lifecycleState?: CandidateLifecycleState;
  poiId?: string;
  patternMetadata?: Record<string, any>;
  structuralAnchorKey?: string;
  setupKey?: string;
  triggers?: string[];
  executionBreakdown?: {
    timingScore: number;
    triggerScore: number;
    runwayScore: number;
    pullbackScore: number;
    freshnessScore: number;
    slScore: number;
  };
  liquidityContext?: string;
  actionTrigger?: string;
  timeframe: string; // "1H / 15M / 5M / 1M"
  setup: string; // Name of setup
  mainReasons: string[]; // 3 main reasons
  invalidation: string; // When the trade becomes invalid
  noTradeReason?: string; // Reason if NO TRADE
  aiAnalysisText?: string;
  factorSnapshot?: any; // Decision-time categorical factor snapshot for experience memory
}

export interface Reinforcement {
  id: string;
  timestamp: number;
  entry: number;
  lots: number;
  riskAmount: number;
}

export interface TradeLedgerItem {
  id: string;
  tradeNumber: number;
  date: string;
  isoTime?: string;
  asset: AssetType;
  direction: SignalDecision;
  entry: number;
  sl: number;
  slPoints?: number;
  tp1: number;
  tp1Points?: number;
  tp2: number;
  tp2Points?: number;
  rr: string;
  riskPercent: number;
  riskAmount: number;
  lotSize?: number;
  confidence: number;
  setup: string;
  result: 'OPEN' | 'WIN' | 'LOSS' | 'BREAK_EVEN' | 'CANCELLED' | 'VOID' | 'EXPIRED' | 'NOT_ENTERED';
  isActive?: boolean;
  pl: number; // Stored numeric P&L (realized if closed, 0 if open)
  realizedPnl?: number; // Authoritative realized P&L ($)
  balanceAfterTrade: number;
  exitPrice?: number;
  exitTime?: string;
  closedAt?: number;
  closeReason?: string;
  source?: 'MANUAL' | 'MT5' | 'SYSTEM';
  brokerDealId?: string;
  brokerOrderId?: string;
  theoreticalTp1Profit?: number;
  theoreticalTp2Profit?: number;
  notes?: string;
  signalId?: string;
  setupId?: string;
  isTest?: boolean;
  environment?: string;
  // Reinforcement/scale-in support
  reinforcements?: Reinforcement[];
  averageEntry?: number;
  totalRiskAmount?: number;
  // Phase 4 Trade Management fields
  managementState?: TradeManagementState;
  lastManagementAction?: ManagementActionType;
  lastManagementTimestamp?: number;
  partialClosed?: boolean;
  partialClosePercent?: number;
  tp1HitTimestamp?: number;
  reversalWatchTimestamp?: number;
  suggestedSL?: number;
  suggestedTP2?: number;
  notifiedStates?: string[];
}

export type TradeManagementState =
  | 'ACTIVE'
  | 'HOLD'
  | 'TP1_REACHED'
  | 'TP1_HIT'
  | 'TP1_APPROACHING'
  | 'BE_LOCKED'
  | 'PROTECT_PROFIT'
  | 'WEAKENING'
  | 'REVERSAL_WATCH'
  | 'REVERSAL_DEFENSE'
  | 'INVALIDATED'
  | 'EXIT_RECOMMENDED'
  | 'EARLY_EXIT'
  | 'TRAIL_STOP'
  | 'TARGET_EXTENSION'
  | 'REVERSE_CANDIDATE'
  | 'DATA_INCOMPLETE'
  | 'CLOSED';

export type ManagementActionType =
  | 'HOLD'
  | 'PARTIAL_CLOSE_TP1'
  | 'UPDATE_SL'
  | 'UPDATE_TP2'
  | 'REVERSAL_WATCH'
  | 'EARLY_EXIT'
  | 'REVERSE_POSITION';

export interface ManagementAction {
  actionType: ManagementActionType;
  tradeId: string;
  direction: 'BUY' | 'SELL';
  currentPrice: number;
  entryPrice: number;
  oldSL: number;
  newSL?: number;
  oldTP1: number;
  newTP1?: number;
  oldTP2?: number;
  newTP2?: number;
  partialClosePercent?: number;
  floatingPnl?: number;
  currentR?: number;
  managementState: TradeManagementState;
  reason: string;
  confidence: number;
  timestamp: number;
  source: 'DETERMINISTIC' | 'AI_REASONING' | 'HYBRID';
  requiresConfirmation: boolean;
  oppositeSetupCandidate?: {
    direction: 'BUY' | 'SELL';
    setupName: string;
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    confidence: number;
    score?: number;
  };
}

export interface AccountStats {
  currentBalance: number;
  startingBalance: number;
  totalPl: number;
  plPercent: number;
  drawdown: number;
  drawdownPercent: number;
  numberOfTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  winningStreak: number;
  losingStreak: number;
  averageRR: number;
  totalRiskTaken: number;
}

export interface ScannerConfig {
  enabled: boolean;
  isPaused?: boolean;
  status?: string;
  intervalSeconds: number; // 60 seconds
  intervalMinutes: number;
  minConfidence: number;
  lastScanTime: number | null;
  nextScanTime: number | null;
  lastScanStatus: string;
  dataStatus: string;
  lastDecision?: SignalDecision | null;
  lastSignal?: TradeSignal | null;
  isScanning: boolean;
  duplicatePrevented: boolean;
  activeSetupName?: string | null;
  scanCount: number;
}

export interface BacktestTradeItem {
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

export interface HistoricalDataValidationReport {
  provider: 'MT5_BRIDGE' | 'BIQUOTE';
  symbol: string;
  timeframe?: string;
  requestedPeriod: string;
  requestedStartTime: number;
  requestedEndTime: number;
  requestedStartDate: string;
  requestedEndDate: string;
  requestedCandles?: number;
  returnedCandles?: number;
  earliestTimestamp?: number;
  latestTimestamp?: number;
  actualEarliestCandleTime: number;
  actualLatestCandleTime: number;
  actualEarliestDate: string;
  actualLatestDate: string;
  candleCounts: {
    '5m': number;
    '15m': number;
    '1h': number;
    '1d'?: number;
  };
  gaps: {
    timeframe: string;
    gapStart: string;
    gapEnd: string;
    gapDurationHours: number;
    reason: string;
  }[];
  duplicatesCount: {
    '5m': number;
    '15m': number;
    '1h': number;
  };
  coverageRatio: number;
  coverage?: number;
  isFullCoverage: boolean;
  status: 'VALID' | 'INSUFFICIENT_DATA' | 'PARTIAL_DATA';
  message: string;
}

export interface BacktestResultData {
  runId?: string;
  runTimestamp?: number;
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
  candlesCount1h?: number;
  candlesCount15m?: number;
  candlesCount5m?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  startDate: string;
  endDate: string;
  trades: BacktestTradeItem[];
  equityCurve: { time: string; timestamp: number; balance: number }[];
  validationReport?: HistoricalDataValidationReport;
}

export interface TradeOpportunity {
  id: string; // Persistent unique setup key or structural cluster ID
  setupName: string;
  strategyFamily: string;
  direction: 'BUY' | 'SELL';
  timeframe: string;
  status: 'ACTIVE' | 'DISPATCHED' | 'FAILED' | 'COMPLETED' | 'NOT_ENTERED' | 'CANCELLED';
  firstObservedTime: number;
  lastUpdatedTime: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence: number;
  extremeLevel?: number;
  neckline?: number;
  patternAnchorKey?: string;
  pivot1Time?: number;
  pivot2Time?: number;
  poiId?: string;
  dispatchedAt?: number;
  failedAt?: number;
  completedAt?: number;
  signalId?: string;
  telegramRetryCount?: number;
  telegramNextRetryTime?: number;
  telegramDeliveryInFlight?: boolean;
  telegramDeliveryInFlightTime?: number;
  factorSnapshot?: any;
}


